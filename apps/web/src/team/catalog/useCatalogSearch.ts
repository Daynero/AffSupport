import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeCatalogSearchRequest,
  type CatalogSearchFilters,
  type CatalogSearchRequestInput,
  type CatalogSearchResponse,
  type CatalogVocabulary
} from '@video-compressor/shared';
import { useTeam } from '../TeamContext';
import {
  completeTeamFindFlow,
  startTeamFindFlow,
  type TeamFindFlow
} from '../../analytics/service';

const EMPTY_FILTERS: CatalogSearchFilters = {
  geo: [],
  language: [],
  offer: [],
  category: [],
  originalType: [],
  kind: [],
  unfilled: []
};

export interface CatalogSearchClient {
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput
  ) => Promise<CatalogSearchResponse>;
  getCatalogVocabulary: (teamId: string) => Promise<CatalogVocabulary>;
}

export function useCatalogSearch(input: {
  teamId: string;
  client: CatalogSearchClient;
  debounceMs?: number;
  fixedFilters?: Partial<CatalogSearchFilters>;
}) {
  const { teamId, client, debounceMs = 180, fixedFilters } = input;
  const { revision, realtimeState } = useTeam();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<CatalogSearchFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CatalogSearchResponse | null>(null);
  const [vocabulary, setVocabulary] = useState<CatalogVocabulary>({
    geo: [],
    languages: [],
    offers: [],
    tags: []
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestSequence = useRef(0);
  const lastRealtimeState = useRef(realtimeState);
  const findFlow = useRef<TeamFindFlow | null>(null);

  useEffect(() => {
    setQuery('');
    setFilters(EMPTY_FILTERS);
    setPage(1);
    setResult(null);
    setError(false);
  }, [teamId]);

  useEffect(() => {
    let active = true;
    void client
      .getCatalogVocabulary(teamId)
      .then(value => {
        if (active) setVocabulary(value);
      })
      .catch(() => {
        if (active) setVocabulary({ geo: [], languages: [], offers: [], tags: [] });
      });
    return () => {
      active = false;
    };
  }, [client, revision, teamId]);

  const request = useMemo(
    () =>
      normalizeCatalogSearchRequest({
        query,
        filters: { ...filters, ...fixedFilters },
        page,
        pageSize: 50
      }),
    [filters, fixedFilters, page, query]
  );

  const refetch = useCallback(async () => {
    if (!request) return;
    const sequence = ++requestSequence.current;
    const cue = (['geo', 'offer', 'language', 'category'] as const).find(
      key => request.filters[key].length > 0
    );
    if (cue) findFlow.current = startTeamFindFlow(cue);
    setLoading(true);
    try {
      const next = await client.searchCatalog(teamId, request);
      if (sequence !== requestSequence.current) return;
      // The shared decoder normally enforces this at the API boundary. Keep a
      // second UI boundary so injected test clients cannot render foreign rows.
      if (next.items.some(material => material.teamId !== teamId))
        throw new Error('INVALID_RESPONSE');
      setResult(next);
      setError(false);
      if (findFlow.current) {
        completeTeamFindFlow(findFlow.current, {
          outcome: next.items.length > 0 ? 'success' : 'failure',
          assisted: false
        });
        findFlow.current = null;
      }
    } catch {
      if (sequence !== requestSequence.current) return;
      setResult(null);
      setError(true);
      if (findFlow.current) {
        completeTeamFindFlow(findFlow.current, { outcome: 'failure', assisted: false });
        findFlow.current = null;
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [client, request, teamId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refetch(), debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, refetch, revision]);

  useEffect(() => {
    if (lastRealtimeState.current !== 'connected' && realtimeState === 'connected') {
      void refetch();
    }
    lastRealtimeState.current = realtimeState;
  }, [realtimeState, refetch]);

  const setFacet = useCallback((key: keyof CatalogSearchFilters, value: string | null) => {
    setPage(1);
    setFilters(current => ({ ...current, [key]: value ? [value] : [] }));
  }, []);

  const removeFilter = useCallback((key: keyof CatalogSearchFilters, value: string) => {
    setPage(1);
    setFilters(current => ({
      ...current,
      [key]: current[key].filter(entry => entry !== value)
    }));
  }, []);

  const clearFilters = useCallback(() => {
    setQuery('');
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }, []);

  return {
    query,
    setQuery: (value: string) => {
      setQuery(value);
      setPage(1);
    },
    filters,
    setFacet,
    removeFilter,
    clearFilters,
    page,
    setPage,
    result,
    vocabulary,
    loading,
    error,
    refetch
  };
}
