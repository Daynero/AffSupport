// @vitest-environment jsdom
import React from 'react';
import { freshnessStub } from './support/catalog-stub.js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamCatalog, type TeamCatalogClient } from '../apps/web/src/team/catalog/TeamCatalog';
import { ToastProvider } from '../apps/web/src/components/toast';
import { MaterialResults } from '../apps/web/src/team/catalog/MaterialResults';
import { clearThumbnailSessions } from '../apps/web/src/team/explorer/useThumbnailSession';
import type {
  CatalogMaterialItem,
  CatalogSearchResponse,
  ThumbnailSession
} from '@video-compressor/shared';

const TEAM_ID = '22000000-0000-4000-8000-000000000001';
const team = {
  id: TEAM_ID,
  name: 'Catalog team',
  role: 'editor' as const,
  permissions: {
    ...DEFAULT_ROLE_PERMISSIONS.editor,
    edit: false,
    manage_metadata: true
  },
  connectionState: 'connected' as const
};

beforeEach(() => {
  // Enter the space explicitly; the workspace no longer auto-selects teams[0].
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function result(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: 'visible-material',
        teamId: TEAM_ID,
        name: 'launch.mp4',
        kind: 'file' as const,
        category: 'video' as const,
        mimeType: 'video/mp4',
        fileExtension: 'mp4',
        classificationVersion: 1,
        classificationSource: 'mime' as const,
        sizeBytes: 2048,
        modifiedAt: '2026-08-01T12:00:00.000Z',
        geo: null,
        language: 'uk',
        offer: 'Summer Sale',
        tags: ['UGC'],
        transcriptIngestState: 'not_applicable' as const,
        transcriptTruncated: false,
        previewState: 'ready',
        lineage: { hasSource: false, hasDerivatives: true, isVersion: false }
      }
    ],
    total: 1,
    activeFilters: {},
    facets: {
      geo: [{ value: 'UA', count: 1 }],
      language: [{ value: 'uk', count: 1 }],
      offer: [{ value: 'Summer Sale', count: 1 }],
      category: [{ value: 'video', count: 1 }]
    },
    catalogFreshness: freshnessStub({ lastSyncedAt: '2026-08-01T12:00:00.000Z' }),
    ...overrides
  };
}

function client(): TeamCatalogClient {
  return {
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn().mockResolvedValue(result()),
    getCatalogVocabulary: vi.fn().mockResolvedValue({
      geo: ['UA', 'US'],
      languages: ['en', 'uk'],
      offers: ['Summer Sale'],
      tags: ['UGC']
    }),
    updateMaterialMetadata: vi.fn().mockResolvedValue(result().items[0])
  };
}

/**
 * Pick a value from the inventory's Select.
 *
 * It is a listbox with a button for a trigger now, not a native `<select>`, so
 * `selectOptions` has nothing to operate on. Driving it the way a person does —
 * open, then choose — is also what checks that it can be driven at all.
 */
