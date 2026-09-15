import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { teamApi, type CatalogRegistryRow, type CatalogUpdaterState } from '../../api/team';
import { useTeam } from '../TeamContext';

/**
 * The space's catalog updater and its catalogs, as the chip and the dialog read them (023).
 *
 * Read on mount, again shortly after the space's realtime revision moves (a round opened, a sheet
 * updated, someone saved or stopped), and once a minute as a floor. The server's clock travels with
 * the state so a countdown on a computer whose clock is off still reaches zero with the server.
 */

const FALLBACK_POLL_MS = 60_000;
const REVISION_DEBOUNCE_MS = 500;

export interface CatalogUpdaterClient {
  getCatalogUpdater: (teamId: string) => Promise<CatalogUpdaterState>;
  listTeamProductCatalogs: (teamId: string) => Promise<CatalogRegistryRow[]>;
}

const defaultClient: CatalogUpdaterClient = teamApi;

function useRefreshing<T>(
  load: () => Promise<T>,
  enabled: boolean
): { value: T | null; error: boolean; reload: () => void } {
  const { revision } = useTeam();
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const timer = window.setTimeout(
      () => {
        void loadRef
          .current()
          .then(next => {
            if (!active) return;
            setValue(next);
            setError(false);
          })
          .catch(() => {
            if (active) setError(true);
          });
      },
      tick === 0 && revision === 0 ? 0 : REVISION_DEBOUNCE_MS
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled, revision, tick]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setTick(value => value + 1), FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const reload = useCallback(() => setTick(value => value + 1), []);
  return { value, error, reload };
}

export function useCatalogUpdater(teamId: string, client: CatalogUpdaterClient = defaultClient) {
  const { value, error, reload } = useRefreshing(() => client.getCatalogUpdater(teamId), true);
  // Server time minus local time when the state was read; applied to every countdown tick.
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
  const { value, error, reload } = useRefreshing(
    () => client.listTeamProductCatalogs(teamId),
    enabled
  );
  return { rows: value, error, reload };
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
