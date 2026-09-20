import { useEffect, useState } from 'react';
import { teamApi } from '../../api/team';

/**
 * A file's note, shared by every surface that shows it (024).
 *
 * The details card reads it, and a row menu or a task tile can change it while the card is on
 * screen. One small store keyed by the file keeps them agreeing without a reload: a save anywhere
 * is the note everywhere.
 */

export interface MaterialNoteClient {
  getMaterialNote: (teamId: string, materialId: string) => Promise<string | null>;
  setMaterialNote: (teamId: string, materialId: string, note: string) => Promise<string | null>;
}

type Entry = { state: 'loading' } | { state: 'ready'; note: string | null } | { state: 'failed' };

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

const keyOf = (teamId: string, materialId: string) => `${teamId}:${materialId}`;

function put(key: string, entry: Entry) {
  entries.set(key, entry);
  listeners.get(key)?.forEach(listener => listener());
}

export function saveMaterialNote(
  teamId: string,
  materialId: string,
  note: string,
  client: MaterialNoteClient = teamApi
): Promise<string | null> {
  return client.setMaterialNote(teamId, materialId, note).then(saved => {
    put(keyOf(teamId, materialId), { state: 'ready', note: saved });
    return saved;
  });
}

/** Forgets every note read so far; for tests. */
export function resetMaterialNotes() {
  entries.clear();
}

export function useMaterialNote(
  teamId: string,
  materialId: string,
  {
    enabled = true,
    revision = 0,
    client = teamApi
  }: { enabled?: boolean; revision?: number; client?: MaterialNoteClient } = {}
): Entry {
  const key = keyOf(teamId, materialId);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!enabled || !materialId) return;
    const listener = () => bump(value => value + 1);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
    };
  }, [enabled, key, materialId]);

  useEffect(() => {
    if (!enabled || !materialId) return;
    // Read again when the space moves; what was already known stays on screen meanwhile.
    if (!entries.has(key)) put(key, { state: 'loading' });
    let active = true;
    void client
      .getMaterialNote(teamId, materialId)
      .then(note => {
        if (active) put(key, { state: 'ready', note });
      })
      .catch(() => {
        if (active && entries.get(key)?.state !== 'ready') put(key, { state: 'failed' });
      });
    return () => {
      active = false;
    };
  }, [client, enabled, key, materialId, revision, teamId]);

  return entries.get(key) ?? { state: 'loading' };
}
