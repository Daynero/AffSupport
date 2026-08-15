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
export function useCatalogFreshness(input: {
  teamId: string;
  client: CatalogFreshnessClient;
  enabled?: boolean;
}): Freshness | null {
  const { teamId, client, enabled = true } = input;
  const { revision } = useTeam();
  const [freshness, setFreshness] = useState<Freshness | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFreshness(null);
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
        if (active) setFreshness(result.catalogFreshness);
      })
      .catch(() => {
        if (active) setFreshness(null);
      });
    return () => {
      active = false;
    };
  }, [client, enabled, revision, teamId]);

  return freshness;
}
