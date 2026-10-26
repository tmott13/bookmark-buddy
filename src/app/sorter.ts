import { Bookmark, MAYBE, OTHER } from "./bookmarks";
import { isSub, labelOf, topOf } from "./folders";

/** Small batches keep a small model focused: with 12 at a time, a 2B model starts mixing up which number is which. */
export const BATCH = 6;

const line = (b: Bookmark) =>
  `${b.title.replace(/\s+/g, " ").slice(0, 90)} — ${b.domain}`;

/** Step 1: Gemma looks at a sample and suggests folders. */
export function foldersPrompt(
  sample: Bookmark[],
  oldFolders: string[],
): string {
  return [
    "You are helping someone tidy up their browser bookmarks. Here are some of them (title — website):",
    ...sample.map(line),
    oldFolders.length
      ? `\nTheir current folders are: ${oldFolders.slice(0, 15).join(", ")}.`
      : "",
    "",
    "Suggest 6 to 9 short, friendly folder names (1 to 3 words each) that would hold these bookmarks well,",
    'like "Recipes", "Work Tools", "Job Search" or "Travel Ideas". Do not suggest "Other" or "Misc".',
    "Reply with one folder name per line and nothing else.",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

const BANNED =
  /^(other|others|misc|miscellaneous|maybe delete\??|general|uncategorized|bookmarks)$/i;

export function parseFolders(raw: string): string[] {
  const out: string[] = [];
  for (let l of raw.split("\n")) {
    l = l
      .replace(/^[\s\-*•\d.)#]+/, "")
      .replace(/["“”*_`]/g, "")
      .replace(/[:.]+$/, "")
      .trim();
    if (
      l.length < 2 ||
      l.length > 28 ||
      l.split(/\s+/).length > 4 ||
      BANNED.test(l)
    )
      continue;
    l = l[0].toUpperCase() + l.slice(1);
    if (out.some((f) => f.toLowerCase() === l.toLowerCase())) continue;
    out.push(l);
    if (out.length === 10) break;
  }
  return out;
}

/** Gemma looks inside one big folder and suggests a few subfolders for it. */
export function subfoldersPrompt(parent: string, items: Bookmark[]): string {
  return [
    `These bookmarks are all in a folder called "${parent}" (title — website):`,
    ...items.slice(0, 40).map(line),
    "",
    `Suggest 2 to 4 short subfolder names (1 to 3 words each) to split "${parent}" into, based on what these bookmarks are about.`,
    'Do not repeat the folder name itself, and do not suggest "Other" or "Misc".',
    "Reply with one subfolder name per line and nothing else.",
  ].join("\n");
}

export const FALLBACK_FOLDERS = [
  "Work",
  "Learning",
  "Shopping",
  "News & Reading",
  "Entertainment",
  "Personal",
];

/** Step 2: Gemma sorts a small numbered batch into the agreed folders. Examples (already-sorted bookmarks) keep it consistent. */
export function sortPrompt(
  batch: Bookmark[],
  folders: string[],
  examples: Bookmark[] = [],
): string {
  return [
    "Sort each bookmark into exactly one of these folders:",
    ...[...folders, OTHER].map((f) => `- ${f}`),
    "",
    ...(examples.length
      ? [
          "Already sorted, for reference:",
          ...examples.map((e) => `- ${line(e)} → ${e.folder}`),
          "",
        ]
      : []),
    "Pick the folder that matches what each page is about. Similar pages belong in the same folder.",
    `If nothing fits, use ${OTHER}.`,
    "",
    "Bookmarks (title — website):",
    ...batch.map((b, i) => `${i + 1}. ${line(b)}`),
    "",
    'Reply with one line per bookmark, in the format "number: folder name". Use only the folder names above.',
  ].join("\n");
}

// ---------- the app's own obvious matches (before Gemma) ----------

/** Words that mean the same kind of thing. A folder whose name uses one of these words claims all of them. */
const GROUPS: string[][] = [
  [
    "recipe",
    "cook",
    "cooking",
    "food",
    "meal",
    "dinner",
    "lunch",
    "breakfast",
    "baking",
    "bake",
    "kitchen",
    "dessert",
    "soup",
    "salad",
    "snack",
    "cuisine",
    "foodie",
    "eat",
    "eating",
  ],
  [
    "travel",
    "trip",
    "flight",
    "hotel",
    "vacation",
    "airbnb",
    "stays",
    "itinerary",
    "getaway",
    "cruise",
  ],
  ["job", "career", "resume", "interview", "hiring", "salary", "jobs"],
  [
    "fitness",
    "workout",
    "exercise",
    "yoga",
    "gym",
    "running",
    "pilates",
    "wellness",
    "health",
    "healthy",
    "stretch",
    "strength",
  ],
  [
    "finance",
    "money",
    "budget",
    "bank",
    "invest",
    "investing",
    "tax",
    "taxes",
    "saving",
    "savings",
  ],
  [
    "shopping",
    "shop",
    "buy",
    "deal",
    "deals",
    "sale",
    "gift",
    "gifts",
    "wishlist",
  ],
  [
    "code",
    "coding",
    "dev",
    "developer",
    "programming",
    "javascript",
    "typescript",
    "css",
    "html",
    "react",
    "angular",
    "api",
    "docs",
    "documentation",
    "git",
    "regex",
    "frontend",
    "backend",
    "webdev",
  ],
  ["garden", "gardening", "plant", "plants"],
  ["book", "books", "novel", "reads"],
  ["movie", "movies", "film", "tv", "show", "shows", "netflix", "streaming"],
  [
    "music",
    "beat",
    "lofi",
    "playlist",
    "album",
    "song",
    "songs",
    "concert",
    "podcast",
    "podcasts",
  ],
  ["pet", "pets", "dog", "dogs", "cat", "cats", "puppy", "vet"],
  ["hike", "hiking", "trail", "trails", "camping", "outdoors", "park", "parks"],
  ["halloween", "holiday", "holidays", "christmas", "thanksgiving"],
  ["news"],
  ["learn", "learning", "course", "courses", "tutorial", "tutorials", "class"],
];
/** Too vague to decide anything on their own. */
const VAGUE = new Set([
  "and",
  "the",
  "my",
  "of",
  "for",
  "to",
  "a",
  "ideas",
  "idea",
  "list",
  "stuff",
  "things",
  "life",
  "misc",
  "other",
  "general",
  "fun",
  "interests",
  "interest",
  "hobbies",
  "hobby",
  "weekend",
  "reading",
  "read",
  "new",
  "saved",
  "links",
  "tools",
  "tool",
  "work",
  "home",
  "personal",
  "later",
  "daily",
  "useful",
  "favorites",
  "favorite",
  "random",
  "events",
  "event",
  "inspiration",
  "resources",
  "resource",
  "search",
  "tips",
  "tip",
  "guide",
  "best",
  "top",
  "free",
  "online",
  "web",
  "site",
  "page",
  "app",
  "blog",
  "article",
  "video",
  "bookmark",
  "folder",
  "important",
  "todo",
  "archive",
  "old",
  "news",
  "new",
  "cool",
  "project",
  "info",
  "how",
  "prep",
  "plan",
  "planning",
  "idea",
  "week",
  "weekly",
  "quick",
  "easy",
]);

const singular = (w: string) =>
  w.length > 4 && w.endsWith("ies")
    ? w.slice(0, -3) + "y"
    : w.length > 3 && w.endsWith("s") && !w.endsWith("ss")
      ? w.slice(0, -1)
      : w;
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);

/** The words that point at each folder: its own name, plus their group (a "Recipes" folder also claims "cooking", "meal"…). */
export function folderKeywords(folders: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of folders) {
    const set = new Set<string>();
    for (const w of words(labelOf(f))) {
      // a subfolder is matched by its own name; it lives inside its parent anyway
      if (VAGUE.has(w) || w.length < 3) continue;
      set.add(w);
      // Subfolders are finer splits (Dinners vs Desserts), so only their own words count; top-level folders claim the whole group.
      if (!isSub(f))
        for (const g of GROUPS)
          if (g.map(singular).includes(w))
            g.forEach((x) => set.add(singular(x)));
    }
    if (set.size) out.set(f, set);
  }
  return out;
}

/** True if two folder names are about the same thing ("Recipes" and "Recipes & Cooking"). */
export function overlaps(a: string, b: string): boolean {
  const wa = new Set(
    words(labelOf(a)).filter((w) => !VAGUE.has(w) && w.length >= 3),
  );
  return words(labelOf(b)).some((w) => wa.has(w));
}

/** If a bookmark's title or site clearly names exactly one folder ("Easy taco recipe" → Recipes), the app files it without asking Gemma. */
export function keywordPick(
  b: Bookmark,
  keywords: Map<string, Set<string>>,
): string | undefined {
  const t = new Set(words(b.title));
  const host = b.domain.toLowerCase();
  const hits = [...keywords]
    .filter(([, set]) =>
      [...set].some((k) => t.has(k) || (k.length >= 5 && host.includes(k))),
    )
    .map(([f]) => f);
  if (hits.length === 1) return hits[0];
  // "Easy chicken dinner recipe" matches Recipes and Recipes › Dinners: same family, so the subfolder wins.
  const families = new Set(hits.map(topOf));
  if (families.size !== 1) return undefined;
  const subs = hits.filter((h) => h !== topOf(h));
  return subs.length === 1
    ? subs[0]
    : subs.length === 0
      ? hits[0]
      : topOf(hits[0]);
}

/** Read Gemma's answer. Anything it skips or names wrong goes to "Other", so no bookmark is ever lost. */
export function parseSort(
  raw: string,
  batch: Bookmark[],
  folders: string[],
): string[] {
  const all = [...folders, OTHER];
  const result: string[] = batch.map(() => OTHER);
  for (const l of raw.split("\n")) {
    const m = l.match(/^\s*\**\s*(\d+)\s*[:.)\-–]\s*(.+)$/);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= batch.length) continue;
    result[i] = matchFolder(m[2], all);
  }
  return result;
}

export function matchFolder(name: string, all: string[]): string {
  const clean = name
    .replace(/["“”*_`]/g, "")
    .replace(/\(.*\)$/, "")
    .replace(/[.:]+$/, "")
    .trim()
    .toLowerCase();
  return (
    all.find((f) => f.toLowerCase() === clean) ??
    all.find(
      (f) =>
        clean.startsWith(f.toLowerCase()) || f.toLowerCase().startsWith(clean),
    ) ??
    all.find((f) => clean.includes(f.toLowerCase())) ??
    OTHER
  );
}

/** Sites that host every kind of content, so one bookmark there says nothing about the next. */
const MIXED =
  /(^|\.)(youtube\.com|youtu\.be|google\.com|reddit\.com|medium\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|amazon\.com|pinterest\.com|linkedin\.com|notion\.so|substack\.com|dev\.to|github\.com|wikipedia\.org|apple\.com|microsoft\.com)$/;

/** Once a (non-mixed) site has a folder, its other bookmarks follow without asking Gemma again. */
export function rememberable(domain: string): boolean {
  return !!domain && !MIXED.test(domain);
}

export { MAYBE, OTHER };
