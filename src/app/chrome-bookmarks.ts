/**
 * Extension mode: read and reorganize the browser's real bookmarks with the chrome.bookmarks API.
 * Safety first: a snapshot of where everything lived is saved before anything moves, and undoTidy()
 * puts it all back. Bookmarks are only ever moved, never deleted.
 */
import { Bookmark, MAYBE, OTHER, domainOf, normalize } from "./bookmarks";
import { rememberable } from "./sorter";
import { SEP, labelOf, parentOf } from "./folders";

declare const chrome: any;

export const EXT =
  typeof chrome !== "undefined" && !!chrome?.bookmarks?.getTree;
export const NEEDS_HOME = "Needs a home";

interface Node {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: Node[];
  folderType?: string;
}
interface Place {
  id: string;
  parentId: string;
  index: number;
}
interface FolderRec {
  id: string;
  title: string;
  parentId: string;
  index: number;
  depth: number;
}
interface Gone extends Place {
  title: string;
  url: string;
}
export interface Snapshot {
  at: number;
  items: Place[];
  removed: FolderRec[];
  created: string[];
  deleted?: Gone[];
}
export interface AutoState {
  enabled: boolean;
  barId: string;
  folders: Record<string, string>; // folder name -> chrome folder id
  memory: Record<string, { folder: string; count: number }>; // domain -> folder
  model: string | null;
}

const get = async <T>(key: string): Promise<T | undefined> =>
  (await chrome.storage.local.get(key))[key];
const set = (key: string, value: unknown) =>
  chrome.storage.local.set({ [key]: value });

export const loadAuto = () => get<AutoState>("bb.auto");
export const saveAuto = (s: AutoState) => set("bb.auto", s);
export const loadSnapshot = () => get<Snapshot>("bb.undo");

/** The Bookmarks bar (Chrome/Edge mark it; fall back to the first root folder). */
function barOf(root: Node): Node {
  const tops = root.children ?? [];
  return tops.find((n) => n.folderType === "bookmarks-bar") ?? tops[0];
}

export async function readTree(): Promise<{
  list: Bookmark[];
  barId: string;
  skipped: number;
}> {
  const [root] = (await chrome.bookmarks.getTree()) as Node[];
  const list: Bookmark[] = [];
  let skipped = 0;
  const walk = (n: Node, path: string[]) => {
    for (const c of n.children ?? []) {
      if (c.url) {
        if (!/^https?:\/\//i.test(c.url)) {
          skipped++;
          continue;
        }
        list.push({
          id: list.length,
          chromeId: c.id,
          title: c.title || c.url,
          url: c.url,
          domain: domainOf(c.url),
          addDate: c.dateAdded
            ? String(Math.floor(c.dateAdded / 1000))
            : undefined,
          oldPath: path.join(" / "),
          folder: "",
        });
      } else {
        walk(c, [...path, c.title]);
      }
    }
  };
  walk(root, []);
  return { list, barId: barOf(root).id, skipped };
}

export interface ApplyResult {
  moved: number;
  folders: number;
  created: number;
  removedFolders: number;
  deleted: number;
}

