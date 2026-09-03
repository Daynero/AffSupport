import path from 'node:path';

/**
 * File types whose contents can reference assets and therefore need rewriting
 * once an asset's extension changes (e.g. `hero.jpg` → `hero.webp`).
 */
export const REWRITABLE_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs']);

export function isRewritableFile(relPath: string): boolean {
  return REWRITABLE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/**
 * Any local reference we might have to update ends in one of these media
 * extensions. Scanning broadly and only rewriting tokens that resolve to a
 * genuinely renamed asset keeps the pass safe: unrelated strings, external
 * URLs and untouched files never match the rename map.
 */
const TOKEN_PATTERN =
  /[^\s'"()<>,`]*\.(?:jpe?g|png|webp|gif|svg|mp4|mov|m4v|mkv|webm|avi|mpe?g|mts|m2ts)(?:[?#][^\s'"()<>,`]*)?/gi;

/** A scheme (`http:`, `data:`, `blob:`, `mailto:` …) or protocol-relative URL. */
const EXTERNAL_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

/**
 * A mapping of old → new asset paths, both relative to the landing root and
 * expressed with POSIX separators and their real (decoded) file names.
 */
export type RenameMap = Map<string, string>;

interface ResolvedLookup {
  exact: RenameMap;
  lower: Map<string, string>;
}

function buildLookup(renames: RenameMap): ResolvedLookup {
  const lower = new Map<string, string>();
  for (const [from, to] of renames) lower.set(from.toLowerCase(), to);
  return { exact: renames, lower };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves a reference token (as written in a file) to a normalized POSIX path
 * relative to the landing root, or null when it points outside the landing or
 * cannot be resolved locally.
 */
export function resolveReference(fileRelPath: string, tokenPath: string): string | null {
  const decoded = safeDecode(tokenPath);
  const fileDir = path.posix.dirname(toPosix(fileRelPath));
  const joined = decoded.startsWith('/')
    ? decoded.slice(1)
    : path.posix.join(fileDir === '.' ? '' : fileDir, decoded);
  const normalized = path.posix.normalize(joined);
  if (normalized.startsWith('../') || normalized === '..') return null;
  return normalized.replace(/^\.\//, '');
}

function lookupRename(lookup: ResolvedLookup, resolved: string): string | null {
  return lookup.exact.get(resolved) ?? lookup.lower.get(resolved.toLowerCase()) ?? null;
}

/** Splits a matched token into its path and its `?query`/`#hash` suffix. */
function splitSuffix(token: string): { pathPart: string; suffix: string } {
  const marker = token.search(/[?#]/);
  return marker === -1
    ? { pathPart: token, suffix: '' }
    : { pathPart: token.slice(0, marker), suffix: token.slice(marker) };
}

/**
 * Rewrites every local asset reference in a file's text according to the rename
 * map. Query strings and hash fragments are preserved, external/data/blob URLs
 * are left untouched, and relative/`../` paths keep their exact form: only the
 * final segment is replaced.
 *
 * It used to replace only the extension, which was all a `.jpg` → `.webp` change
 * needed. Renumbering the media changes the name as well, and a reference left
 * pointing at `hero.webp` when the file is now `img3.webp` is a landing with a
 * hole in it. The prefix a file wrote — `./`, `../../assets/`, a leading `/` —
 * is kept exactly as it was, because that is what makes the reference resolve
 * from where it is written.
 */
export function rewriteReferences(
  text: string,
  fileRelPath: string,
  renames: RenameMap
): { text: string; count: number } {
  if (!renames.size) return { text, count: 0 };
  const lookup = buildLookup(renames);
  let count = 0;
  const next = text.replace(TOKEN_PATTERN, match => {
    const { pathPart, suffix } = splitSuffix(match);
    if (EXTERNAL_PATTERN.test(pathPart)) return match;
    const resolved = resolveReference(fileRelPath, pathPart);
    if (!resolved) return match;
    const target = lookupRename(lookup, resolved);
    if (!target) return match;
    // Only the last segment, and only when the file stayed where it was: a rename that also
    // moved the file would need every prefix recomputed per referring file, and nothing here
    // produces one.
    if (path.posix.dirname(target) !== path.posix.dirname(resolved)) return match;
    // Written as it was written. A file that spells its reference percent-encoded gets a
    // percent-encoded replacement; one that spells it plainly gets a plain one. Swapping only
    // the extension used to preserve this for free.
    const written = /[^/\\]+$/u.exec(pathPart)?.[0] ?? '';
    const basename = path.posix.basename(target);
    const rewrittenPath = pathPart.replace(
      /[^/\\]+$/u,
      safeDecode(written) === written ? basename : encodeURIComponent(basename)
    );
    if (rewrittenPath === pathPart) return match;
    count += 1;
    return `${rewrittenPath}${suffix}`;
  });
  return { text: next, count };
}

export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