async function choose(user: ReturnType<typeof userEvent.setup>, name: string, option: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(name, 'i') }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('team catalog search UI', () => {
  it('combines search/facets, shows active chips and counts, and clears filters', async () => {
    const api = client();
    const user = userEvent.setup();
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <TeamCatalog teamId={TEAM_ID} client={api} />
        </ToastProvider>
      </TeamProvider>
    );

    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    expect(screen.getByText('1 file')).toBeTruthy();
    await user.type(screen.getByLabelText('Search files'), 'launch');
    await choose(user, 'GEO', 'Ukraine');
    // The option is named the way a reader sees it, not the way the filter
    // spells it — which is the point of a listbox that can hold more than text.
    await choose(user, 'Category', 'Video');
    await waitFor(() =>
      expect(api.searchCatalog).toHaveBeenLastCalledWith(
        TEAM_ID,
        expect.objectContaining({
          query: 'launch',
          filters: expect.objectContaining({ geo: ['UA'], category: ['video'] })
        }),
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    expect(screen.getByRole('button', { name: 'Remove GEO: Ukraine filter' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(screen.queryByRole('button', { name: 'Remove GEO: Ukraine filter' })).toBeNull();
    // Two listboxes opened and chosen from, plus typing: the interaction is
    // real now rather than a `selectOptions` shortcut, and on a busy machine it
    // outruns the default ceiling.
  }, 20_000);

  it('supports unfilled metadata and metadata-only editing even when edit=false', async () => {
    const api = client();
    const user = userEvent.setup();
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <TeamCatalog teamId={TEAM_ID} client={api} />
        </ToastProvider>
      </TeamProvider>
    );
    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    await choose(user, 'Missing metadata', 'GEO');
    // Behind the one overflow now, with everything else this file can take.
    await user.click(screen.getByRole('button', { name: /^Actions for launch\.mp4/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit the details' }));
    await choose(user, 'File GEO', 'Ukraine · UA');
    await user.click(screen.getByRole('button', { name: 'Save metadata' }));
    await waitFor(() =>
      expect(api.updateMaterialMetadata).toHaveBeenCalledWith(
        TEAM_ID,
        'visible-material',
        expect.objectContaining({ geo: 'UA' })
      )
    );
  });

  it('takes a search result to the folder it lives in', async () => {
    const api = client();
    const onReveal = vi.fn();
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <TeamCatalog teamId={TEAM_ID} client={api} onReveal={onReveal} />
        </ToastProvider>
      </TeamProvider>
    );
    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ id: 'visible-material' }));
  });

  it('opens with the query the address carries, not an empty search', async () => {
    const api = client();
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <TeamCatalog teamId={TEAM_ID} client={api} initialQuery="hook" />
        </ToastProvider>
      </TeamProvider>
    );
    expect(((await screen.findByRole('searchbox')) as HTMLInputElement).value).toBe('hook');
    await waitFor(() =>
      expect(api.searchCatalog).toHaveBeenLastCalledWith(
        TEAM_ID,
        expect.objectContaining({ query: 'hook' }),
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
  });

  it('uses readable material labels instead of raw Drive MIME values', async () => {
    const api = client();
    vi.mocked(api.searchCatalog).mockResolvedValue(
      result({
        items: [
          {
            ...result().items[0],
            id: 'folder-material',
            name: 'Creative source',
            kind: 'folder',
            category: null,
            mimeType: 'application/vnd.google-apps.folder',
            fileExtension: null,
            sizeBytes: null,
            geo: null,
            language: null,
            offer: null,
            tags: []
          }
        ]
      })
    );
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <TeamCatalog teamId={TEAM_ID} client={api} />
        </ToastProvider>
      </TeamProvider>
    );

    const name = await screen.findByText('Creative source');
    // Scoped to the row. The type filters now say their values in words too, so
    // "Folder" appears twice on the page and the bare query matched both — this
    // assertion is about what the *row* shows instead of the raw MIME, not about
    // how many places the word occurs.
    const row = name.closest('li');
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText('Folder')).toBeTruthy();
    expect(screen.getByText('Metadata needs attention')).toBeTruthy();
    expect(screen.queryByText('application/vnd.google-apps.folder')).toBeNull();
    // The disclosure is a real menu button now, and its contents mount only
    // while it is open — which is what keeps a fifty-row page cheap.
    expect(screen.getByRole('button', { name: 'Actions for Creative source' })).toBeTruthy();
  });

  it('uses a neutral empty state and never renders a foreign-team payload', async () => {
    const api = client();
    vi.mocked(api.searchCatalog)
      .mockResolvedValueOnce(result({ items: [], total: 0 }))
      // A debounced intermediate query can run while userEvent is still typing.
      // Keep the failure for every later search, rather than letting an early
      // keystroke consume it and make the final query succeed.
      .mockRejectedValue(new Error('INVALID_RESPONSE'));
    // Exercise intermediate searches as well as the final query.
    const user = userEvent.setup({ delay: 250 });
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <TeamCatalog teamId={TEAM_ID} client={api} />
        </ToastProvider>
      </TeamProvider>
    );
    expect(await screen.findByText('No files match these filters.')).toBeTruthy();
    expect(screen.queryByText('Secret competitor creative')).toBeNull();
    await user.type(screen.getByLabelText('Search files'), 'hidden exact name');
    expect(await screen.findByText('Could not load catalog results.')).toBeTruthy();
    expect(screen.queryByText('Secret competitor creative')).toBeNull();
  }, 20_000);
});

/**
 * The result list on its own: what each row says about the file it found, and
 * the pager under fifty of them. Rendered directly, because the explorer's one
 * search (070) answers most queries in the list's place and no longer reaches
 * every corner of this component through the catalog page.
 */
