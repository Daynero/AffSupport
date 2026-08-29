// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KindFilterMenu } from '../apps/web/src/team/explorer/KindFilterMenu';
import { parseTeamRoute, buildTeamRoute } from '../apps/web/src/team/routes';
import { useCatalogSearch } from '../apps/web/src/team/catalog/useCatalogSearch';
import { TeamProvider } from '../apps/web/src/team/TeamContext';

/**
 * Feature 011 (T056): kind filters are one click, persist in the address, and
 * a search narrows to the open folder until widened to the whole space.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function StatefulFilter({ onChange }: { onChange: (kinds: string[]) => void }) {
  const [kinds, setKinds] = useState<string[]>([]);
  return (
    <KindFilterMenu
      kinds={kinds as never}
      onChange={next => {
        setKinds(next);
        onChange(next);
      }}
    />
  );
}

describe('KindFilterMenu', () => {
  it('toggles kinds from the Type menu and clears them', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StatefulFilter onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Type/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Image' }));
    expect(onChange).toHaveBeenLastCalledWith(['image']);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Video' }));
    expect(onChange).toHaveBeenLastCalledWith(['image', 'video']);
    // With a filter set, a clear control appears and empties it.
    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('survives the address so navigating keeps the filter until cleared', () => {
    const route = buildTeamRoute({
      spaceId: 's',
      section: 'explorer',
      query: { folderId: 'f-2', kinds: ['landing'], view: 'grid' }
    });
    expect(parseTeamRoute(route)).toMatchObject({
      query: { folderId: 'f-2', kinds: ['landing'], view: 'grid' }
    });
    const parsed = parseTeamRoute(route);
    if (!parsed || parsed.kind !== 'space') throw new Error('expected a space route');
    const moved = buildTeamRoute({
      spaceId: 's',
      section: 'explorer',
      query: { ...parsed.query, folderId: 'f-3' }
    });
    expect(parseTeamRoute(moved)).toMatchObject({ query: { folderId: 'f-3', kinds: ['landing'] } });
  });
});

function SearchProbe({
  client,
  scope
}: {
  client: Parameters<typeof useCatalogSearch>[0]['client'];
  scope?: Parameters<typeof useCatalogSearch>[0]['scope'];
}) {
  const search = useCatalogSearch({ teamId: 'team-1', client, scope, debounceMs: 0 });
  return (
    <div>
      <input
        aria-label="q"
        value={search.query}
        onChange={event => search.setQuery(event.target.value)}
      />
      <output>{search.result?.total ?? 'none'}</output>
    </div>
  );
}

describe('search scope', () => {
  it('narrows to the open folder and the chosen kinds, and widens when asked', async () => {
    const user = userEvent.setup();
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      activeFilters: {},
      facets: {},
      catalogFreshness: {
        state: 'ready',
        lastSyncedAt: null,
        discoveredCount: 0,
        foldersRemaining: null,
        lastProgressAt: null
      }
    });
    const client = {
      searchCatalog,
      getCatalogVocabulary: vi
        .fn()
        .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] })
    };
    const { rerender } = render(
      <TeamProvider realtime={false}>
        <SearchProbe client={client} scope={{ parentFolderId: 'f-1', kinds: ['image'] }} />
      </TeamProvider>
    );
    await user.type(screen.getByLabelText('q'), 'ban');
    await waitFor(() =>
      expect(searchCatalog).toHaveBeenLastCalledWith(
        'team-1',
        expect.objectContaining({ query: 'ban' }),
        { parentFolderId: 'f-1', kinds: ['image'] }
      )
    );
    rerender(
      <TeamProvider realtime={false}>
        <SearchProbe client={client} scope={{ parentFolderId: null, kinds: ['image'] }} />
      </TeamProvider>
    );
    await waitFor(() =>
      expect(searchCatalog).toHaveBeenLastCalledWith('team-1', expect.anything(), {
        parentFolderId: null,
        kinds: ['image']
      })
    );
  });
});
