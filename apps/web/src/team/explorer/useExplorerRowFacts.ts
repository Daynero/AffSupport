import { useEffect, useState } from 'react';
import { usablePrep } from '@video-compressor/shared';
import type { TeamAnalyticsStorage, TeamMaterialRow } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import type { ExplorerShellClient } from './ExplorerShell';

/*
 * Two facts the row menus read, out of `ExplorerShell` (070, FR-001). Two hooks rather than
 * one, so the shell calls them where their effects always ran — one before the poster frames,
 * one after.
 */

export function usePreparedIds(teamId: string, rows: TeamMaterialRow[]): ReadonlySet<string> {
  /**
   * Which of the videos in view have already been looked at.
   *
   * One read for the whole page rather than one per row, and re-read when the page changes so
   * a material that was just prepared elsewhere stops claiming otherwise (FR-021).
   */
  const [preparedIds, setPreparedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const videos = rows.filter(row => row.kind === 'video');
    if (videos.length === 0) {
      setPreparedIds(new Set());
      return;
    }
    let active = true;
    void teamApi
      .getMaterialRestitchPrep(
        teamId,
        videos.map(row => row.id)
      )
      .then(found => {
        if (!active) return;
        const ready = new Set<string>();
        for (const row of videos) {
          const prep = usablePrep(found.get(row.id) ?? null, row.driveVersion);
          if (prep && !prep.unsupportedReason) ready.add(row.id);
        }
        setPreparedIds(ready);
      })
      .catch(() => {
        // Not knowing is the same as not prepared: the menu simply says nothing.
      });
    return () => {
      active = false;
    };
  }, [teamId, rows]);
  return preparedIds;
}

/** Which kind of storage the space is on, for the actions that differ by it. */
export function useStorageKind(
  client: ExplorerShellClient,
  teamId: string
): TeamAnalyticsStorage | null {
  const [storageKind, setStorageKind] = useState<TeamAnalyticsStorage | null>(null);
  useEffect(() => {
    let active = true;
    if (!client.getConnectionStatus) return;
    void client
      .getConnectionStatus(teamId)
      .then(status => {
        if (active) setStorageKind(status.driveKind ?? null);
      })
      .catch(() => {
        if (active) setStorageKind(null);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);
  return storageKind;
}
