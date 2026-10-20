import { Bookmark, MAYBE, OTHER } from "./bookmarks";

/** Small batches keep a small model focused (and fit easily in its memory). */
export const BATCH = 12;

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

export const FALLBACK_FOLDERS = [
  "Work",
  "Learning",
  "Shopping",
  "News & Reading",
  "Entertainment",
  "Personal",
];

/** Step 2: Gemma sorts a small numbered batch into the agreed folders. */
export function sortPrompt(batch: Bookmark[], folders: string[]): string {
  return [
    "Sort each bookmark into exactly one of these folders:",
    ...[...folders, OTHER].map((f) => `- ${f}`),
    "",
    "Bookmarks (title — website):",
    ...batch.map((b, i) => `${i + 1}. ${line(b)}`),
    "",
    'Reply with one line per bookmark, in the format "number: folder name". Use only the folder names above.',
  ].join("\n");
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
