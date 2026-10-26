import { Component, computed, effect, inject, signal } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { IOS, LocalAiService } from "./local-ai.service";
import {
  Bookmark,
  MAYBE,
  OTHER,
  applyRules,
  countSkipped,
  exportBookmarks,
  parseBookmarks,
} from "./bookmarks";
import {
  BATCH,
  FALLBACK_FOLDERS,
  folderKeywords,
  foldersPrompt,
  keywordPick,
  parseFolders,
  parseSort,
  overlaps,
  rememberable,
  sortPrompt,
  subfoldersPrompt,
} from "./sorter";
import { sampleHtml } from "./sample";
import {
  SEP,
  childrenOf,
  isSub,
  join,
  keptPath,
  labelOf,
  normalizeFolders,
  nudge,
  parentOf,
  placeTop,
  renamePath,
} from "./folders";
import {
  ApplyResult,
  AutoState,
  EXT,
  NEEDS_HOME,
  applyTidy,
  loadAuto,
  loadSnapshot,
  moveTo,
  needsHome,
  readTree,
  saveAuto,
  undoTidy,
} from "./chrome-bookmarks";

type Step = "start" | "folders" | "sorting" | "review" | "applying" | "done";
interface Stats {
  total: number;
  duplicates: number;
  flagged: number;
  skipped: number;
  memory: number;
  gemma: number;
  seconds: number;
  keyword?: number;
  kept?: number;
}
interface Session {
  step: Step;
  bookmarks: Bookmark[];
  folders: string[];
  stats: Stats;
  fileName: string;
  fromBrowser?: boolean;
}

const KEY = "bb.session.v1";
const emptyStats = (): Stats => ({
  total: 0,
  duplicates: 0,
  flagged: 0,
  skipped: 0,
  memory: 0,
  gemma: 0,
  seconds: 0,
});

function loadSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

