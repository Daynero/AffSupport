import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamRestitchDefaults } from '@video-compressor/shared';
import type { CatalogRegistryRow } from '../../api/team';
import { useBrowserRoute } from '../../lib/navigation';

/**
 * Whether re-stitching can run for this person in this space (production 2026-11-25).
 *
 * Re-stitching works out of the box: without saved settings, or with a slot left without
 * pictures, the server stands in Soty's standard pictures (migration 20261224170000). The one
 * case it cannot is a space with both the start and the end turned off — the effective settings
 * are then null (`missing`). Such a run used to start, freeze empty settings and wait «Готуємо
 * відео для заміни…» for ever; the manager now refuses it where it was pressed and shows the way to
 * the «Перезашивка» section. `unknown` (no reader, or the read failed) never blocks — the server
 * ends such a round itself (migration 20261224160000).
 */
export type RestitchSettingsState = 'unknown' | 'ready' | 'missing';

export type RestitchDefaultsReader = (
  teamId: string,
  options?: { signal?: AbortSignal }
) => Promise<TeamRestitchDefaults | null>;

export function useRestitchSettingsReady(teamId: string, read?: RestitchDefaultsReader) {
  // Settings open over the manager; closing them changes the address, and the answer is read again.
  const route = useBrowserRoute();
  const [state, setState] = useState<RestitchSettingsState>('unknown');
  const latest = useRef(0);
  useEffect(() => {
    if (!read) return;
    const controller = new AbortController();
    const ticket = ++latest.current;
    void read(teamId, { signal: controller.signal })
      .then(found => {
        if (!controller.signal.aborted && ticket === latest.current)
          setState(found ? 'ready' : 'missing');
      })
      .catch(() => {
        /* An unread answer stays what it was; the run re-checks. */
      });
    return () => controller.abort();
  }, [teamId, read, route]);
  /** A fresh answer right before an action, so a stale one never blocks or lets through. */
  const recheck = useCallback(async (): Promise<RestitchSettingsState> => {
    if (!read) return 'unknown';
    const ticket = ++latest.current;
    try {
      const next: RestitchSettingsState = (await read(teamId)) ? 'ready' : 'missing';
      if (ticket === latest.current) setState(next);
      return next;
    } catch {
      return 'unknown';
    }
  }, [teamId, read]);
  return { state, recheck };
}

/** The catalog's next update re-stitches its video. */
export function wantsRestitch(row: CatalogRegistryRow | undefined): boolean {
  return Boolean(row?.profile?.restitch);
}

/** The server refused or ended this catalog's round for want of re-stitch settings. */
export function restitchSettingsFailed(row: CatalogRegistryRow): boolean {
  return (
    row.lastUpdateError === 'RESTITCH_INVALID' ||
    row.videoGeneration?.waitReason === 'RESTITCH_INVALID'
  );
}
