/**
 * Bookmark Buddy's background worker: sorts new bookmarks as they're saved.
 *
 *  - Saved loose in the Bookmarks bar (or Other bookmarks)? Buddy files it: duplicates go to "Maybe delete?",
 *    known sites follow their folder, everything else gets a quick look from Gemma.
 *  - Saved straight into a folder? Left alone. If it's one of Buddy's folders, Buddy learns from it.
 *  - Every auto-move shows a notification with an Undo button. Nothing is ever deleted.
 *  - If Gemma isn't available, the bookmark waits in "Needs a home" until you open Buddy.
 */
import { MAYBE, OTHER, domainOf, normalize } from "../src/app/bookmarks";
import { parseSort, rememberable, sortPrompt } from "../src/app/sorter";
import {
  AutoState,
  NEEDS_HOME,
  ensureFolder,
  loadAuto,
  saveAuto,
} from "../src/app/chrome-bookmarks";

declare const chrome: any;

const ours = new Set<string>(); // moves Buddy made itself, so onMoved doesn't "learn" from them
let importing = false;

// ---------- opening the app ----------
chrome.action.onClicked.addListener(() =>
  chrome.tabs.create({ url: "index.html" }),
);
chrome.runtime.onInstalled.addListener((d: any) => {
  if (d.reason === "install") chrome.tabs.create({ url: "index.html" });
});

// ---------- new bookmarks ----------
chrome.bookmarks.onImportBegan.addListener(() => (importing = true));
chrome.bookmarks.onImportEnded.addListener(() => (importing = false));

chrome.bookmarks.onCreated.addListener(async (id: string, node: any) => {
  if (importing || !node.url || !/^https?:\/\//i.test(node.url)) return;
  const auto = await loadAuto();
  if (!auto?.enabled || !auto.barId || (await busy())) return;

  const folderName = nameOf(auto, node.parentId);
  if (folderName) {
    await learn(auto, node.url, folderName);
    return;
  } // saved into one of Buddy's folders
  if (!(await isLoose(node.parentId))) return; // saved into the person's own folder

  const domain = domainOf(node.url);
  let target: string, why: string;
  if (await isDuplicate(id, node.url)) {
    target = MAYBE;
    why = "You already had this one, so it went to “Maybe delete?”.";
  } else if (rememberable(domain) && (auto.memory[domain]?.count ?? 0) >= 2) {
    target = auto.memory[domain].folder;
    why = `Other ${domain} bookmarks live there.`;
  } else {
    const pick = await askGemma(auto, node.title || node.url, domain);
    if (pick) {
      target = pick;
      why = "Gemma picked it.";
    } else {
      target = NEEDS_HOME;
      why = "Open Bookmark Buddy and it will find this a home.";
    }
  }

  const parentId = await ensureFolder(auto, target);
  ours.add(id);
  await chrome.bookmarks.move(id, { parentId });
  await notify(id, node, target, why);
});

// The person moved a bookmark into one of Buddy's folders themselves: learn from it.
chrome.bookmarks.onMoved.addListener(async (id: string, info: any) => {
  if (ours.delete(id) || info.parentId === info.oldParentId) return;
  const auto = await loadAuto();
  if (!auto?.enabled || (await busy())) return;
  const folderName = nameOf(auto, info.parentId);
  if (!folderName) return;
  const [node] = await chrome.bookmarks.get(id);
  if (node?.url) await learn(auto, node.url, folderName);
});

// ---------- notifications with Undo ----------
async function notify(id: string, node: any, folder: string, why: string) {
  const nid = `bb-${id}-${Date.now()}`;
  await chrome.storage.session.set({
    [nid]: {
      id,
      from: node.parentId,
      index: node.index,
      domain: domainOf(node.url),
    },
  });
  chrome.notifications.create(nid, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `🦥 Mochi filed this in “${folder}”`,
    message: `${(node.title || node.url).slice(0, 80)}\n${why}`,
    buttons: [{ title: "Undo" }],
    priority: 0,
  });
}

chrome.notifications.onButtonClicked.addListener(async (nid: string) => {
  const rec = (await chrome.storage.session.get(nid))[nid];
  if (!rec) return;
  ours.add(rec.id);
  try {
    await chrome.bookmarks.move(rec.id, {
      parentId: rec.from,
      index: rec.index,
    });
  } catch {
    /* it was deleted or moved again */
  }
  const auto = await loadAuto();
  if (auto?.memory[rec.domain]) {
    delete auto.memory[rec.domain];
    await saveAuto(auto);
  } // that guess was wrong; stop trusting it
  await chrome.storage.session.remove(nid);
  chrome.notifications.clear(nid);
});
chrome.notifications.onClosed.addListener((nid: string) =>
  chrome.storage.session.remove(nid),
);

// ---------- helpers ----------
const busy = async () =>
  !!(await chrome.storage.local.get("bb.applying"))["bb.applying"];

function nameOf(auto: AutoState, folderId: string): string | undefined {
  const hit = Object.entries(auto.folders).find(
    ([, fid]) => fid === folderId,
  )?.[0];
  return hit && hit !== NEEDS_HOME && hit !== MAYBE && hit !== OTHER
    ? hit
    : undefined;
}

/** Loose = straight in a top-level folder (Bookmarks bar, Other bookmarks, Mobile bookmarks). */
async function isLoose(parentId: string) {
  const [root] = await chrome.bookmarks.getTree();
  return (root.children ?? []).some((c: any) => c.id === parentId);
}

async function isDuplicate(id: string, url: string) {
  const key = normalize(url);
  const [root] = await chrome.bookmarks.getTree();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.url && n.id !== id && normalize(n.url) === key) return true;
    if (n.children) stack.push(...n.children);
  }
  return false;
}

async function learn(auto: AutoState, url: string, folder: string) {
  const d = domainOf(url);
  if (!rememberable(d)) return;
  auto.memory[d] = {
    folder,
    count: Math.max(
      2,
      auto.memory[d]?.folder === folder ? auto.memory[d].count + 1 : 2,
    ),
  };
  await saveAuto(auto);
}

async function askGemma(
  auto: AutoState,
  title: string,
  domain: string,
): Promise<string | null> {
  const folders = Object.keys(auto.folders).filter(
    (f) => f !== OTHER && f !== MAYBE && f !== NEEDS_HOME,
  );
  if (!auto.model || !folders.length) return null;
  try {
    await ensureOffscreen();
    const b = { id: 0, title, url: "", domain, oldPath: "", folder: "" };
    const r = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "classify",
      model: auto.model,
      prompt: sortPrompt([b], folders),
    });
    chrome.alarms.create("bb-close", { delayInMinutes: 3 });
    if (!r || r.error) {
      console.warn("Gemma unavailable:", r?.error);
      return null;
    }
    return parseSort(r.text, [b], folders)[0];
  } catch (e) {
    console.warn(e);
    return null;
  }
}

let creating: Promise<void> | null = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const open = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (open.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification:
        "Runs Gemma on this device (WebGPU) to pick a folder for a new bookmark.",
    })
    .finally(() => (creating = null));
  await creating;
}

// Close Gemma a few minutes after the last bookmark, to give the memory back.
chrome.alarms.onAlarm.addListener(async (a: any) => {
  if (a.name !== "bb-close") return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
});
