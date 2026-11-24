import { useCallback, useRef, useState } from 'react';
import type { CatalogSearchFilters } from '@video-compressor/shared';
import { behaviourFlag } from '../../lib/feature-flags';
import { effectiveSearchQuery } from '../catalog/useCatalogSearch';
import type { TeamRouteQuery } from '../routes';

/** The search a "Show in folder" left, and the way back to it (070, T023). */
export interface ExplorerSearchReturn {
  q: string;
  scope: TeamRouteQuery['scope'];
  filters: CatalogSearchFilters;
}

/**
 * The explorer's one search (070, US3): the toolbar field holds the words, and the results take
 * the list's place the moment there are enough of them to search by — no Enter, no second field.
 *
 * The words live here rather than in the address because the address is written after the
 * search answers (debounced, by `onSearched`), and a field fed from the address would lose the
 * letters typed while the answer was on its way. The address still wins when someone else
 * changes it — a "Show in folder", the palette, a pasted link — and it is told apart from this
 * field's own echo by the last words this field reported.
 *
 * Behind `explorerInlineSearch`: with the flag off the field opens the old search screen on
 * Enter, exactly as phase 3 left it.
 */
export function useExplorerSearch({
  query,
  onQueryChange,
  onSearched
}: {
  query: TeamRouteQuery;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
}) {
  const [inline] = useState(() => behaviourFlag('explorerInlineSearch'));
  const [draft, setDraftState] = useState(query.q);
  /** The words this field last wrote into the address; the address saying them is an echo. */
  const reported = useRef(query.q);
  const seen = useRef(query.q);
  if (seen.current !== query.q) {
    seen.current = query.q;
    if (query.q !== reported.current) {
      reported.current = query.q;
      setDraftState(query.q);
    }
  }
  const [returnTo, setReturnTo] = useState<ExplorerSearchReturn | null>(null);

  const searching = inline
    ? effectiveSearchQuery(draft) !== '' || query.scope === 'space'
    : query.q.length > 0 || query.scope !== 'folder';

  const leave = useCallback(() => {
    reported.current = '';
    setDraftState('');
    onQueryChange({ q: '', scope: 'folder', filters: undefined });
  }, [onQueryChange]);

  /** Typing: the results follow the words; an emptied field is the folder again. */
  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      if (text.trim() !== '') {
        setReturnTo(null);
        return;
      }
      if (query.q !== '' || query.scope !== 'folder') leave();
    },
    [leave, query.q, query.scope]
  );

  const reportSearched = useCallback(
    (state: { query: string; filters: TeamRouteQuery['filters'] }) => {
      reported.current = state.query;
      onSearched(state);
    },
    [onSearched]
  );

  /** Remembers the search before a result's folder is opened, so it can be come back to. */
  const rememberSearch = useCallback(() => {
    if (draft.trim() === '' && query.scope !== 'space') return;
    setReturnTo({ q: draft, scope: query.scope, filters: query.filters });
  }, [draft, query.filters, query.scope]);

  const backToResults = useCallback(() => {
    if (!returnTo) return;
    setReturnTo(null);
    onQueryChange({
      q: returnTo.q,
      scope: returnTo.scope,
      filters: returnTo.filters,
      itemId: null,
      trash: false
    });
  }, [onQueryChange, returnTo]);

  return {
    inline,
    draft,
    setDraft,
    searching,
    leave,
    reportSearched,
    rememberSearch,
    returnTo: inline ? returnTo : null,
    backToResults
  };
}

export type ExplorerSearch = ReturnType<typeof useExplorerSearch>;
