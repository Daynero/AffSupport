// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamCatalog, type TeamCatalogClient } from '../apps/web/src/team/catalog/TeamCatalog';

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
    catalogFreshness: { state: 'ready' as const, lastSyncedAt: '2026-08-01T12:00:00.000Z' },
    ...overrides
  };
}

function client(): TeamCatalogClient {
  return {
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

describe('team catalog search UI', () => {
  it('combines search/facets, shows active chips and counts, and clears filters', async () => {
    const api = client();
    const user = userEvent.setup();
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <TeamCatalog teamId={TEAM_ID} client={api} />
      </TeamProvider>
    );

    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    expect(screen.getByText('1 material')).toBeTruthy();
    await user.type(screen.getByLabelText('Search materials'), 'launch');
    await user.selectOptions(screen.getByLabelText('GEO'), 'UA');
    await user.selectOptions(screen.getByLabelText('Category'), 'video');
    await waitFor(() =>
      expect(api.searchCatalog).toHaveBeenLastCalledWith(
        TEAM_ID,
        expect.objectContaining({
          query: 'launch',
          filters: expect.objectContaining({ geo: ['UA'], category: ['video'] })
        })
      )
    );
    expect(screen.getByRole('button', { name: 'Remove GEO: UA filter' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(screen.queryByRole('button', { name: 'Remove GEO: UA filter' })).toBeNull();
  });

  it('supports unfilled metadata and metadata-only editing even when edit=false', async () => {
    const api = client();
    const user = userEvent.setup();
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <TeamCatalog teamId={TEAM_ID} client={api} />
      </TeamProvider>
    );
    expect(await screen.findByText('launch.mp4')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Missing metadata'), 'geo');
    await user.click(screen.getByRole('button', { name: 'Edit metadata for launch.mp4' }));
    await user.selectOptions(screen.getByLabelText('Material GEO'), 'UA');
    await user.click(screen.getByRole('button', { name: 'Save metadata' }));
    await waitFor(() =>
      expect(api.updateMaterialMetadata).toHaveBeenCalledWith(
        TEAM_ID,
        'visible-material',
        expect.objectContaining({ geo: 'UA' })
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
        <TeamCatalog teamId={TEAM_ID} client={api} />
      </TeamProvider>
    );

    expect(await screen.findByText('Creative source')).toBeTruthy();
    expect(screen.getByText('Folder')).toBeTruthy();
    expect(screen.getByText('Metadata needs attention')).toBeTruthy();
    expect(screen.queryByText('application/vnd.google-apps.folder')).toBeNull();
    expect(screen.getByText('More actions')).toBeTruthy();
  });

  it('uses a neutral empty state and never renders a foreign-team payload', async () => {
    const api = client();
    vi.mocked(api.searchCatalog)
      .mockResolvedValueOnce(result({ items: [], total: 0 }))
      .mockRejectedValueOnce(new Error('INVALID_RESPONSE'));
    const user = userEvent.setup();
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <TeamCatalog teamId={TEAM_ID} client={api} />
      </TeamProvider>
    );
    expect(await screen.findByText('No materials match these filters.')).toBeTruthy();
    expect(screen.queryByText('Secret competitor creative')).toBeNull();
    await user.type(screen.getByLabelText('Search materials'), 'hidden exact name');
    expect(await screen.findByText('Could not load catalog results.')).toBeTruthy();
    expect(screen.queryByText('Secret competitor creative')).toBeNull();
  });
});
