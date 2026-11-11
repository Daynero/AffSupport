import { useEffect, useMemo } from 'react';
import { useScopedRefresh } from '../useScopedRefresh';
import {
  teamApi,
  type CatalogRegistryRow,
  type CatalogUpdaterState,
  type CatalogMutationOptions,
  type CatalogListSnapshot
} from '../../api/team';
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
/** A scheduled link this close to its time is followed like a running round. */
const PUBLICATION_NEAR_MS = 60_000;
/** Read just after a scheduled time, once the server's 10-second publication lane had a turn. */
const PUBLICATION_DUE_SETTLE_MS = 2_000;
const MAX_DUE_TIMER_MS = 6 * 60 * 60 * 1000;

export interface CatalogUpdaterClient {
  listCatalogManagerSnapshot?: (
    teamId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogListSnapshot<CatalogRegistryRow>>;
  listTeamProductCatalogSnapshot?: (
    teamId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogListSnapshot<CatalogRegistryRow>>;
  listCatalogUpdateProfileSnapshot?: (
    teamId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogListSnapshot<CatalogUpdateProfile>>;
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
    patch: CatalogUpdateProfilePatch,
    options?: CatalogMutationOptions
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
  const { value, error, lastLoadedAt, reload, reloadFresh, poll } = useRefreshing(
    teamId,
    async signal => {
      if (client.listCatalogManagerSnapshot)
        return client.listCatalogManagerSnapshot(teamId, { signal });
      const [catalogs, profiles] = await Promise.all([
        client.listTeamProductCatalogSnapshot?.(teamId, { signal }) ??
          client
            .listTeamProductCatalogs(teamId, { signal })
            .then(rows => ({ rows, invalidRowCount: 0 })),
        client.listCatalogUpdateProfileSnapshot?.(teamId, { signal }) ??
          (client.listCatalogUpdateProfiles?.(teamId, { signal }) ?? Promise.resolve([])).then(
            rows => ({ rows, invalidRowCount: 0 })
          )
      ]);
      const byId = new Map(profiles.rows.map(profile => [profile.catalogId, profile]));
      return {
        rows: catalogs.rows.map(row => ({
          ...row,
          profile: byId.get(row.catalogId) ?? row.profile
        })),
        invalidRowCount: catalogs.invalidRowCount + profiles.invalidRowCount
      };
    },
    enabled,
    client
  );
  const hasPendingUpdate =
    value?.rows.some(
      row =>
        row.updatePending || (row.profile?.restitch && row.profile.restitchStatus === 'preparing')
    ) ?? false;
  // A deferred link near or past its time, or waiting for its videos, changes within seconds:
  // follow it like a running round, and read once more the moment the earliest scheduled
  // time comes. «Посилання о 21:34» lingered ~56 s past its time, and a video count lagged
  // by up to a minute, on the one-minute floor alone (1.4.3 QA).
  const now = Date.now();
  const publicationDue = (value?.rows ?? [])
    .map(row => row.videoPublication)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map(entry => ({ due: Date.parse(entry.dueAt), waiting: entry.waitingForVideos }))
    .filter(entry => Number.isFinite(entry.due));
  const publicationActive = publicationDue.some(
    entry => entry.waiting || entry.due <= now + PUBLICATION_NEAR_MS
  );
  const nextDue = publicationDue
    .map(entry => entry.due)
    .filter(due => due > now)
    .reduce((soonest, due) => Math.min(soonest, due), Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!enabled || !(hasPendingUpdate || publicationActive)) return;
    const timer = window.setInterval(poll, ACTIVE_UPDATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, hasPendingUpdate, publicationActive, poll]);
  useEffect(() => {
    if (!enabled || !Number.isFinite(nextDue)) return;
    // Read when the earliest time comes within reach (that read starts the close follow)
    // and again just after it.
    const near = nextDue - PUBLICATION_NEAR_MS;
    const wait = (near > Date.now() ? near : nextDue + PUBLICATION_DUE_SETTLE_MS) - Date.now();
    // Far-off times are reached by the one-minute floor and later reads.
    if (wait > MAX_DUE_TIMER_MS) return;
    const timer = window.setTimeout(poll, Math.max(0, wait));
    return () => window.clearTimeout(timer);
    // Every read re-arms it: after the "near" read the same time still needs its after-read.
  }, [enabled, nextDue, poll, value]);
  return {
    rows: value?.rows ?? null,
    invalidRowCount: value?.invalidRowCount ?? 0,
    error,
    lastLoadedAt,
    reloadFresh,
    reload
  };
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
