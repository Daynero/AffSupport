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
        })
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
        expect.objectContaining({ query: 'hook' })
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
      .mockRejectedValueOnce(new Error('INVALID_RESPONSE'));
    const user = userEvent.setup();
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
  });
});
