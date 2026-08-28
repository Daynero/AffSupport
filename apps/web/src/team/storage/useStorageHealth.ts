import { useCallback, useEffect, useRef, useState } from 'react';
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
  getStorageHealth?: (teamId: string) => Promise<StorageHealth>;
}

const FALLBACK_INTERVAL_MS = 60_000;
const REVISION_DEBOUNCE_MS = 500;

export function useStorageHealth(input: {
  teamId: string;
  client: StorageHealthClient;
  enabled?: boolean;
}): { health: StorageHealth | null; refresh: () => Promise<void> } {
  const { teamId, client, enabled = true } = input;
  const { revision } = useTeam();
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const activeRef = useRef(true);
  const previous = useRef<StorageHealth | null>(null);
  const preparingSince = useRef<number | null>(null);
  const lastAttention = useRef<string | null>(null);

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

  const refresh = useCallback(async () => {
    if (!client.getStorageHealth) return;
    try {
      const next = await client.getStorageHealth(teamId);
      if (!activeRef.current) return;
      observe(next);
      setHealth(next);
    } catch {
      if (activeRef.current) setHealth(null);
    }
  }, [client, observe, teamId]);

  useEffect(() => {
    if (!enabled) {
      setHealth(null);
      return;
    }
    activeRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), FALLBACK_INTERVAL_MS);
    return () => {
      activeRef.current = false;
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || revision === 0) return;
    const timer = window.setTimeout(() => void refresh(), REVISION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, refresh, revision]);

  return { health, refresh };
}
