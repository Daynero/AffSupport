/** The most placeholder rows or tiles drawn, however large the folder: a screenful, not a wall. */
const MOST = 12;

/**
 * How many placeholders stand in for a folder on its way (owner, 25.11).
 *
 * The tree already counts what each folder holds; the list drew a fixed handful of bright bars
 * over every folder regardless, so a folder of one file flashed four rows and one of twenty-six
 * flashed four too. With a count in hand the placeholder is that many (never more than a
 * screenful), an empty folder draws none, and only an uncounted folder falls back to the old
 * handful.
 */
export function placeholderCount(expected: number | null | undefined, fallback: number): number {
  if (expected === null || expected === undefined || !Number.isFinite(expected)) return fallback;
  return Math.max(0, Math.min(MOST, Math.trunc(expected)));
}
