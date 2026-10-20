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
  foldersPrompt,
  parseFolders,
  parseSort,
  rememberable,
  sortPrompt,
} from "./sorter";
import { sampleHtml } from "./sample";
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
  readonly groups = computed(() => {
    const q = this.filter().trim().toLowerCase();
    return this.allFolders()
      .map((name) => ({
        name,
        items: this.bookmarks().filter(
          (b) =>
            !b.deleted &&
            (b.folder || OTHER) === name &&
            (!q || b.title.toLowerCase().includes(q) || b.domain.includes(q)),
        ),
      }))
      .filter(
        (g) =>
          g.items.length ||
          this.dragging() !== null ||
          (!q && g.name !== MAYBE && g.name !== OTHER),
      );
  });
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
      h[i] += 86 + Math.min(Math.max(g.items.length, 1), 7.6) * 50;
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
  async suggestFolders() {
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
      const f = parseFolders(raw);
      this.folders.set(f.length >= 3 ? f : FALLBACK_FOLDERS);
    } catch (e) {
      console.warn(e);
      this.folders.set(FALLBACK_FOLDERS);
    } finally {
      this.busy.set("");
    }
  }
  removeFolder(f: string) {
    this.folders.update((list) => list.filter((x) => x !== f));
  }
  addFolder(input: HTMLInputElement) {
    const name = input.value.trim().slice(0, 28);
    if (
      name &&
      !this.allFolders().some((f) => f.toLowerCase() === name.toLowerCase())
    )
      this.folders.update((l) => [...l, name]);
    input.value = "";
  }
  renameFolder(old: string, e: Event) {
    const name = (e.target as HTMLInputElement).value.trim().slice(0, 28);
    if (
      !name ||
      name === old ||
      this.allFolders().some((f) => f.toLowerCase() === name.toLowerCase())
    ) {
      (e.target as HTMLInputElement).value = old;
      return;
    }
    this.folders.update((l) => l.map((f) => (f === old ? name : f)));
    this.bookmarks.update((l) =>
      l.map((b) => (b.folder === old ? { ...b, folder: name } : b)),
    );
  }

  // ---------- 3. sorting ----------
  async sortAll() {
    if (this.ai.state() !== "ready" || !this.folders().length) return;
    const folders = this.folders();
    // Re-sorting starts fresh for everything except the app's own "Maybe delete?" rules.
    let list = this.bookmarks().map((b) =>
      b.folder === MAYBE && b.why ? b : { ...b, folder: "" },
    );
    const queue = list.filter((b) => !b.folder && !b.deleted);
    this.todo.set(queue.length);
    this.done.set(0);
    this.step.set("sorting");
    this.stopFlag = false;
    const memory = new Map<string, { folder: string; count: number }>();
    let fromMemory = 0,
      fromGemma = 0;
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
        if (known) {
          assign(b.id, known);
          fromMemory++;
          this.done.update((n) => n + 1);
        } else batch.push(b);
      }
      if (batch.length) {
        this.busy.set(`Sorting ${batch.length} bookmarks…`);
        const t0 = performance.now();
        let picks: string[];
        try {
          const raw = await this.ai.generate(sortPrompt(batch, folders), {
            maxTokens: BATCH * 9 + 20,
            temperature: 0.2,
          });
          picks = parseSort(raw, batch, folders);
        } catch (e) {
          console.warn(e);
          picks = batch.map(() => OTHER);
        }
        gemmaMs += performance.now() - t0;
        gemmaCalls++;
        batch.forEach((b, k) => {
          assign(b.id, picks[k]);
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
    // Anything not reached (if stopped) still goes somewhere, so nothing is lost.
    list = list.map((b) => (b.folder ? b : { ...b, folder: OTHER }));
    this.bookmarks.set(list);
    this.stats.update((s) => ({
      ...s,
      memory: fromMemory,
      gemma: fromGemma,
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
      this.placeFolder(folder, name);
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
    if (name === target || !this.movable(target)) return;
    this.folders.update((l) => {
      const rest = l.filter((f) => f !== name);
      const from = l.indexOf(name),
        to = l.indexOf(target);
      const at = rest.indexOf(target) + (from < to ? 1 : 0); // dragging down lands after the target, up lands before it
      rest.splice(at, 0, name);
      return rest;
    });
  }
  nudgeFolder(name: string, dir: -1 | 1) {
    this.folders.update((l) => {
      const i = l.indexOf(name),
        j = i + dir;
      if (i < 0 || j < 0 || j >= l.length) return l;
      const out = [...l];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
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
        let picks: string[];
        try {
          picks = parseSort(
            await this.ai.generate(sortPrompt(batch, folders), {
              maxTokens: BATCH * 9 + 20,
              temperature: 0.2,
            }),
            batch,
            folders,
          );
        } catch {
          picks = batch.map(() => OTHER);
        }
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

function confirmUndo() {
  try {
    return confirm(
      "Put every bookmark back exactly where it was before Bookmark Buddy tidied up?",
    );
  } catch {
    return true;
  }
}
