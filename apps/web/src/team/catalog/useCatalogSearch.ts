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
  /** Search state carried in by the address, so a refresh restores the view. */
  initialQuery?: string;
  initialFilters?: CatalogSearchFilters;
  /**
   * Called with the state that actually produced a request — debounced, not
   * per keystroke, because the caller writes it back into the URL and every
   * write re-renders the application shell.
   */
  onSearched?: (state: { query: string; filters: CatalogSearchFilters }) => void;
}) {
  const {
    teamId,
    client,
    debounceMs = 180,
    fixedFilters,
    initialQuery = '',
    initialFilters,
    onSearched
  } = input;
  const { revision, realtimeState } = useTeam();
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<CatalogSearchFilters>(initialFilters ?? EMPTY_FILTERS);
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
  // Held in a ref, not a dependency: an inline callback would change identity
  // every render and restart the debounced fetch forever.
  const onSearchedRef = useRef(onSearched);
  onSearchedRef.current = onSearched;
  const findFlow = useRef<TeamFindFlow | null>(null);

  useEffect(() => {
    setQuery('');
    setFilters(EMPTY_FILTERS);
    setPage(1);
    setResult(null);
    setError(false);
    // Changing space is not a search: the address for the new space carries no
    // query, so the fields start empty rather than inheriting the old one's.
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
      // Reports the *user's* filters, not the merged request: a surface with
      // fixed filters (landings, library) must not write them into the address.
      onSearchedRef.current?.({ query: request.query, filters });
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
  }, [client, filters, request, teamId]);

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