describe('a page of search results', () => {
  const SESSION: ThumbnailSession = {
    token: 'session-token',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    teamId: TEAM_ID,
    endpoint: 'https://thumbs.example/thumbnail'
  };

  afterEach(() => {
    clearThumbnailSessions();
  });

  function item(overrides: Partial<CatalogMaterialItem>): CatalogMaterialItem {
    return { ...(result().items[0] as CatalogMaterialItem), ...overrides };
  }

  function page(items: CatalogMaterialItem[], total = items.length): CatalogSearchResponse {
    return result({ items, total }) as CatalogSearchResponse;
  }

  function renderResults(
    props: Partial<React.ComponentProps<typeof MaterialResults>> & {
      result: CatalogSearchResponse | null;
    }
  ) {
    const handlers = {
      onEditMetadata: vi.fn(),
      onPreview: vi.fn(),
      onEditText: vi.fn(),
      onProcess: vi.fn(),
      onShowProvenance: vi.fn(),
      onChanged: vi.fn(),
      onPageChange: vi.fn()
    };
    const view = render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <MaterialResults
            loading={false}
            error={false}
            canManageMetadata
            permissions={team.permissions}
            storageKind={null}
            browseClient={client() as never}
            page={1}
            {...handlers}
            {...props}
          />
        </ToastProvider>
      </TeamProvider>
    );
    return { ...view, handlers };
  }

  it('says what each found file is, where the query hit it and what it carries', async () => {
    const scrolled = vi.fn();
    const scrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrolled;
    const thumbnails = {
      mintThumbnailSession: vi.fn().mockResolvedValue(SESSION),
      thumbnailUrl: (session: ThumbnailSession, id: string) => `${session.endpoint}?material=${id}`
    };
    const onSetTag = vi.fn();
    try {
      renderResults({
        query: 'hook',
        activeIndex: 1,
        thumbnails,
        tagging: { canTag: true, onSetTag },
        pathFor: material => (material.id === 'clip' ? 'Ads / Summer' : null),
        result: page([
          item({
            id: 'clip',
            name: 'hook-clip.mp4',
            sizeBytes: 512,
            matchedIn: 'transcript',
            snippet: 'the hook lands here',
            note: 'First line\n\n\nsecond line',
            transcriptIngestState: 'full',
            transcriptTruncated: true,
            lineage: { hasSource: true, hasDerivatives: true, isVersion: true }
          }),
          item({
            id: 'poster',
            name: 'poster.png',
            category: 'image',
            fileExtension: 'png',
            sizeBytes: 5 * 1024 * 1024,
            matchedIn: 'note',
            snippet: 'a hook in the note',
            note: 'a hook in the note, in full',
            transcriptIngestState: 'truncated'
          }),
          item({
            id: 'link',
            name: 'shortcut',
            kind: 'shortcut',
            category: null,
            fileExtension: null,
            sizeBytes: null,
            matchedIn: 'tags',
            snippet: 'not shown for tags',
            transcriptIngestState: 'pending'
          }),
          item({
            id: 'page',
            name: 'offer.html',
            category: 'landing',
            fileExtension: 'html',
            sizeBytes: 3 * 1024,
            transcriptIngestState: 'invalid_encoding'
          }),
          item({
            id: 'text',
            name: 'clip.txt',
            category: 'transcript',
            fileExtension: 'txt',
            transcriptIngestState: 'unavailable'
          }),
          item({
            id: 'zip',
            name: 'pack.zip',
            category: 'archive',
            fileExtension: 'zip',
            // A state a newer server may send before this client knows its name.
            transcriptIngestState: 'reindexing' as CatalogMaterialItem['transcriptIngestState']
          }),
          item({ id: 'doc', name: 'brief.pdf', category: 'other', fileExtension: 'pdf' }),
          item({ id: 'dir', name: 'Sources', kind: 'folder', category: null })
        ])
      });

      const rows = screen.getAllByRole('listitem');
      const row = (id: number) => within(rows[id]!);
      expect(screen.getByText('8 files')).toBeTruthy();

      // The thumbnail, once the space's one session is minted; never for a file without a picture.
      await waitFor(() => expect(rows[0]!.querySelector('img')).not.toBeNull());
      expect(rows[0]!.querySelector('img')!.getAttribute('src')).toBe(
        `${SESSION.endpoint}?material=clip`
      );
      expect(rows[1]!.querySelector('img')!.getAttribute('src')).toBe(
        `${SESSION.endpoint}?material=poster`
      );
      expect(rows[3]!.querySelector('img')).toBeNull();
      expect(thumbnails.mintThumbnailSession).toHaveBeenCalledTimes(1);

      // Found in the transcript: said so, with the words around the hit, marked.
      expect(row(0).getByText('in the transcript')).toBeTruthy();
      // Marked in the name and in the snippet both.
      expect(row(0).getAllByText('hook', { selector: 'mark' })).toHaveLength(2);
      expect(row(0).getByText('Ads / Summer')).toBeTruthy();
      expect(row(0).getByText(/· MP4 · 512 B$/)).toBeTruthy();
      // The note is shown in one paragraph, blank lines folded.
      expect(rows[0]!.querySelector('.team-catalog-material-note')!.textContent).toBe(
        'First line\nsecond line'
      );
      expect(row(0).getByText('Transcript ready')).toBeTruthy();
      expect(row(0).getByText('transcript truncated')).toBeTruthy();
      expect(row(0).getByText('derived')).toBeTruthy();
      expect(row(0).getByText('version')).toBeTruthy();

      // Found in the note: the snippet stands for the note, which is not repeated.
      expect(row(1).getByText('in the note')).toBeTruthy();
      expect(rows[1]!.querySelector('.team-catalog-material-note')).toBeNull();
      expect(row(1).getByText(/Image · PNG · 5\.0 MB$/)).toBeTruthy();
      expect(row(1).getByText('transcript truncated')).toBeTruthy();

      // A tag match says where, but a tag is not a snippet.
      expect(row(2).getByText('in the tags')).toBeTruthy();
      expect(row(2).queryByText('not shown for tags')).toBeNull();
      expect(row(2).getByText('Shortcut')).toBeTruthy();
      expect(row(2).getByText('Transcript is being prepared')).toBeTruthy();

      expect(row(3).getByText(/Landing · HTML · 3 KB$/)).toBeTruthy();
      expect(row(3).getByText('Transcript has an unsupported encoding')).toBeTruthy();
      expect(rows[3]!.querySelector('.team-catalog-material-glyph')!.textContent).toBe('◇');
      expect(row(4).getByText(/^Transcript · TXT/)).toBeTruthy();
      expect(row(4).getByText('Transcript is unavailable')).toBeTruthy();
      expect(rows[4]!.querySelector('.team-catalog-material-glyph')!.textContent).toBe('≡');
      expect(row(5).getByText(/^Archive · ZIP/)).toBeTruthy();
      expect(row(5).getByText('Transcript is not available')).toBeTruthy();
      expect(rows[5]!.querySelector('.team-catalog-material-glyph')!.textContent).toBe('▦');
      expect(row(6).getByText(/^File · PDF/)).toBeTruthy();
      expect(rows[6]!.querySelector('.team-catalog-material-glyph')!.textContent).toBe('▤');
      expect(rows[2]!.querySelector('.team-catalog-material-glyph')!.textContent).toBe('↗');
      expect(rows[7]!.querySelector('.team-catalog-material-glyph')!.textContent).toBe('▰');

      // The row the keyboard is on is marked and brought into view.
      expect(rows[1]!.className).toContain('is-active');
      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });

      // A tag set from a result holds until the next search answers with it.
      fireEvent.click(row(0).getByRole('button', { name: 'Tag of hook-clip.mp4: No tag' }));
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Red' }));
      expect(onSetTag).toHaveBeenCalledWith(expect.objectContaining({ id: 'clip' }), 'red');
      expect(row(0).getByRole('button', { name: 'Tag of hook-clip.mp4: Red' })).toBeTruthy();
    } finally {
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
    }
  });

  it('pages past the first fifty, and goes nowhere from either end', () => {
    const { handlers, rerender } = renderResults({ page: 2, result: page([item({})], 120) });
    expect(screen.getByText('120 files')).toBeTruthy();
    const pager = within(screen.getByRole('navigation', { name: 'Result pages' }));
    expect(pager.getByText('Page 2 of 3')).toBeTruthy();
    fireEvent.click(pager.getByRole('button', { name: 'Previous' }));
    expect(handlers.onPageChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(pager.getByRole('button', { name: 'Next' }));
    expect(handlers.onPageChange).toHaveBeenLastCalledWith(3);

    rerender(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <ToastProvider>
          <MaterialResults
            loading={false}
            error={false}
            canManageMetadata
            permissions={team.permissions}
            storageKind={null}
            browseClient={client() as never}
            page={3}
            {...handlers}
            result={page([item({})], 120)}
          />
        </ToastProvider>
      </TeamProvider>
    );
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the wait, the failure and a caller-given empty answer in the list place', () => {
    const loading = renderResults({ result: null, loading: true });
    expect(screen.getByText('Searching files…')).toBeTruthy();
    loading.unmount();

    const failed = renderResults({ result: page([item({})]), error: true });
    expect(screen.getByText('Could not load catalog results.')).toBeTruthy();
    failed.unmount();

    renderResults({ result: page([], 0), empty: <p>Try the other layout</p> });
    expect(screen.getByText('Try the other layout')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
