/** Everything the app owns: reading, de-duplicating and writing bookmarks. Gemma never touches a URL. */

export interface Bookmark {
  id: number;
  chromeId?: string; // extension mode: the browser's own bookmark id
  title: string;
  url: string;
  domain: string;
  addDate?: string; // seconds since epoch, as browsers export it
  icon?: string; // data: favicon from the export, if any (never fetched from the web)
  oldPath: string; // the folder it lived in before, e.g. "Bookmarks bar / Recipes"
  folder: string; // where Bookmark Buddy put it
  why?: string; // short reason for rule-based moves
  deleted?: boolean; // the person chose to delete it (left out of the export / removed on Apply)
  pinned?: boolean; // already in one of the person's own folders they chose to keep, so it isn't re-sorted
}

export const MAYBE = "Maybe delete?";
const SEP = " › "; // folder › subfolder (see folders.ts)
export const OTHER = "Other";

/** Parse the standard "Netscape bookmark file" that Chrome, Edge, Firefox and Safari all export. */
export function parseBookmarks(html: string): Bookmark[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: Bookmark[] = [];
  const walk = (dl: Element, path: string[]) => {
    for (const dt of Array.from(dl.children)) {
      if (dt.tagName !== "DT") continue;
      const a = dt.querySelector(":scope > a");
      const h3 = dt.querySelector(":scope > h3");
      if (a) {
        const url = a.getAttribute("href") ?? "";
        if (!/^https?:\/\//i.test(url)) continue; // skip javascript:, place:, etc. (kept out of sorting, listed in summary)
        out.push({
          id: out.length,
          title: (a.textContent ?? "").trim() || url,
          url,
          domain: domainOf(url),
          addDate: a.getAttribute("add_date") ?? undefined,
          icon: a.getAttribute("icon")?.startsWith("data:")
            ? a.getAttribute("icon")!
            : undefined,
          oldPath: path.join(" / "),
          folder: "",
        });
      } else if (h3) {
        // A folder's <DL> is either inside its <DT> or the next sibling (browsers differ).
        const inner =
          dt.querySelector(":scope > dl") ??
          (dt.nextElementSibling?.tagName === "DL"
            ? dt.nextElementSibling
            : null);
        if (inner) walk(inner, [...path, (h3.textContent ?? "").trim()]);
      }
    }
  };
  const root = doc.querySelector("dl");
  if (root) walk(root, []);
  return out;
}

/** Count links the parser skipped (bookmarklets and browser-internal links). */
export function countSkipped(html: string): number {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("a")).filter(
    (a) => !/^https?:\/\//i.test(a.getAttribute("href") ?? ""),
  ).length;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|ref_|igshid|si$|spm$|_hs)/i;

/** Two links are "the same" if they only differ by http/https, www, a trailing slash, #hash or tracking codes. */
export function normalize(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const q = params.length ? "?" + new URLSearchParams(params).toString() : "";
    return (
      u.hostname.replace(/^www\./, "") +
      u.pathname.replace(/\/+$/, "") +
      q
    ).toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Rules the app applies before Gemma sees anything. Nothing is ever deleted:
 * extras go to "Maybe delete?" with a reason, so the person decides.
 */
export function applyRules(list: Bookmark[]): {
  duplicates: number;
  flagged: number;
} {
  const seen = new Map<string, Bookmark>();
  let duplicates = 0,
    flagged = 0;
  for (const b of list) {
    const key = normalize(b.url);
    const first = seen.get(key);
    if (first) {
      b.folder = MAYBE;
      b.why = `Duplicate of “${short(first.title)}”`;
      duplicates++;
      continue;
    }
    seen.set(key, b);
    if (
      /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(b.domain) ||
      /\.(local|test)$/.test(b.domain)
    ) {
      b.folder = MAYBE;
      b.why = "Local dev link, probably not useful anymore";
      flagged++;
    }
  }
  return { duplicates, flagged };
}

const short = (s: string) => (s.length > 40 ? s.slice(0, 39) + "…" : s);

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Write a standard bookmarks file any browser can import. Every bookmark goes in; nothing is dropped. */
export function exportBookmarks(
  list: Bookmark[],
  folders: string[],
  rootName: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const order = [
    ...folders.filter((f) => f !== MAYBE && f !== OTHER),
    OTHER,
    MAYBE,
  ];
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file. Made with Bookmark Buddy. -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
    `    <DT><H3 ADD_DATE="${now}">${esc(rootName)}</H3>`,
    "    <DL><p>",
  ];
  const link = (b: Bookmark, pad: string) => {
    const attrs = [
      `HREF="${esc(b.url)}"`,
      b.addDate ? `ADD_DATE="${esc(b.addDate)}"` : "",
      b.icon ? `ICON="${esc(b.icon)}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`${pad}<DT><A ${attrs}>${esc(b.title)}</A>`);
  };
  const itemsIn = (f: string) =>
    list.filter((b) => !b.deleted && (b.folder || OTHER) === f);
  const hasAny = (f: string) =>
    list.some(
      (b) =>
        !b.deleted &&
        ((b.folder || OTHER) === f || (b.folder ?? "").startsWith(f + SEP)),
    );
  for (const f of order.filter((x) => !x.includes(SEP))) {
    if (!hasAny(f)) continue;
    lines.push(
      `        <DT><H3 ADD_DATE="${now}">${esc(f)}</H3>`,
      "        <DL><p>",
    );
    for (const b of itemsIn(f)) link(b, "            ");
    for (const sub of order.filter((x) => x.startsWith(f + SEP))) {
      const items = itemsIn(sub);
      if (!items.length) continue;
      lines.push(
        `            <DT><H3 ADD_DATE="${now}">${esc(sub.slice(f.length + SEP.length))}</H3>`,
        "            <DL><p>",
      );
      for (const b of items) link(b, "                ");
      lines.push("            </DL><p>");
    }
    lines.push("        </DL><p>");
  }
  lines.push("    </DL><p>", "</DL><p>");
  return lines.join("\n");
}
