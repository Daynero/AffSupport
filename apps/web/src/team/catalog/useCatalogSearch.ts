import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  convertKeyboardLayout,
  countSearchLetters,
  normalizeCatalogSearchRequest,
  type CatalogSearchFilters,
  type CatalogSearchRequestInput,
  type CatalogSearchResponse,
  type CatalogVocabulary,
  type TeamMaterialRowKind
} from '@video-compressor/shared';
import { useTeam } from '../TeamContext';
import { isHousekeepingFile } from './housekeeping';
import { useCatalogRead } from './CatalogFreshness';
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

/** Where a search looks (011): one folder or the whole space, some kinds or all. */
export interface CatalogSearchScope {
  parentFolderId?: string | null;
  kinds?: TeamMaterialRowKind[];
  /** With a folder: that folder and everything under it (search rework, 2026-10). */
  recursive?: boolean;
}

/** Shorter than this, a typed query is a keystroke on the way somewhere, not a search. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * What the server is asked for a query as typed: a blank or a one-letter
 * query asks for the unsearched list (every file in scope, as before), so
 * "а" does not run a search that matches half the space.
 */
export function effectiveSearchQuery(query: string): string {
  const trimmed = query.trim();
  return [...trimmed].length < MIN_SEARCH_LENGTH ? '' : query;
}

/**
 * The answer came from the query on the other keyboard layout: the field says
 * "ghbdsn", the results are for "привіт" (search rework, 2026-10).
 */
export interface CatalogLayoutSwap {
  /** What is in the field. */
  original: string;
  /** What the results are for. */
  shown: string;
}