@Component({
  selector: "app-root",
  imports: [NgTemplateOutlet],
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App {
  readonly ai = inject(LocalAiService);
  readonly MAYBE = MAYBE;
  readonly OTHER = OTHER;

  private readonly saved = loadSession();
  readonly step = signal<Step>(
    this.saved?.step === "sorting"
      ? "folders"
      : this.saved?.step === "applying" || this.saved?.step === "done"
        ? "start"
        : (this.saved?.step ?? "start"),
  );
  readonly bookmarks = signal<Bookmark[]>(this.saved?.bookmarks ?? []);
  readonly folders = signal<string[]>(this.saved?.folders ?? []);
  readonly stats = signal<Stats>(this.saved?.stats ?? emptyStats());
  readonly fileName = signal(this.saved?.fileName ?? "");
  /** Extension mode: these bookmarks came from this browser, so they can be applied in place. */
  readonly ext = EXT;
  readonly fromBrowser = signal(!!this.saved?.fromBrowser && EXT);
  readonly applied = signal<ApplyResult | null>(null);
  readonly auto = signal<AutoState | null>(null);
  readonly hasUndo = signal(false);
  readonly waiting = signal<Bookmark[]>([]);
  readonly NEEDS_HOME = NEEDS_HOME;

  readonly busy = signal(""); // what Gemma is doing right now
  readonly error = signal("");
  readonly done = signal(0); // bookmarks sorted so far (this run)
  readonly todo = signal(0); // bookmarks to sort (this run)
  readonly eta = signal("");
  readonly filter = signal("");
  readonly dragOver = signal(false);
  readonly dragging = signal<number | null>(null); // bookmark being dragged on the review screen
  readonly dropTarget = signal<string | null>(null);
  readonly dropBefore = signal<number | null>(null); // bookmark the dragged one will land in front of
  readonly draggingFolder = signal<string | null>(null); // folder section being reordered
  readonly folderTarget = signal<string | null>(null);
  readonly online = signal(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  private stopFlag = false;

  readonly allFolders = computed(() => [...this.folders(), OTHER, MAYBE]);
  /** Review screen: one card per top-level folder, with its subfolders inside it. */
  readonly groups = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.folders();
    const match = (b: Bookmark) =>
      !q || b.title.toLowerCase().includes(q) || b.domain.includes(q);
    const itemsIn = (name: string) =>
      this.bookmarks().filter(
        (b) => !b.deleted && (b.folder || OTHER) === name && match(b),
      );
    const dragging = this.dragging() !== null;
    return [...list.filter((p) => !isSub(p)), OTHER, MAYBE]
      .map((name) => ({
        name,
        items: itemsIn(name),
        subs: childrenOf(list, name)
          .map((p) => ({ name: p, label: labelOf(p), items: itemsIn(p) }))
          .filter((s) => s.items.length || dragging || !q),
      }))
      .filter(
        (g) =>
          g.items.length ||
          g.subs.some((s) => s.items.length) ||
          dragging ||
          (!q && g.name !== MAYBE && g.name !== OTHER),
      );
  });
  readonly topFolders = computed(() => this.folders().filter((p) => !isSub(p)));
  /** Two columns that pack like a masonry wall (no gaps under short folders); one column on narrow screens. */
  private readonly mq =
    typeof matchMedia === "undefined" ? null : matchMedia("(min-width: 940px)");
  readonly wide = signal(this.mq?.matches ?? true);
  readonly columns = computed(() => {
    const gs = this.groups();
    if (!this.wide()) return [gs];
    const cols: (typeof gs)[] = [[], []];
    const h = [0, 0];
    for (const g of gs) {
      const i = h[0] <= h[1] ? 0 : 1; // next folder goes in the shorter column
      cols[i].push(g);
      h[i] +=
        86 +
        Math.min(Math.max(g.items.length, 1), 7.6) * 50 +
        g.subs.reduce(
          (n, s) => n + 60 + Math.min(Math.max(s.items.length, 1), 7.6) * 50,
          0,
        );
    }
    return cols;
  });
  readonly trash = computed(() => this.bookmarks().filter((b) => b.deleted));
  readonly oldFolderCount = computed(
    () => new Set(this.bookmarks().map((b) => b.oldPath)).size,
  );
  readonly percent = computed(() =>
    this.todo() ? Math.round((this.done() / this.todo()) * 100) : 0,
  );

  constructor() {
    this.ai.loadIfCached();
    // If Gemma finishes loading after a file was dropped in, suggest folders right away.
    effect(() => {
      if (
        this.ai.state() === "ready" &&
        this.step() === "folders" &&
        !this.folders().length &&
        !this.busy()
      )
        queueMicrotask(() => this.suggestFolders());
    });
    if (EXT) {
      this.refreshExt();
      // Tell the background sorter which Gemma model is downloaded on this device.
      effect(() => {
        const id = this.ai.modelId();
        if (id)
          loadAuto().then((a) =>
            saveAuto({
              ...(a ?? { enabled: true, barId: "", folders: {}, memory: {} }),
              model: id,
            }).then(() => this.refreshExt()),
          );
      });
    }
    this.mq?.addEventListener("change", (e) => this.wide.set(e.matches));
    addEventListener("online", () => this.online.set(true));
    addEventListener("offline", () => this.online.set(false));
    effect(() => {
      const s: Session = {
        step: this.step(),
        bookmarks: this.bookmarks(),
        folders: this.folders(),
        stats: this.stats(),
        fileName: this.fileName(),
        fromBrowser: this.fromBrowser(),
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(s));
      } catch {
        /* full or private mode: the session just won't survive a refresh */
      }
    });
  }

  // ---------- 1. import ----------
  async onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await this.read(file);
    (e.target as HTMLInputElement).value = "";
  }
  async onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragOver.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await this.read(file);
  }
  private async read(file: File) {
    this.load(await file.text(), file.name);
  }
  useSample() {
    this.fromBrowser.set(false);
    this.load(sampleHtml(), "sample-bookmarks.html");
  }

  private load(html: string, name: string) {
    this.error.set("");
    const list = parseBookmarks(html);
    if (!list.length) {
      this.error.set(
        "I couldn't find any bookmarks in that file. Export them from your browser as an HTML file and try again.",
      );
      return;
    }
    this.fromBrowser.set(false);
    this.loadList(list, name, countSkipped(html));
  }

  /** Extension mode: read the bookmarks in this browser directly. Nothing to export. */
  async readMine() {
    this.error.set("");
    const { list, skipped } = await readTree();
    if (!list.length) {
      this.error.set("This browser doesn't have any bookmarks to tidy yet.");
      return;
    }
    this.fromBrowser.set(true);
    this.loadList(list, "This browser", skipped);
  }

  private loadList(list: Bookmark[], name: string, skipped: number) {
    const { duplicates, flagged } = applyRules(list);
    this.bookmarks.set(list);
    this.fileName.set(name);
    this.applied.set(null);
    this.stats.set({
      ...emptyStats(),
      total: list.length,
      duplicates,
      flagged,
      skipped,
    });
    this.folders.set([]);
    this.step.set("folders");
    if (this.ai.state() === "ready") this.suggestFolders();
  }

  // ---------- 2. folders ----------
  /** The person's own folders (top two levels), with how many bookmarks are in each. */
  readonly ownFolders = computed(() => {
    const counts = new Map<string, number>();
    for (const b of this.bookmarks()) {
      if (b.folder === MAYBE && b.why) continue;
      const p = keptPath(b.oldPath, this.fromBrowser());
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return normalizeFolders([...counts.keys()]);
  });
  readonly keptCount = computed(
    () => this.bookmarks().filter((b) => b.pinned).length,
  );
  readonly isSub = isSub;
  readonly labelOf = labelOf;

  /** Start from the folders (and subfolders) the person already has. Bookmarks already in them stay put; only loose ones get sorted. */
  keepMine() {
    const own = this.ownFolders();
    if (!own.length) return;
    this.folders.set(own);
    this.bookmarks.update((l) =>
      l.map((b) => {
        if (b.folder === MAYBE && b.why) return b;
        const p = keptPath(b.oldPath, this.fromBrowser());
        return { ...b, folder: p, pinned: !!p };
      }),
    );
  }

  async suggestFolders(mode: "replace" | "add" = "replace") {
    if (this.ai.state() !== "ready" || this.busy()) return;
    const pool = this.bookmarks().filter((b) => b.folder !== MAYBE);
    const n = IOS ? 30 : 60;
    const step = Math.max(1, pool.length / n);
    const sample = Array.from(
      { length: Math.min(n, pool.length) },
      (_, i) => pool[Math.floor(i * step)],
    );
    const oldFolders = [
      ...new Set(
        this.bookmarks()
          .map((b) => b.oldPath.split(" / ").pop() ?? "")
          .filter(Boolean),
      ),
    ];
    this.busy.set("Gemma is looking through your bookmarks…");
    try {
      const raw = await this.ai.generate(foldersPrompt(sample, oldFolders), {
        maxTokens: 90,
        temperature: 0.4,
      });
      const parsed = parseFolders(raw);
      const f = parsed.length >= 3 ? parsed : FALLBACK_FOLDERS;
      // Adding to the person's own folders: skip ideas that repeat one they already have ("Recipes & Cooking" next to "Recipes").
      if (mode === "add")
        this.folders.update((l) =>
          normalizeFolders([
            ...l,
            ...f.filter(
              (x) =>
                !l.some(
                  (y) => y.toLowerCase() === x.toLowerCase() || overlaps(y, x),
                ),
            ),
          ]),
        );
      else {
        this.folders.set(f);
        this.bookmarks.update((l) =>
          l.map((b) => (b.pinned ? { ...b, pinned: false, folder: "" } : b)),
        );
      }
    } catch (e) {
      console.warn(e);
      if (mode === "replace") this.folders.set(FALLBACK_FOLDERS);
    } finally {
      this.busy.set("");
    }
  }
  /** Remove a folder and its subfolders. On the folders step their bookmarks just get sorted again; on review they move up a level. */
  removeFolder(f: string, review = false) {
    const gone = (p: string) => p === f || p.startsWith(f + SEP);
    const dest = review ? parentOf(f) || OTHER : "";
    this.folders.update((list) => list.filter((x) => !gone(x)));
    this.bookmarks.update((l) =>
      l.map((b) =>
        gone(b.folder) ? { ...b, folder: dest, pinned: false } : b,
      ),
    );
  }
  /** Review screen: remove a folder; anything in it goes to its parent (or "Other"). */
  removeFolderFromReview(f: string) {
    const n = this.bookmarks().filter(
      (b) => !b.deleted && (b.folder === f || b.folder.startsWith(f + SEP)),
    ).length;
    if (n && !confirmRemoveFolder(labelOf(f), n, parentOf(f) || OTHER)) return;
    this.removeFolder(f, true);
  }
  readonly editing = signal<string | null>(null);
  startRename(name: string) {
    this.editing.set(name);
    setTimeout(() =>
      (
        document.querySelector("input.rename") as HTMLInputElement | null
      )?.select(),
    );
  }
  finishRename(old: string, e: Event) {
    this.renameFolder(old, e);
    this.editing.set(null);
  }
  private cleanName(v: string) {
    return v.replace(/›/g, "-").trim().slice(0, 28);
  }
  addFolder(input: HTMLInputElement, parent = "") {
    const label = this.cleanName(input.value);
    const path = join(parent, label);
    if (
      label &&
      !/^(other|maybe delete\??)$/i.test(label) &&
      !this.allFolders().some((f) => f.toLowerCase() === path.toLowerCase())
    ) {
      this.folders.update((l) => normalizeFolders([...l, path]));
    }
    input.value = "";
  }
  /** The input holds just the folder's own name; a renamed parent takes its subfolders (and their bookmarks) with it. */
  renameFolder(old: string, e: Event) {
    const label = this.cleanName((e.target as HTMLInputElement).value);
    const next = join(parentOf(old), label);
    if (
      !label ||
      next === old ||
      /^(other|maybe delete\??)$/i.test(label) ||
      this.allFolders().some(
        (f) => f !== old && f.toLowerCase() === next.toLowerCase(),
      )
    ) {
      (e.target as HTMLInputElement).value = labelOf(old);
      return;
    }
    const map = renamePath(old, label);
    this.folders.update((l) => l.map(map));
    this.bookmarks.update((l) =>
      l.map((b) =>
        b.folder && map(b.folder) !== b.folder
          ? { ...b, folder: map(b.folder) }
          : b,
      ),
    );
  }

  /** Review screen: Gemma looks inside a big folder and splits it into a few subfolders. */
  async suggestSubfolders(parent: string) {
    if (this.ai.state() !== "ready" || this.busy()) return;
    const items = this.bookmarks().filter(
      (b) => !b.deleted && b.folder === parent,
    );
    if (items.length < 4) return;
    this.busy.set(`Gemma is looking inside “${parent}”…`);
    try {
      const raw = await this.ai.generate(subfoldersPrompt(parent, items), {
        maxTokens: 50,
        temperature: 0.4,
      });
      const names = parseFolders(raw)
        .filter((n) => n.toLowerCase() !== parent.toLowerCase())
        .slice(0, 4);
      if (names.length < 2) {
        this.error.set(
          `Gemma didn't find a good way to split “${parent}”. You can add subfolders yourself.`,
        );
        return;
      }
      const subs = names.map((n) => join(parent, this.cleanName(n)));
      this.folders.update((l) =>
        normalizeFolders([...l, ...subs.filter((s) => !l.includes(s))]),
      );
      const all = childrenOf(this.folders(), parent);
      const labels = all.map(labelOf);
      const kw = folderKeywords(all);
      this.busy.set(`Sorting “${parent}” into subfolders…`);
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        let picks: string[];
        try {
          picks = parseSort(
            await this.ai.generate(sortPrompt(batch, labels), {
              maxTokens: BATCH * 12 + 20,
              temperature: 0,
            }),
            batch,
            labels,
          );
        } catch {
          picks = batch.map(() => OTHER);
        }
        const moves = new Map(
          batch.map((b, k) => [
            b.id,
            keywordPick(b, kw) ??
              (picks[k] === OTHER ? parent : join(parent, picks[k])),
          ]),
        );
        this.bookmarks.update((l) =>
          l.map((b) =>
            moves.has(b.id) ? { ...b, folder: moves.get(b.id)! } : b,
          ),
        );
      }
    } finally {
      this.busy.set("");
    }
  }

  // ---------- 3. sorting ----------
  async sortAll() {
    if (this.ai.state() !== "ready" || !this.folders().length) return;
    const folders = this.folders();
    // Re-sorting starts fresh for everything except the app's own "Maybe delete?" rules.
    const exists = new Set(folders);
    let list = this.bookmarks().map((b) =>
      b.folder === MAYBE && b.why
        ? b
        : b.pinned && exists.has(b.folder)
          ? b
          : { ...b, folder: "", pinned: false },
    );
    const queue = list.filter((b) => !b.folder && !b.deleted);
    const kept = list.filter((b) => b.pinned).length;
    this.todo.set(queue.length);
    this.done.set(0);
    this.step.set("sorting");
    this.stopFlag = false;
    const memory = new Map<string, { folder: string; count: number }>();
    const keywords = folderKeywords(folders);
    let fromMemory = 0,
      fromGemma = 0,
      fromKeyword = 0;
    const byGemma = new Set<number>();
    // One sorted example per folder goes into each prompt, so Gemma stays consistent from batch to batch.
    const examples = new Map<string, Bookmark>();
    const example = (b: Bookmark, folder: string) => {
      if (folder !== OTHER && !examples.has(folder))
        examples.set(folder, { ...b, folder });
    };
    const started = performance.now();
    let gemmaMs = 0,
      gemmaCalls = 0;

    const assign = (id: number, folder: string) => {
      list = list.map((b) => (b.id === id ? { ...b, folder } : b));
    };

    let i = 0;
    while (i < queue.length && !this.stopFlag) {
      const batch: Bookmark[] = [];
      while (i < queue.length && batch.length < BATCH) {
        const b = queue[i++];
        const m = rememberable(b.domain) ? memory.get(b.domain) : undefined;
        const known = m && m.count >= 2 ? m.folder : undefined; // trust a site only after Gemma agreed with itself twice
        const named = known ? undefined : keywordPick(b, keywords); // "Easy taco recipe" clearly belongs in Recipes
        if (known) {
          assign(b.id, known);
          fromMemory++;
          this.done.update((n) => n + 1);
        } else if (named) {
          assign(b.id, named);
          fromKeyword++;
          example(b, named);
          this.done.update((n) => n + 1);
          if (rememberable(b.domain)) {
            const k = memory.get(b.domain);
            memory.set(
              b.domain,
              k && k.folder === named
                ? { folder: named, count: k.count + 1 }
                : (k ?? { folder: named, count: 1 }),
            );
          }
        } else batch.push(b);
      }
      if (batch.length) {
        this.busy.set(`Sorting ${batch.length} bookmarks…`);
        const t0 = performance.now();
        let picks: string[];
        try {
          const raw = await this.ai.generate(
            sortPrompt(batch, folders, [...examples.values()].slice(0, 8)),
            { maxTokens: BATCH * 12 + 20, temperature: 0 },
          );
          picks = parseSort(raw, batch, folders);
        } catch (e) {
          console.warn(e);
          picks = batch.map(() => OTHER);
        }
        gemmaMs += performance.now() - t0;
        gemmaCalls++;
        batch.forEach((b, k) => {
          assign(b.id, picks[k]);
          byGemma.add(b.id);
          example(b, picks[k]);
          if (!rememberable(b.domain) || picks[k] === OTHER) return;
          const m = memory.get(b.domain);
          memory.set(
            b.domain,
            m && m.folder === picks[k]
              ? { folder: m.folder, count: m.count + 1 }
              : m
                ? { folder: m.folder, count: 0 }
                : { folder: picks[k], count: 1 },
          );
        });
        fromGemma += batch.length;
        this.done.update((n) => n + batch.length);
        const left = Math.ceil((queue.length - i) / BATCH);
        this.eta.set(
          left > 0
            ? `About ${Math.max(1, Math.round(((gemmaMs / gemmaCalls) * left) / 1000))} seconds left`
            : "Almost done",
        );
      }
      this.bookmarks.set(list);
    }
    // Same site, same folder: if Gemma put most of a site's bookmarks in one folder, its odd ones out join them.
    const bySite = new Map<string, Bookmark[]>();
    for (const b of list)
      if (b.folder && b.folder !== MAYBE && rememberable(b.domain))
        bySite.set(b.domain, [...(bySite.get(b.domain) ?? []), b]);
    for (const items of bySite.values()) {
      if (items.length < 3) continue;
      const counts = new Map<string, number>();
      for (const b of items)
        counts.set(b.folder, (counts.get(b.folder) ?? 0) + 1);
      const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (top === OTHER || n / items.length < 0.6) continue;
      for (const b of items)
        if (b.folder !== top && byGemma.has(b.id)) assign(b.id, top);
    }
    // Anything not reached (if stopped) still goes somewhere, so nothing is lost.
    list = list.map((b) => (b.folder ? b : { ...b, folder: OTHER }));
    this.bookmarks.set(list);
    this.stats.update((s) => ({
      ...s,
      memory: fromMemory,
      gemma: fromGemma,
      keyword: fromKeyword,
      kept,
      seconds: Math.round((performance.now() - started) / 1000),
    }));
    this.busy.set("");
    this.eta.set("");
    this.step.set("review");
  }
  stop() {
    this.stopFlag = true;
    this.ai.stop();
  }

  // ---------- 4. review & export ----------
  move(b: Bookmark, e: Event) {
    const folder = (e.target as HTMLSelectElement).value;
    this.bookmarks.update((l) =>
      l.map((x) =>
        x.id === b.id
          ? { ...x, folder, why: folder === MAYBE ? x.why : undefined }
          : x,
      ),
    );
  }
  // Drag and drop between folders (the menu on each bookmark still works for keyboard and touch).
  onDragStart(b: Bookmark, e: DragEvent) {
    e.dataTransfer?.setData("text/plain", String(b.id));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    // Let the browser grab the drag image before the layout changes.
    setTimeout(() => this.dragging.set(b.id));
  }
  onDragEnd() {
    this.dragging.set(null);
    this.dropTarget.set(null);
    this.dropBefore.set(null);
    this.draggingFolder.set(null);
    this.folderTarget.set(null);
  }
  onDragOverGroup(name: string, e: DragEvent) {
    if (this.draggingFolder() !== null) {
      name = parentOf(name) || name; // folders are reordered by their top-level card
      if (!this.movable(name)) return;
      e.preventDefault();
      this.folderTarget.set(name);
      return;
    }
    if (this.dragging() === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    this.dropTarget.set(name);
  }
  /** Hovering over a bookmark while dragging: the dragged one will be dropped just above it. */
  onDragOverRow(b: Bookmark, e: DragEvent) {
    if (this.dragging() === null || this.dragging() === b.id) return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    if (e.clientY > r.top + r.height / 2) {
      // lower half: drop after this one, i.e. before the next bookmark in the same folder
      const items = this.bookmarks().filter(
        (x) =>
          (x.folder || OTHER) === (b.folder || OTHER) &&
          x.id !== this.dragging(),
      );
      const next = items[items.findIndex((x) => x.id === b.id) + 1];
      this.dropBefore.set(next ? next.id : null);
    } else {
      this.dropBefore.set(b.id);
    }
  }
  onDragLeaveGroup(e: DragEvent) {
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) {
      this.dropTarget.set(null);
      this.folderTarget.set(null);
    }
  }
  onDropGroup(name: string, e: DragEvent) {
    e.preventDefault();
    const folder = this.draggingFolder();
    if (folder !== null) {
      this.placeFolder(folder, parentOf(name) || name);
    } else {
      const id =
        this.dragging() ?? Number(e.dataTransfer?.getData("text/plain"));
      if (id !== null && !Number.isNaN(id))
        this.placeBookmark(id, name, this.dropBefore());
    }
    this.onDragEnd();
  }
  private moveLocal(id: number, folder: string) {
    this.bookmarks.update((l) =>
      l.map((x) =>
        x.id === id
          ? { ...x, folder, why: folder === MAYBE ? x.why : undefined }
          : x,
      ),
    );
  }
  /** Move a bookmark into a folder, in front of another bookmark (or at the end). The list order is the folder order. */
  private placeBookmark(id: number, folder: string, beforeId: number | null) {
    this.bookmarks.update((l) => {
      const item = l.find((x) => x.id === id);
      if (!item) return l;
      const moved = {
        ...item,
        folder,
        why: folder === MAYBE ? item.why : undefined,
      };
      const rest = l.filter((x) => x.id !== id);
      const before =
        beforeId !== null
          ? rest.findIndex(
              (x) => x.id === beforeId && (x.folder || OTHER) === folder,
            )
          : -1;
      if (before >= 0) rest.splice(before, 0, moved);
      else {
        // end of that folder: right after its last bookmark (or at the very end if it's empty)
        let last = -1;
        rest.forEach((x, i) => {
          if ((x.folder || OTHER) === folder) last = i;
        });
        rest.splice(last >= 0 ? last + 1 : rest.length, 0, moved);
      }
      return rest;
    });
  }
  /** Bookmarks within a folder, nudged up or down with the keyboard-friendly buttons. */
  nudgeBookmark(b: Bookmark, dir: -1 | 1) {
    const f = b.folder || OTHER;
    const items = this.bookmarks().filter((x) => (x.folder || OTHER) === f);
    const i = items.findIndex((x) => x.id === b.id);
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    this.placeBookmark(
      b.id,
      f,
      dir < 0 ? items[j].id : (items[j + 1]?.id ?? null),
    );
  }

  // Reordering the folders themselves ("Other" and "Maybe delete?" always stay at the end).
  movable(name: string) {
    return name !== OTHER && name !== MAYBE;
  }
  onFolderDragStart(name: string, e: DragEvent) {
    e.stopPropagation();
    e.dataTransfer?.setData("text/plain", "folder:" + name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setTimeout(() => this.draggingFolder.set(name));
  }
  private placeFolder(name: string, target: string) {
    if (
      name === target ||
      !this.movable(target) ||
      isSub(name) ||
      isSub(target)
    )
      return;
    this.folders.update((l) => placeTop(l, name, target)); // dragging down lands after the target, up lands before it
  }
  nudgeFolder(name: string, dir: -1 | 1) {
    this.folders.update((l) => nudge(l, name, dir));
  }
  /** Disable ↑ on the first and ↓ on the last folder among its siblings. */
  edge(name: string, dir: -1 | 1) {
    const l = this.folders();
    const sibs = isSub(name)
      ? childrenOf(l, parentOf(name))
      : l.filter((p) => !isSub(p));
    return dir < 0 ? sibs[0] === name : sibs[sibs.length - 1] === name;
  }

  // Deleting is always the person's choice, and reversible until Apply (and after, with Undo everything).
  deleteBookmark(b: Bookmark) {
    this.bookmarks.update((l) =>
      l.map((x) => (x.id === b.id ? { ...x, deleted: true } : x)),
    );
  }
  restore(b: Bookmark) {
    this.bookmarks.update((l) =>
      l.map((x) => (x.id === b.id ? { ...x, deleted: false } : x)),
    );
  }
  restoreAll() {
    this.bookmarks.update((l) =>
      l.map((x) => (x.deleted ? { ...x, deleted: false } : x)),
    );
  }
  deleteFolderContents(name: string) {
    const n = this.bookmarks().filter(
      (b) => !b.deleted && (b.folder || OTHER) === name,
    ).length;
    if (!n || !confirmDelete(n, name)) return;
    this.bookmarks.update((l) =>
      l.map((x) =>
        !x.deleted && (x.folder || OTHER) === name
          ? { ...x, deleted: true }
          : x,
      ),
    );
  }

  setFilter(e: Event) {
    this.filter.set((e.target as HTMLInputElement).value);
  }

  download() {
    const date = new Date().toISOString().slice(0, 10);
    const html = exportBookmarks(
      this.bookmarks(),
      this.folders(),
      `Tidied by Bookmark Buddy (${date})`,
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `bookmarks-tidy-${date}.html`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- extension: apply in place, undo, auto-sort ----------
  async refreshExt() {
    if (!EXT) return;
    this.auto.set((await loadAuto()) ?? null);
    this.hasUndo.set(!!(await loadSnapshot()));
    this.waiting.set(await needsHome());
  }

  async apply() {
    if (!EXT || !this.fromBrowser()) return;
    this.step.set("applying");
    this.todo.set(this.bookmarks().length);
    this.done.set(0);
    try {
      const result = await applyTidy(
        this.bookmarks(),
        this.folders(),
        (d, t) => {
          this.done.set(d);
          this.todo.set(t);
        },
      );
      this.applied.set(result);
      this.step.set("done");
    } catch (e) {
      console.warn(e);
      this.error.set(
        "Something went wrong while moving bookmarks. Use “Undo everything” to put them back.",
      );
      this.step.set("done");
    }
    await this.refreshExt();
  }

  async undoAll() {
    if (!confirmUndo()) return;
    this.busy.set("Putting everything back…");
    try {
      await undoTidy();
    } finally {
      this.busy.set("");
    }
    this.applied.set(null);
    this.startOver();
    await this.refreshExt();
  }

  async toggleAuto() {
    const a = this.auto();
    if (!a) return;
    await saveAuto({ ...a, enabled: !a.enabled });
    await this.refreshExt();
  }

  /** Sort the bookmarks the background sorter parked in "Needs a home". */
  async sortWaiting() {
    const a = this.auto();
    const list = this.waiting();
    if (!a || !list.length || this.ai.state() !== "ready") return;
    const folders = Object.keys(a.folders).filter(
      (f) => f !== OTHER && f !== MAYBE && f !== NEEDS_HOME,
    );
    this.busy.set(
      `Finding a home for ${list.length} bookmark${list.length === 1 ? "" : "s"}…`,
    );
    try {
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const kw = folderKeywords(folders);
        let picks: string[];
        try {
          picks = parseSort(
            await this.ai.generate(sortPrompt(batch, folders), {
              maxTokens: BATCH * 12 + 20,
              temperature: 0,
            }),
            batch,
            folders,
          );
        } catch {
          picks = batch.map(() => OTHER);
        }
        picks = picks.map((p, k) => keywordPick(batch[k], kw) ?? p);
        for (const [k, b] of batch.entries())
          if (b.chromeId)
            await moveTo(b.chromeId, a.folders[picks[k]] ? picks[k] : OTHER);
      }
    } finally {
      this.busy.set("");
      await this.refreshExt();
    }
  }

  startOver() {
    this.bookmarks.set([]);
    this.folders.set([]);
    this.stats.set(emptyStats());
    this.fileName.set("");
    this.filter.set("");
    this.step.set("start");
  }

  initial(b: Bookmark) {
    return (b.domain[0] ?? "?").toUpperCase();
  }
  hue(b: Bookmark) {
    let h = 0;
    for (const c of b.domain) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }
}

function confirmDelete(n: number, folder: string) {
  try {
    return confirm(
      `Mark all ${n} bookmarks in “${folder}” for deleting? You can restore them until you apply.`,
    );
  } catch {
    return true;
  }
}

function confirmRemoveFolder(f: string, n: number, dest: string) {
  try {
    return confirm(
      `Remove the “${f}” folder? Its ${n} bookmark${n === 1 ? "" : "s"} will move to “${dest}”.`,
    );
  } catch {
    return true;
  }
}

function confirmUndo() {
  try {
    return confirm(
      "Put every bookmark back exactly where it was before Bookmark Buddy tidied up?",
    );
  } catch {
    return true;
  }
}
