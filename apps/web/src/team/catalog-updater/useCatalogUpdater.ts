import { useEffect, useMemo } from 'react';
import { useScopedRefresh } from '../useScopedRefresh';
import { teamApi, type CatalogRegistryRow, type CatalogUpdaterState } from '../../api/team';
import type { CatalogUpdateProfile, CatalogUpdateProfilePatch } from '@video-compressor/shared';
import { useTeam } from '../TeamContext';

/**
 * The space's catalog updater and its catalogs, as the chip and the dialog read them (023).
 *
 * Read on mount, again shortly after the space's realtime revision moves (a round opened, a sheet
 * updated, someone saved or stopped), and once a minute as a floor. The server's clock travels with
 * the state so a countdown on a computer whose clock is off still reaches zero with the server.
 */

const FALLBACK_POLL_MS = 60_000;
const ACTIVE_UPDATE_POLL_MS = 5_000;

export interface CatalogUpdaterClient {
  getCatalogUpdater: (
    teamId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogUpdaterState>;
  listTeamProductCatalogs: (
    teamId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogRegistryRow[]>;
  listCatalogUpdateProfiles?: (
    teamId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogUpdateProfile[]>;
  patchCatalogUpdateProfile?: (
    teamId: string,
    catalogId: string,
    expectedVersion: number,
    patch: CatalogUpdateProfilePatch
  ) => Promise<CatalogUpdateProfile>;
}

const defaultClient: CatalogUpdaterClient = teamApi;

function useRefreshing<T>(
  scope: string,
  load: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  source: CatalogUpdaterClient
) {
  const { revision: generalRevision, updaterRevision, accessRevision, activeTeam } = useTeam();
  const revision = updaterRevision ?? generalRevision;
  return useScopedRefresh({
    scope: JSON.stringify([scope, accessRevision, activeTeam?.permissions]),
    load,
    source,
    enabled,
    revision,
    intervalMs: FALLBACK_POLL_MS
  });
}

export function useCatalogUpdater(teamId: string, client: CatalogUpdaterClient = defaultClient) {
  const { value, error, reload, poll } = useRefreshing(
    teamId,
    signal => client.getCatalogUpdater(teamId, { signal }),
    true,
    client
  );
  // Server time minus local time when the state was read; applied to every countdown tick.
  useEffect(() => {
    if (!value?.activeCount) return;
    const timer = window.setInterval(poll, ACTIVE_UPDATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [value?.activeCount, poll]);
  const offsetMs = useMemo(
    () => (value ? Date.parse(value.serverNow) - Date.now() : 0),
    // Recomputed per read: a state object is a new read.
    [value]
  );
  return { state: value, error, reload, offsetMs };
}

export function useCatalogRegistry(
  teamId: string,
  enabled: boolean,
  client: CatalogUpdaterClient = defaultClient
) {
  const { value, error, lastLoadedAt, reload, poll } = useRefreshing(
    teamId,
    async signal => {
      const [rows, profiles] = await Promise.all([
        client.listTeamProductCatalogs(teamId, { signal }),
        client.listCatalogUpdateProfiles?.(teamId, { signal }) ?? Promise.resolve([])
      ]);
      const byId = new Map(profiles.map(profile => [profile.catalogId, profile]));
      return rows.map(row => ({ ...row, profile: byId.get(row.catalogId) ?? row.profile }));
    },
    enabled,
    client
  );
  const hasPendingUpdate =
    value?.some(
      row =>
        row.updatePending || (row.profile?.restitch && row.profile.restitchStatus === 'preparing')
    ) ?? false;
  useEffect(() => {
    if (!enabled || !hasPendingUpdate) return;
    const timer = window.setInterval(poll, ACTIVE_UPDATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, hasPendingUpdate, poll]);
  return { rows: value, error, lastLoadedAt, reload };
}

/** Matches a search against the video's and the sheet's names, ignoring case and outer spaces. */
export function filterCatalogRows(
  rows: readonly CatalogRegistryRow[],
  query: string
): CatalogRegistryRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    row =>
      row.videoName.toLocaleLowerCase().includes(needle) ||
      row.name.toLocaleLowerCase().includes(needle)
  );
}