/** Move every bookmark into its new folder in the Bookmarks bar, then clear out the empty old folders. */
export async function applyTidy(
  list: Bookmark[],
  folderNames: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<ApplyResult> {
  const [root] = (await chrome.bookmarks.getTree()) as Node[];
  const bar = barOf(root);
  const rootIds = new Set((root.children ?? []).map((n) => n.id));

  // 1. Snapshot: where every bookmark lives right now.
  const items: Place[] = [];
  const toDelete = new Set(
    list.filter((b) => b.deleted && b.chromeId).map((b) => b.chromeId!),
  );
  const deleted: Gone[] = [];
  const index = (n: Node) => {
    for (const c of n.children ?? []) {
      if (!c.url) {
        index(c);
        continue;
      }
      const place = { id: c.id, parentId: c.parentId!, index: c.index! };
      items.push(place);
      if (toDelete.has(c.id))
        deleted.push({ ...place, title: c.title, url: c.url }); // kept so Undo can bring it back
    }
  };
  index(root);
  const snap: Snapshot = {
    at: Date.now(),
    items,
    removed: [],
    created: [],
    deleted,
  };
  await set("bb.undo", snap);
  await set("bb.applying", true);

  try {
    // 2. Folders in the bar (reuse one with the same name if it's already there).
    const order = [
      ...folderNames.filter((f) => f !== OTHER && f !== MAYBE),
      OTHER,
      MAYBE,
    ];
    const keepList = list.filter((b) => !b.deleted);
    const used = new Set(keepList.map((b) => b.folder || OTHER));
    for (const f of [...used]) if (f.includes(SEP)) used.add(parentOf(f)); // a used subfolder needs its parent
    const ids: Record<string, string> = {};
    for (const name of order) {
      if (!used.has(name)) continue;
      const parentId = parentOf(name) ? ids[parentOf(name)] : bar.id;
      if (!parentId) continue;
      const siblings: Node[] =
        parentId === bar.id
          ? (bar.children ?? [])
          : await chrome.bookmarks.getChildren(parentId);
      const existing = siblings.find(
        (c) => !c.url && c.title.toLowerCase() === labelOf(name).toLowerCase(),
      );
      if (existing) {
        ids[name] = existing.id;
        continue;
      }
      const made = await chrome.bookmarks.create({
        parentId,
        title: labelOf(name),
      });
      ids[name] = made.id;
      snap.created.push(made.id);
    }
    await set("bb.undo", snap);

    // 3. Move each bookmark.
    let done = 0;
    for (const name of order) {
      for (const b of keepList.filter(
        (x) => (x.folder || OTHER) === name && x.chromeId,
      )) {
        await chrome.bookmarks.move(b.chromeId, { parentId: ids[name] });
        onProgress?.(++done, keepList.length);
      }
    }
    // 3b. Delete the bookmarks the person chose to delete (they're in the backup, so Undo restores them).
    let removedBookmarks = 0;
    for (const g of deleted) {
      try {
        await chrome.bookmarks.remove(g.id);
        removedBookmarks++;
      } catch {
        /* already gone */
      }
    }

    // 4. Remove old folders that are now empty (deepest first). Recorded so Undo can bring them back.
    const keep = new Set([...Object.values(ids), ...rootIds, root.id]);
    const [fresh] = (await chrome.bookmarks.getTree()) as Node[];
    const empties: FolderRec[] = [];
    const sweep = (n: Node, depth: number): boolean => {
      // returns true if n ends up empty
      let allEmpty = true;
      for (const c of n.children ?? []) {
        if (c.url) {
          allEmpty = false;
          continue;
        }
        const empty = sweep(c, depth + 1);
        if (empty && !keep.has(c.id))
          empties.push({
            id: c.id,
            title: c.title,
            parentId: c.parentId!,
            index: c.index!,
            depth,
          });
        else allEmpty = false;
      }
      return allEmpty;
    };
    sweep(fresh, 0);
    for (const f of empties) {
      try {
        await chrome.bookmarks.remove(f.id);
        snap.removed.push(f);
      } catch {
        /* not empty after all; leave it */
      }
    }
    await set("bb.undo", snap);

    // 5. Remember folders and which sites go where, for auto-sorting new bookmarks.
    const tally: Record<string, Record<string, number>> = {};
    for (const b of keepList) {
      const f = b.folder || OTHER;
      if (!rememberable(b.domain) || f === OTHER || f === MAYBE) continue;
      (tally[b.domain] ??= {})[f] = (tally[b.domain][f] ?? 0) + 1;
    }
    const memory: AutoState["memory"] = {};
    for (const [d, counts] of Object.entries(tally)) {
      const entries = Object.entries(counts);
      if (entries.length === 1)
        memory[d] = { folder: entries[0][0], count: entries[0][1] }; // only sites that always land in one folder
    }
    const prev = await loadAuto();
    await saveAuto({
      enabled: prev?.enabled ?? true,
      barId: bar.id,
      folders: Object.fromEntries(
        order.filter((n) => ids[n]).map((n) => [n, ids[n]]),
      ),
      memory,
      model: prev?.model ?? null,
    });

    return {
      moved: done,
      folders: Object.keys(ids).length,
      created: snap.created.length,
      removedFolders: snap.removed.length,
      deleted: removedBookmarks,
    };
  } finally {
    await set("bb.applying", false);
  }
}

/** Put every bookmark back exactly where it was before the tidy. */
export async function undoTidy(): Promise<boolean> {
  const snap = await loadSnapshot();
  if (!snap) return false;
  await set("bb.applying", true);
  try {
    // Recreate removed folders, parents first, in their original order.
    const idMap = new Map<string, string>();
    for (const f of [...snap.removed].sort(
      (a, b) => a.depth - b.depth || a.index - b.index,
    )) {
      const parentId = idMap.get(f.parentId) ?? f.parentId;
      let made;
      try {
        made = await chrome.bookmarks.create({
          parentId,
          index: f.index,
          title: f.title,
        });
      } catch {
        made = await chrome.bookmarks.create({ parentId, title: f.title });
      }
      idMap.set(f.id, made.id);
    }
    // Move bookmarks back, lowest index first so positions line up.
    const gone = new Map((snap.deleted ?? []).map((g) => [g.id, g]));
    for (const p of [...snap.items].sort((a, b) => a.index - b.index)) {
      const parentId = idMap.get(p.parentId) ?? p.parentId;
      const g = gone.get(p.id);
      if (g) {
        // deleted on Apply: recreate it in its old spot
        try {
          await chrome.bookmarks.create({
            parentId,
            index: p.index,
            title: g.title,
            url: g.url,
          });
        } catch {
          try {
            await chrome.bookmarks.create({
              parentId,
              title: g.title,
              url: g.url,
            });
          } catch {
            /* parent gone */
          }
        }
        continue;
      }
      try {
        await chrome.bookmarks.move(p.id, { parentId, index: p.index });
      } catch {
        try {
          await chrome.bookmarks.move(p.id, { parentId });
        } catch {
          /* bookmark was deleted since */
        }
      }
    }
    // Bookmarks saved since the tidy were loose in the Bookmarks bar before Buddy filed them, so they go back there.
    const known = new Set(snap.items.map((i) => i.id));
    const auto0 = await loadAuto();
    for (const id of snap.created) {
      try {
        for (const k of (await chrome.bookmarks.getChildren(id)) as Node[]) {
          if (k.url && !known.has(k.id) && auto0?.barId)
            await chrome.bookmarks.move(k.id, { parentId: auto0.barId });
        }
      } catch {
        /* gone */
      }
    }
    // Remove the folders Bookmark Buddy created, if they're empty now (subfolders first, they were created after their parents).
    for (const id of [...snap.created].reverse()) {
      try {
        const kids = await chrome.bookmarks.getChildren(id);
        if (!kids.length) await chrome.bookmarks.remove(id);
      } catch {
        /* gone */
      }
    }
    await chrome.storage.local.remove("bb.undo");
    const auto = await loadAuto();
    if (auto) await saveAuto({ ...auto, enabled: false, folders: {} });
    return true;
  } finally {
    await set("bb.applying", false);
  }
}

/** Bookmarks waiting in "Needs a home" (the background sorter parks them there when Gemma isn't available). */
export async function needsHome(): Promise<Bookmark[]> {
  const auto = await loadAuto();
  const id = auto?.folders[NEEDS_HOME];
  if (!id) return [];
  try {
    const kids = (await chrome.bookmarks.getChildren(id)) as Node[];
    return kids
      .filter((k) => k.url)
      .map((k, i) => ({
        id: 100000 + i,
        chromeId: k.id,
        title: k.title || k.url!,
        url: k.url!,
        domain: domainOf(k.url!),
        oldPath: NEEDS_HOME,
        folder: "",
      }));
  } catch {
    return [];
  }
}

/** The id of one of Buddy's folders in the Bookmarks bar, recreating it if it was removed. */
export async function ensureFolder(
  auto: AutoState,
  name: string,
): Promise<string> {
  const known = auto.folders[name];
  if (known) {
    try {
      await chrome.bookmarks.get(known);
      return known;
    } catch {
      /* deleted; make a new one */
    }
  }
  const parentId = parentOf(name)
    ? await ensureFolder(auto, parentOf(name))
    : auto.barId; // a subfolder lives in its parent
  const kids = (await chrome.bookmarks.getChildren(parentId)) as Node[];
  const same = kids.find(
    (k) => !k.url && k.title.toLowerCase() === labelOf(name).toLowerCase(),
  );
  let id = same?.id;
  if (!id) {
    id = (await chrome.bookmarks.create({ parentId, title: labelOf(name) }))
      .id as string;
    const snap = await loadSnapshot();
    if (snap) {
      snap.created.push(id);
      await set("bb.undo", snap);
    } // so Undo cleans it up too
  }
  auto.folders[name] = id;
  await saveAuto(auto);
  return id;
}

export async function moveTo(chromeId: string, folderName: string) {
  const auto = await loadAuto();
  if (!auto?.barId) return;
  await set("bb.applying", true); // so the background doesn't treat this as the person's own move
  try {
    await chrome.bookmarks.move(chromeId, {
      parentId: await ensureFolder(auto, folderName),
    });
  } finally {
    await set("bb.applying", false);
  }
}

export { normalize };
