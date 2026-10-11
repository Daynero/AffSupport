/**
 * How the space matches typed text on the client (search rework, 2026-10).
 *
 * Files are searched by the server; tasks and accounts are already in memory
 * and were filtered with one plain substring test of the whole query. That
 * made "банер укр" miss a task called "Укр банер", and a query typed with the
 * wrong keyboard layout ("ghbdsn" for "привіт") miss everything. The three
 * lists now answer the same way:
 *
 * - the query is split into words, and every word has to be found — anywhere
 *   in the text, in any order (a word that starts a word of the text is the
 *   strong case, a substring the fallback; both count as a match);
 * - text is compared NFC-normalised and lower-cased, so a name that came from
 *   a Mac's decomposed file system matches the same letters typed here;
 * - when nothing at all matches, the caller can retry with the query converted
 *   between the English (QWERTY) and Ukrainian (ЙЦУКЕН) layouts.
 *
 * Pure functions only: no DOM, no storage, so the web and the agent can share
 * them and the tests need nothing to run.
 */

/** English QWERTY key → the letter the Ukrainian ЙЦУКЕН layout puts on it. */
const EN_TO_UK: Readonly<Record<string, string>> = {
  q: 'й',
  w: 'ц',
  e: 'у',
  r: 'к',
  t: 'е',
  y: 'н',
  u: 'г',
  i: 'ш',
  o: 'щ',
  p: 'з',
  '[': 'х',
  ']': 'ї',
  a: 'ф',
  s: 'і',
  d: 'в',
  f: 'а',
  g: 'п',
  h: 'р',
  j: 'о',
  k: 'л',
  l: 'д',
  ';': 'ж',
  "'": 'є',
  z: 'я',
  x: 'ч',
  c: 'с',
  v: 'м',
  b: 'и',
  n: 'т',
  m: 'ь',
  ',': 'б',
  '.': 'ю',
  '\\': 'ґ'
};

/**
 * The way back. Built from the table above, plus the letters a Russian layout
 * puts on the same keys — someone who switched to it by habit typed "ыуфкср"
 * for "search", and the fix is the same keys.
 */
const UK_TO_EN: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(EN_TO_UK).map(([en, uk]) => [uk, en])),
  ы: 's',
  э: "'",
  ъ: ']',
  ё: '`'
};

const LATIN_LETTER = /[a-z]/u;
const CYRILLIC_LETTER = /[\u0400-\u04ff]/u;

/** NFC, lower case, single spaces — the form every comparison here uses. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

/** How many letters (of either script) a query holds. */
export function countSearchLetters(value: string): number {
  let count = 0;
  for (const char of value.toLocaleLowerCase()) {
    if (LATIN_LETTER.test(char) || CYRILLIC_LETTER.test(char)) count += 1;
  }
  return count;
}

/**
 * The query as it would have come out on the other keyboard layout, or null
 * when converting changes nothing.
 *
 * The direction is decided by the script most of the letters are in: mostly
 * Latin is read as Ukrainian typed on an English layout, mostly Cyrillic as
 * English typed on a Ukrainian (or Russian) one. Characters the chosen table
 * does not know — digits, spaces, a dash — pass through unchanged.
 */
export function convertKeyboardLayout(value: string): string | null {
  const text = value.normalize('NFC').toLocaleLowerCase();
  let latin = 0;
  let cyrillic = 0;
  for (const char of text) {
    if (LATIN_LETTER.test(char)) latin += 1;
    else if (CYRILLIC_LETTER.test(char)) cyrillic += 1;
  }
  if (latin === 0 && cyrillic === 0) return null;
  const table = cyrillic > latin ? UK_TO_EN : EN_TO_UK;
  let converted = '';
  for (const char of text) converted += table[char] ?? char;
  return converted === text ? null : converted;
}

/** The distinct words of a query, normalised; empty for a blank query. */
export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (normalized === '') return [];
  return [...new Set(normalized.split(' '))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Characters that end a word inside a file or task name. */
const WORD_BREAK = '\\s_\\-.,;:()\\[\\]{}/\\\\«»"\'!?#№+';

/** Whether `term` starts a word of `text` (both already normalised). */
export function startsWord(text: string, term: string): boolean {
  if (term === '') return false;
  return new RegExp(`(^|[${WORD_BREAK}])${escapeRegExp(term)}`, 'u').test(text);
}

/**
 * Whether every word of the query is found in the text — in one of the given
 * fields, any order. A blank query matches everything.
 */
export function matchesSearchTerms(
  fields: string | ReadonlyArray<string | null | undefined>,
  terms: readonly string[]
): boolean {
  if (terms.length === 0) return true;
  const haystacks = (typeof fields === 'string' ? [fields] : fields)
    .filter((field): field is string => typeof field === 'string' && field !== '')
    .map(normalizeSearchText);
  if (haystacks.length === 0) return false;
  return terms.every(term => haystacks.some(text => startsWord(text, term) || text.includes(term)));
}

/** The query-level convenience: split, then match. */
export function matchesSearchQuery(
  fields: string | ReadonlyArray<string | null | undefined>,
  query: string
): boolean {
  return matchesSearchTerms(fields, searchTerms(query));
}

/**
 * Filters a list by a query the way every in-memory search in the space does,
 * including the second try on the other keyboard layout when the first one
 * finds nothing. `query` is what the caller should say it searched for: the
 * converted text when the second try is the one that answered.
 */
export function filterBySearchQuery<T>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => ReadonlyArray<string | null | undefined>
): { items: T[]; query: string; converted: boolean } {
  const terms = searchTerms(query);
  if (terms.length === 0) return { items: [...items], query, converted: false };
  const direct = items.filter(item => matchesSearchTerms(fieldsOf(item), terms));
  if (direct.length > 0 || countSearchLetters(query) < 3) {
    return { items: direct, query, converted: false };
  }
  const swapped = convertKeyboardLayout(query);
  if (!swapped) return { items: direct, query, converted: false };
  const swappedTerms = searchTerms(swapped);
  const fallback = items.filter(item => matchesSearchTerms(fieldsOf(item), swappedTerms));
  return fallback.length > 0
    ? { items: fallback, query: swapped, converted: true }
    : { items: direct, query, converted: false };
}

/**
 * Where the words of a query sit in a text, as `[start, end)` ranges over the
 * NFC form of that text, sorted and merged — what a result name is
 * highlighted by. A word is marked where it starts a word of the text; only
 * when it starts none is its first occurrence inside a word marked instead,
 * so "ban" marks the start of "Banner" and not the middle of "Urban banner".
 *
 * Returns no ranges when lower-casing would change the text's length (a few
 * scripts do), because the offsets would then point at the wrong letters.
 */
export function searchHitRanges(text: string, query: string): Array<[number, number]> {
  const shown = text.normalize('NFC');
  const lower = shown.toLocaleLowerCase();
  if (lower.length !== shown.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const term of searchTerms(query)) {
    const starts = [
      ...lower.matchAll(new RegExp(`(?<=^|[${WORD_BREAK}])${escapeRegExp(term)}`, 'gu'))
    ];
    if (starts.length > 0) {
      for (const match of starts) {
        const index = match.index ?? 0;
        ranges.push([index, index + term.length]);
      }
      continue;
    }
    const at = lower.indexOf(term);
    if (at >= 0) ranges.push([at, at + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
