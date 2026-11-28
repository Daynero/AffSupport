import { useEffect, useRef, useState } from 'react';
import { isR2Space } from '../../api/space-storage';

/**
 * 057 (FR-040, R7): an R2 space's changes, as `team_space_storage_signals` announces them on
 * the space's one Realtime channel (`useTeamRealtime`). A row is written in the same
 * transaction as the change it reports, so a signal is a fact that has happened, not a hint
 * to go and look: the folder it names is read again, and nothing else is.
 *
 * - `content`: a folder's contents changed (an upload committed, a rename, a move, a delete);
 * - `derivative`: a preview or a tile became ready for files in that folder;
 * - `usage`: the space's storage use changed.
 *
 * A folder of null means "somewhere in the space": every folder on screen is read again.
 */
export type SpaceStorageSignalKind = 'content' | 'usage' | 'derivative';

export interface SpaceStorageSignal {
  teamId: string;
  kind: SpaceStorageSignalKind;
  folderId: string | null;
  revision: number | null;
}

const KINDS: readonly string[] = ['content', 'usage', 'derivative'];

/** A Realtime row, or null when it is not a signal this build understands. */
export function parseSpaceStorageSignal(value: unknown): SpaceStorageSignal | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const teamId = row.team_id ?? row.teamId;
  const folderId = row.folder_id ?? row.folderId ?? null;
  const revision = row.revision ?? null;
  if (typeof teamId !== 'string' || !KINDS.includes(row.kind as string)) return null;
  if (folderId !== null && typeof folderId !== 'string') return null;
  const numeric =
    typeof revision === 'number'
      ? revision
      : typeof revision === 'string' && /^\d+$/.test(revision)
        ? Number(revision)
        : null;
  return {
    teamId,
    kind: row.kind as SpaceStorageSignalKind,
    folderId,
    revision: numeric
  };
}

type Listener = (signal: SpaceStorageSignal) => void;
const listeners = new Map<string, Set<Listener>>();

export function publishSpaceStorageSignal(signal: SpaceStorageSignal): void {
  for (const listener of [...(listeners.get(signal.teamId) ?? [])]) {
    try {
      listener(signal);
    } catch {
      // One screen's failure to follow a signal must not keep it from the others.
    }
  }
}

export function subscribeSpaceStorageSignals(teamId: string, listener: Listener): () => void {
  let set = listeners.get(teamId);
  if (!set) {
    set = new Set();
    listeners.set(teamId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(teamId);
  };
}

/** Follows a space's signals while `enabled`; the latest handler is always the one called. */
export function useSpaceStorageSignals(
  teamId: string,
  enabled: boolean,
  handler: (signal: SpaceStorageSignal) => void
): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return subscribeSpaceStorageSignals(teamId, signal => latest.current(signal));
  }, [teamId, enabled]);
}

/**
 * Rises with every `usage` signal of the space — what a storage-use display reads again on.
 * Zero for a Drive space, which has no such signals.
 */
export function useSpaceUsageRevision(teamId: string, enabled = true): number {
  const [revision, setRevision] = useState(0);
  useSpaceStorageSignals(teamId, enabled, signal => {
    if (signal.kind === 'usage') setRevision(value => value + 1);
  });
  return revision;
}

/**
 * Whether a space keeps its files on R2: what its snapshot says, else what this client has
 * been told. Unknown is Drive, so a Drive space never takes a path written for R2.
 */
export function spaceOnR2(
  teamId: string | null | undefined,
  snapshot?: { storageBackend?: 'drive' | 'r2' } | null
): boolean {
  if (!teamId) return false;
  return snapshot?.storageBackend === 'r2' || isR2Space(teamId);
}
