import { useCallback, useEffect, useRef } from 'react';
import { useScopedRefresh } from '../useScopedRefresh';
import type { StorageHealth } from '@video-compressor/shared';
import { trackTeamPreviewsReady, trackTeamStorageAttention } from '../../analytics/service';
import { useTeam } from '../TeamContext';

/**
 * The one storage-health value the chip renders (011, FR-031). Re-read when
 * the space's realtime revision moves and every minute regardless, so a
 * dropped channel cannot freeze the chip on a state that ended. Analytics
 * fire on transitions only: one attention event per reason change, one
 * previews-ready event when preparing finishes.
 */
export interface StorageHealthClient {
  getStorageHealth?: (teamId: string, options?: { signal?: AbortSignal }) => Promise<StorageHealth>;
}

export function useStorageHealth(input: {
  teamId: string;
  client: StorageHealthClient;
  enabled?: boolean;
}): { health: StorageHealth | null; refresh: () => Promise<void>; staleSince: number | null } {
  const { teamId, client, enabled = true } = input;
  const { revision: generalRevision, storageRevision, accessRevision, activeTeam } = useTeam();
  const revision = storageRevision ?? generalRevision;
  const previous = useRef<StorageHealth | null>(null);
  const preparingSince = useRef<number | null>(null);
  const lastAttention = useRef<string | null>(null);

  useEffect(() => {
    previous.current = null;
    preparingSince.current = null;
    lastAttention.current = null;
  }, [teamId]);

  const observe = useCallback((next: StorageHealth) => {
    const before = previous.current;
    if (next.kind === 'attention') {
      if (lastAttention.current !== next.reason) {
        trackTeamStorageAttention({ reason: next.reason });
        lastAttention.current = next.reason;
      }
    } else {
      lastAttention.current = null;
    }
    if (next.kind === 'preparing') {
      if (preparingSince.current === null) preparingSince.current = Date.now();
    } else if (before?.kind === 'preparing' && preparingSince.current !== null) {
      trackTeamPreviewsReady({
        readyCount: before.ready,
        unavailableCount: 0,
        durationMs: Date.now() - preparingSince.current
      });
      preparingSince.current = null;
    }
    previous.current = next;
  }, []);

  const {
    value: health,
    error,
    lastLoadedAt,
    reload: refresh
  } = useScopedRefresh({
    scope: JSON.stringify([teamId, accessRevision, activeTeam?.permissions]),
    source: client,
    enabled: enabled && Boolean(client.getStorageHealth),
    revision,
    intervalMs: previous.current?.kind === 'indexing' ? 5_000 : 60_000,
    load: async signal => {
      const next = await client.getStorageHealth!(teamId, { signal });
      if (!signal.aborted) observe(next);
      return next;
    }
  });
  return {
    health,
    refresh,
    staleSince: error ? (lastLoadedAt ? Date.parse(lastLoadedAt) : Date.now()) : null
  };
}
