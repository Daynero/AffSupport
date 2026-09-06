/**
 * The files an operating system leaves behind, which nobody put there on
 * purpose and nobody wants to see: `.DS_Store` beside a creative, a stray
 * `_organize_log.json`. They are real rows in the catalogue — the index reads
 * the drive faithfully — but showing them in a creative library is the kind of
 * thing a paying person screenshots.
 *
 * Hidden here rather than dropped from the index: they are still on the drive,
 * and a future need for them is a query away.
 */
const HOUSEKEEPING_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '_organize_log.json']);

export function isHousekeepingFile(name: string): boolean {
  return HOUSEKEEPING_NAMES.has(name.trim().toLocaleLowerCase());
}
