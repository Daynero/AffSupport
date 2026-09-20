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
