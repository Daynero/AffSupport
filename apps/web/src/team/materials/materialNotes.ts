import { withReadDeadline } from '../readCoordinator';
import { useEffect, useState } from 'react';
import { teamApi } from '../../api/team';
import {
  privateCacheEpoch,
  privateClientId,
  privateCacheSuperseded,
  registerPrivateCache,
  usePrivateCacheEpoch
} from '../private-cache-scope';

/** A private note shared by surfaces in the same authenticated access scope. */
export interface MaterialNoteClient {
  getMaterialNote: (
    teamId: string,
    materialId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<string | null>;
  setMaterialNote: (teamId: string, materialId: string, note: string) => Promise<string | null>;
}
type Entry = { state: 'loading' } | { state: 'ready'; note: string | null } | { state: 'failed' };
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const pending = new Map<
  string,
  { revision: number; promise: Promise<void>; controller: AbortController }
>();
const versions = new Map<string, object>();
let generation = 0;
const keyOf = (teamId: string, materialId: string, client: MaterialNoteClient) =>
  JSON.stringify([privateCacheEpoch(), privateClientId(client), teamId, materialId]);
function put(key: string, entry: Entry) {
  entries.set(key, entry);
  while (entries.size > 200) {
    const oldest = entries.keys().next().value!;
    entries.delete(oldest);
    versions.delete(oldest);
  }
  listeners.get(key)?.forEach(listener => listener());
}
export function saveMaterialNote(
  teamId: string,
  materialId: string,
  note: string,
  client: MaterialNoteClient = teamApi
): Promise<string | null> {
  const key = keyOf(teamId, materialId, client);
  const epoch = privateCacheEpoch(),
    current = generation,
    version = {};
  versions.set(key, version);
  pending.get(key)?.controller.abort();
  pending.delete(key);
  return client.setMaterialNote(teamId, materialId, note).then(saved => {
    if (epoch !== privateCacheEpoch() || current !== generation) throw privateCacheSuperseded();
    if (versions.get(key) === version) put(key, { state: 'ready', note: saved });
    return saved;
  });
}
export function resetMaterialNotes() {
  generation += 1;
  entries.clear();
  for (const entry of pending.values()) entry.controller.abort();
  pending.clear();
  versions.clear();
}
registerPrivateCache(resetMaterialNotes);
export function useMaterialNote(
  teamId: string,
  materialId: string,
  {
    enabled = true,
    revision = 0,
    client = teamApi
  }: { enabled?: boolean; revision?: number; client?: MaterialNoteClient } = {}
): Entry {
  const epoch = usePrivateCacheEpoch();
  const key = keyOf(teamId, materialId, client);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled || !materialId) return;
    const listener = () => bump(value => value + 1);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) {
        listeners.delete(key);
        pending.get(key)?.controller.abort();
        pending.delete(key);
        versions.delete(key);
        if (entries.get(key)?.state === 'loading') entries.delete(key);
      }
    };
  }, [enabled, key, materialId]);
  useEffect(() => {
    if (!enabled || !materialId) return;
    if (pending.get(key)?.revision === revision) return;
    pending.get(key)?.controller.abort();
    if (!entries.has(key)) put(key, { state: 'loading' });
    const current = generation,
      version = {};
    versions.set(key, version);
    const owns = () =>
      epoch === privateCacheEpoch() && current === generation && versions.get(key) === version;
    const controller = new AbortController();
    const promise = withReadDeadline(signal => {
      if (!owns()) throw privateCacheSuperseded();
      return client.getMaterialNote(teamId, materialId, { signal });
    }, controller.signal)
      .then(note => {
        if (owns()) put(key, { state: 'ready', note });
      })
      .catch(() => {
        if (owns() && entries.get(key)?.state !== 'ready') put(key, { state: 'failed' });
      })
      .finally(() => {
        if (pending.get(key)?.promise === promise) pending.delete(key);
      });
    pending.set(key, { revision, promise, controller });
    while (pending.size > 200) {
      const oldest = pending.keys().next().value!;
      pending.get(oldest)?.controller.abort();
      pending.delete(oldest);
      versions.delete(oldest);
    }
  }, [client, enabled, key, materialId, revision, teamId, epoch]);
  return enabled ? (entries.get(key) ?? { state: 'loading' }) : { state: 'loading' };
}
