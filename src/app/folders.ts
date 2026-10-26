/**
 * Folder paths. A folder is either top-level ("Recipes") or one level down ("Recipes › Dinners").
 * The folder list is kept in display order with each folder's subfolders right after it.
 */
import { MAYBE, OTHER } from "./bookmarks";

export const SEP = " › ";

export const parentOf = (p: string) =>
  p.includes(SEP) ? p.slice(0, p.indexOf(SEP)) : "";
export const labelOf = (p: string) =>
  p.includes(SEP) ? p.slice(p.indexOf(SEP) + SEP.length) : p;
export const topOf = (p: string) => parentOf(p) || p;
export const isSub = (p: string) => p.includes(SEP);
export const join = (parent: string, label: string) =>
  parent ? parent + SEP + label : label;
export const special = (p: string) => p === OTHER || p === MAYBE;

/** Put the list back in shape: unique, parents present, each parent followed by its own subfolders. */
export function normalizeFolders(list: string[]): string[] {
  const tops: string[] = [];
  const subs = new Map<string, string[]>();
  for (const p of list) {
    if (special(p)) continue;
    const top = topOf(p);
    if (!tops.includes(top)) tops.push(top);
    if (isSub(p)) {
      const kids = subs.get(top) ?? [];
      if (!kids.includes(p)) kids.push(p);
      subs.set(top, kids);
    }
  }
  return tops.flatMap((t) => [t, ...(subs.get(t) ?? [])]);
}

export const childrenOf = (list: string[], top: string) =>
  list.filter((p) => parentOf(p) === top);

/** Rename one folder (its label only). Subfolders follow a renamed parent. */
export function renamePath(path: string, label: string): (p: string) => string {
  const next = join(parentOf(path), label);
  return (p) =>
    p === path
      ? next
      : p.startsWith(path + SEP)
        ? next + p.slice(path.length)
        : p;
}

/** Swap a folder with its neighbor among its siblings (top-level folders move with their subfolders). */
export function nudge(list: string[], path: string, dir: -1 | 1): string[] {
  const parent = parentOf(path);
  const sibs = parent
    ? childrenOf(list, parent)
    : list.filter((p) => !isSub(p));
  const i = sibs.indexOf(path),
    j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return list;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  return parent
    ? list
        .filter((p) => parentOf(p) !== parent)
        .flatMap((p) => (p === parent ? [p, ...sibs] : [p]))
    : normalizeFolders(sibs.flatMap((t) => [t, ...childrenOf(list, t)]));
}

/** Move a top-level folder (and its subfolders) before or after another. */
export function placeTop(
  list: string[],
  name: string,
  target: string,
): string[] {
  const tops = list.filter((p) => !isSub(p));
  const from = tops.indexOf(name),
    to = tops.indexOf(target);
  if (from < 0 || to < 0 || from === to) return list;
  const rest = tops.filter((t) => t !== name);
  rest.splice(rest.indexOf(target) + (from < to ? 1 : 0), 0, name);
  return rest.flatMap((t) => [t, ...childrenOf(list, t)]);
}

/** Browser root folders, which aren't "your" folders. */
const ROOTS =
  /^(bookmarks bar|bookmarks toolbar|bookmarks menu|other bookmarks|mobile bookmarks|favorites bar|favourites bar|other favorites|other favourites|favorites|mobile favorites)$/i;

/**
 * Where a bookmark lives now, as a folder path to keep (top two levels under the browser's own roots).
 * '' means it's loose in the Bookmarks bar or Other bookmarks, so it needs sorting.
 */
export function keptPath(oldPath: string, fromBrowser = false): string {
  const parts = oldPath
    .split(" / ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length && (fromBrowser || ROOTS.test(parts[0]))) parts.shift(); // the browser's own root (any language)
  const keep = parts
    .slice(0, 2)
    .map((s) => s.replace(/\s*›\s*/g, " - ").slice(0, 28))
    .filter((s) => s && !special(s));
  return keep.length ? keep.join(SEP) : "";
}
