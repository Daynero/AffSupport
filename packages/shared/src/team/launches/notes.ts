import { isRecord } from '../contract.js';
export const LAUNCH_NOTE_TITLE_MAX = 160;
export const LAUNCH_NOTE_TEXT_MAX = 8192;
export interface LaunchNote {
  id: string;
  title: string;
  text: string;
}
/** No note-count limit; the existing protected draft payload budget still applies. */
export function parseLaunchNotes(value: unknown): LaunchNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes: LaunchNote[] = [];
  const ids = new Set<string>();
  for (const row of value) {
    if (
      !isRecord(row) ||
      Object.keys(row).some(key => !['id', 'title', 'text'].includes(key)) ||
      typeof row.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(row.id) ||
      ids.has(row.id) ||
      typeof row.title !== 'string' ||
      Array.from(row.title).length > LAUNCH_NOTE_TITLE_MAX ||
      typeof row.text !== 'string' ||
      Array.from(row.text).length > LAUNCH_NOTE_TEXT_MAX ||
      (row.title + row.text).includes(String.fromCharCode(0))
    )
      return null;
    ids.add(row.id);
    notes.push({ id: row.id, title: row.title, text: row.text });
  }
  return notes;
}
export function launchNoteLabel(note: LaunchNote): string {
  if (note.title.trim()) return note.title.trim();
  const chars = Array.from(note.text.trim().replace(/\s+/gu, ' '));
  return chars.slice(0, 48).join('') + (chars.length > 48 ? '…' : '');
}