export interface CatalogSearchClient {
  searchCatalog: (
    teamId: string,
    request: CatalogSearchRequestInput,
    scope?: CatalogSearchScope
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
  /** 011: narrow to the open folder and/or to explorer row kinds. */
  scope?: CatalogSearchScope;
}) {
  const {
    teamId,
    client,
    debounceMs = 180,
    fixedFilters,
    initialQuery = '',
    initialFilters,
    onSearched,
    scope
  } = input;
  const scopeKey = `${scope?.parentFolderId ?? ''}|${(scope?.kinds ?? []).join(',')}|${scope?.recursive ? 'r' : ''}`;
  const { revision } = useTeam();
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
  /** The query the shown result answers: the converted one when the layout swap answered. */
  const [answeredQuery, setAnsweredQuery] = useState(initialQuery);
  const [layoutSwap, setLayoutSwap] = useState<CatalogLayoutSwap | null>(null);
  /** A query the person asked to see as typed, even though it finds nothing. */
  const [literalQuery, setLiteralQuery] = useState<string | null>(null);
  const requestSequence = useRef(0);
  // Held in a ref, not a dependency: an inline callback would change identity
  // every render and restart the debounced fetch forever.
  const onSearchedRef = useRef(onSearched);
  onSearchedRef.current = onSearched;
  const findFlow = useRef<TeamFindFlow | null>(null);

  const searchedTeam = useRef(teamId);
  useEffect(() => {
    // Only a change of space, not the first mount (024): on mount this wiped the query and filters
    // the address had just handed in, so a reloaded or shared search link opened empty.
    if (searchedTeam.current === teamId) return;
    searchedTeam.current = teamId;
    requestSequence.current += 1;
    setQuery('');
    setFilters(EMPTY_FILTERS);
    setPage(1);
    setResult(null);
    setError(false);
    setLayoutSwap(null);
    setLiteralQuery(null);
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
        query: effectiveSearchQuery(query),
        filters: { ...filters, ...fixedFilters },
        page,
        pageSize: 50
      }),
    [filters, fixedFilters, page, query]
  );
  const beginRead = useCatalogRead(teamId, request !== null);

  const refetch = useCallback(async () => {
    if (!request) return;
    const status = beginRead();
    const sequence = ++requestSequence.current;
    const cue = (['geo', 'offer', 'language', 'category'] as const).find(
      key => request.filters[key].length > 0
    );
    if (cue) findFlow.current = startTeamFindFlow(cue);
    setLoading(true);
    try {
      // Only pass a scope that exists: callers asserting on the call see two arguments as before.
      const ask = (asked: typeof request) =>
        scope ? client.searchCatalog(teamId, asked, scope) : client.searchCatalog(teamId, asked);
      let next = await ask(request);
      if (sequence !== requestSequence.current) return;
      /* Nothing for the words as typed, and they read as the other keyboard
         layout: ask once more for those, and say so above the results. */
      let swap: CatalogLayoutSwap | null = null;
      const swapped =
        next.items.length === 0 &&
        countSearchLetters(request.query) >= 3 &&
        literalQuery !== request.query
          ? convertKeyboardLayout(request.query)
          : null;
      if (swapped) {
        const second = normalizeCatalogSearchRequest({ ...request, query: swapped });
        const retried = second ? await ask(second).catch(() => null) : null;
        if (sequence !== requestSequence.current) return;
        if (retried && retried.items.length > 0) {
          next = retried;
          swap = { original: request.query, shown: second!.query };
        }
      }
      // Reports the *user's* filters, not the merged request: a surface with
      // fixed filters (landings, library) must not write them into the address.
      onSearchedRef.current?.({ query: request.query, filters });
      // The shared decoder normally enforces this at the API boundary. Keep a
      // second UI boundary so injected test clients cannot render foreign rows.
      if (next.items.some(material => material.teamId !== teamId))
        throw new Error('INVALID_RESPONSE');
      /* The listing hides an operating system's leftovers; search must hide
         the same ones, or `.DS_Store` comes back the moment somebody types. */
      const items = next.items.filter(material => !isHousekeepingFile(material.name));
      setResult({
        ...next,
        items,
        /* A server that already leaves them out of its count loses nothing
           here; an older one counted the leftovers this page just hid. */
        total: Math.max(items.length, next.total - (next.items.length - items.length))
      });
      setAnsweredQuery(swap ? swap.shown : request.query);
      setLayoutSwap(swap);
      setError(false);
      status.succeed();
      if (findFlow.current) {
        completeTeamFindFlow(findFlow.current, {
          outcome: next.items.length > 0 ? 'success' : 'failure',
          assisted: false
        });
        findFlow.current = null;
      }
    } catch {
      status.fail();
      if (sequence !== requestSequence.current) return;
      setResult(null);
      setLayoutSwap(null);
      setError(true);
      if (findFlow.current) {
        completeTeamFindFlow(findFlow.current, { outcome: 'failure', assisted: false });
        findFlow.current = null;
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
    // scopeKey stands in for the scope object's identity.
  }, [client, filters, request, teamId, scopeKey, beginRead, literalQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refetch(), debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, refetch, revision]);

  const setFacet = useCallback((key: keyof CatalogSearchFilters, value: string | null) => {
    setPage(1);
    setFilters(current => ({ ...current, [key]: value ? [value] : [] }));
  }, []);

  const removeFilter = useCallback((key: keyof CatalogSearchFilters, value: string) => {
    setPage(1);
    setFilters(current => ({
      ...current,
      [key]: (current[key] ?? []).filter(entry => entry !== value)
    }));
  }, []);

  /** The facets only: the words in the field stay (the empty state's "reset filters"). */
  const resetFacets = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setPage(1);
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
    /** The query the result on screen answers — highlight by this, not by the field. */
    answeredQuery,
    layoutSwap,
    /** Show what the query as typed finds, even if that is nothing. */
    searchAsTyped: (value: string) => setLiteralQuery(value),
    filters,
    setFacet,
    removeFilter,
    clearFilters,
    resetFacets,
    page,
    setPage,
    result,
    vocabulary,
    loading,
    error,
    refetch
  };
}
