import { useEffect, useState } from 'react';
import {
  normalizeCatalogSearchRequest,
  type CatalogSearchRequestInput,
  type CatalogSearchResponse
} from '@video-compressor/shared';
import { useTeam } from './TeamContext';

type Freshness = CatalogSearchResponse['catalogFreshness'];

export interface CatalogFreshnessClient {
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput
  ) => Promise<CatalogSearchResponse>;
}

/**
 * Space-level freshness read powering the workspace-wide sync banner. It rides
 * the same realtime `revision` the catalog views use, so it re-reads whenever a
 * page is ingested or the connection state changes — no separate polling loop.
 * Only the freshness envelope is needed, so it asks for the smallest page.
 */
export interface CatalogFreshnessSnapshot {
  freshness: Freshness | null;
  /**
   * Whether the space has any content *anywhere*, not in the open folder.
   *
   * This is what search availability keys off. Reading it from the folder in
   * view is what made search vanish in a folder-only root — the one place you
   * most need it (finding F2, FR-008).
   */
  hasContent: boolean;
}

export function useCatalogFreshness(input: {
  teamId: string;
  client: CatalogFreshnessClient;
  enabled?: boolean;
}): CatalogFreshnessSnapshot {
  const { teamId, client, enabled = true } = input;
  const { revision } = useTeam();
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  // The probe asks for one row of an unfiltered search, so its `total` is the
  // space's own answer to "is there anything here at all".
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setFreshness(null);
      setTotal(0);
      return;
    }
    const request = normalizeCatalogSearchRequest({
      query: '',
      filters: {},
      page: 1,
      pageSize: 1
    });
    if (!request) return;
    let active = true;
    void client
      .searchCatalog(teamId, request)
      .then(result => {
        if (!active) return;
        setFreshness(result.catalogFreshness);
        setTotal(result.total);
      })
      .catch(() => {
        if (active) setFreshness(null);
      });
    return () => {
      active = false;
    };
  }, [client, enabled, revision, teamId]);

  return {
    freshness,
    // Either signal is enough: a finished scan reports a total, and a scan
    // still in flight reports what it has discovered so far — so search does
    // not disappear again the moment the count is re-read mid-scan.
    hasContent: total > 0 || (freshness?.discoveredCount ?? 0) > 0
  };
}
