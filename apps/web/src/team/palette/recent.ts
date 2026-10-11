/**
 * What was opened lately, per space, in this browser (024).
 *
 * A buyer goes back to the same one to three tasks and a handful of files all day; the palette
 * opened on an empty field that said "start typing". Now an empty field lists the last things
 * opened, and Enter goes back to the first. Kept in localStorage: a convenience, never a record.
 */

export type RecentKind = 'task' | 'material' | 'folder' | 'account';

export interface RecentEntry {
  kind: RecentKind;
  id: string;
  name: string;
  /** For a file: its folder's Drive id, so it opens where it lives. */
  parentFolderId?: string | null;
  /** For a folder: its Drive id. */
  driveFileId?: string;
}

const LIMIT = 8;
const keyOf = (teamId: string) => `soty.palette.recent.${teamId}`;

function isEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    (entry.kind === 'task' ||
      entry.kind === 'material' ||
      entry.kind === 'folder' ||
      entry.kind === 'account')
  );
}

export function readRecent(teamId: string): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(keyOf(teamId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(teamId: string, entry: RecentEntry): void {
  try {
    const next = [
      entry,
      ...readRecent(teamId).filter(item => !(item.kind === entry.kind && item.id === entry.id))
    ].slice(0, LIMIT);
    localStorage.setItem(keyOf(teamId), JSON.stringify(next));
  } catch {
    // Storage refused (a private window): the palette simply has nothing recent to offer.
  }
}

/*
 * What was searched for lately, per space, in this browser (search rework, 2026-10).
 *
 * The same convenience as the list above, for the other half of coming back: a buyer types
 * "кето укр" a dozen times a day. One store for the explorer's search field and the palette, so a
 * query committed in either is offered by both. A query is kept when it was *used* — a result
 * opened from it, Enter pressed, or it sat answered for a moment — never per keystroke, which
 * would fill the list with "ке", "кет", "кето".
 */

/** Where a remembered search looked. */
export type RecentQueryScope = 'space' | 'folder';

export interface RecentQuery {
  /** As typed, with the spacing tidied; case is kept, because it is what the person wrote. */
  query: string;
  scope: RecentQueryScope;
  /** The explorer's kind filter at the time, when one was set. */
  kinds?: string[];
  /** When it was last used, epoch milliseconds. */
  at: number;
}

export const RECENT_QUERY_LIMIT = 10;
/** Shorter than this is a keystroke, not a query. */
export const RECENT_QUERY_MIN_LENGTH = 2;
const queriesKeyOf = (teamId: string) => `soty.search.recent.${teamId}`;

/** The text a query is told apart by: two that differ only in case or spacing are one. */
export function recentQueryKey(query: string): string {
  return query.normalize('NFC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function tidyQuery(query: string): string {
  return query.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function isRecentQuery(value: unknown): value is RecentQuery {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.query === 'string' &&
    tidyQuery(entry.query).length >= RECENT_QUERY_MIN_LENGTH &&
    (entry.scope === 'space' || entry.scope === 'folder') &&
    (entry.kinds === undefined ||
      (Array.isArray(entry.kinds) && entry.kinds.every(kind => typeof kind === 'string'))) &&
    typeof entry.at === 'number'
  );
}

export function readRecentQueries(teamId: string): RecentQuery[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(queriesKeyOf(teamId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const kept: RecentQuery[] = [];
    for (const entry of parsed) {
      if (!isRecentQuery(entry)) continue;
      const key = recentQueryKey(entry.query);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(entry);
    }
    return kept.slice(0, RECENT_QUERY_LIMIT);
  } catch {
    return [];
  }
}

function writeRecentQueries(teamId: string, entries: RecentQuery[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(queriesKeyOf(teamId));
    else localStorage.setItem(queriesKeyOf(teamId), JSON.stringify(entries));
  } catch {
    // Storage refused (a private window): searching works, it is just not remembered.
  }
}

/**
 * Puts a query at the top of the list — moving it there if it was already in it — and returns
 * the list as it now stands. Blank and one-letter queries are not remembered.
 */
export function rememberQuery(
  teamId: string,
  input: { query: string; scope?: RecentQueryScope; kinds?: readonly string[] },
  now: number = Date.now()
): RecentQuery[] {
  const query = tidyQuery(input.query);
  const current = readRecentQueries(teamId);
  if (query.length < RECENT_QUERY_MIN_LENGTH) return current;
  const key = recentQueryKey(query);
  const entry: RecentQuery = {
    query,
    scope: input.scope ?? 'space',
    ...(input.kinds && input.kinds.length > 0 ? { kinds: [...input.kinds] } : {}),
    at: now
  };
  const next = [entry, ...current.filter(item => recentQueryKey(item.query) !== key)].slice(
    0,
    RECENT_QUERY_LIMIT
  );
  writeRecentQueries(teamId, next);
  return next;
}

/** Takes one query off the list; returns what is left. */
export function forgetQuery(teamId: string, query: string): RecentQuery[] {
  const key = recentQueryKey(query);
  const next = readRecentQueries(teamId).filter(item => recentQueryKey(item.query) !== key);
  writeRecentQueries(teamId, next);
  return next;
}

export function clearRecentQueries(teamId: string): void {
  writeRecentQueries(teamId, []);
}
