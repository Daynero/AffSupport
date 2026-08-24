// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { CatalogSearchResponse } from '@video-compressor/shared';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { CatalogSearchBar } from '../apps/web/src/team/catalog/CatalogSearchBar';
import { makeClient, makeTeam } from './team-space-fixtures';
import { adminAuthStub } from './support/auth-stub';

/**
 * US2 — file management lives where the files are.
 *
 * The findings behind these: actions were reachable only from search (F1),
 * search itself disappeared in a folder-only root (F2), destinations were raw
 * Drive ids (F3), and nothing past the fiftieth result could be reached (F5).
 */

const TEAM = makeTeam();

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const adminAuth = adminAuthStub();

function searchResponse(overrides: Partial<CatalogSearchResponse> = {}): CatalogSearchResponse {
  return {
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
    },
    ...overrides
  } as CatalogSearchResponse;
}

function file(id: string, name: string) {
  return {
    id,
    teamId: TEAM.id,
    name,
    kind: 'file' as const,
    category: 'video' as const,
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 1024,
    modifiedAt: null,
    previewState: 'ready'
  };
}

function folder(id: string, name: string) {
  return {
    id,
    providerId: id,
    teamId: TEAM.id,
    name,
    kind: 'folder' as const,
    category: null,
    mimeType: 'application/vnd.google-apps.folder',
    fileExtension: null,
    sizeBytes: null,
    modifiedAt: null,
    previewState: 'ready'
  };
}

function renderSpace(client: ReturnType<typeof makeClient>) {
  window.history.replaceState(null, '', `/team/${TEAM.id}`);
  return render(
    <AuthContextOverride value={adminAuth}>
      <TeamProvider realtime={false}>
        <TeamSpace client={client} directAddMode="disabled" />
      </TeamProvider>
    </AuthContextOverride>
  );
}

describe('file actions on the Files rows', () => {
  it('offers the permission-shaped set from a row, without going through search', async () => {
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([TEAM]),
      listMaterials: vi.fn().mockResolvedValue([file('material-1', 'launch.mp4')])
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Actions for launch.mp4' }));
    // Owner permissions, so the whole set is offered.
    for (const label of ['Download', 'Rename', 'Move', 'Move to trash', 'Process']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('hides what the viewer may not do rather than offering a dead control', async () => {
    const viewer = makeTeam({ role: 'viewer', permissions: DEFAULT_ROLE_PERMISSIONS.viewer });
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([viewer]),
      listMaterials: vi.fn().mockResolvedValue([file('material-1', 'launch.mp4')])
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Actions for launch.mp4' }));
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to trash' })).toBeNull();
  });

  it('picks a move destination from the folder tree instead of a raw id field', async () => {
    const moveMaterial = vi.fn().mockResolvedValue({ operationId: 'op-1', state: 'succeeded' });
    vi.spyOn(await import('../apps/web/src/api/team'), 'teamApi', 'get');
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([TEAM]),
      listMaterials: vi
        .fn()
        .mockResolvedValue([file('material-1', 'launch.mp4'), folder('folder-1', 'Archive')])
    });
    const user = userEvent.setup();
    const { container } = renderSpace(client);
    void container;

    await user.click(await screen.findByRole('button', { name: 'Actions for launch.mp4' }));
    await user.click(screen.getByRole('button', { name: 'Move' }));

    // A dialog of folders, not a text field expecting an id nothing shows you.
    const dialog = await screen.findByRole('dialog');
    expect(screen.queryByLabelText('Destination folder')).toBeNull();
    expect(await within(dialog).findByRole('button', { name: /Archive/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Select the space root' })).toBeTruthy();
    void moveMaterial;
  });
});

describe('search availability', () => {
  it('stays available in a folder-only root, because the space has content elsewhere', async () => {
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([TEAM]),
      // The open folder holds nothing but folders…
      listMaterials: vi.fn().mockResolvedValue([folder('folder-1', 'Archive')]),
      // …while the space-wide probe reports there is content somewhere.
      searchCatalog: vi.fn().mockResolvedValue(
        searchResponse({
          total: 12,
          catalogFreshness: {
            state: 'ready',
            lastSyncedAt: null,
            discoveredCount: 12,
            foldersRemaining: null,
            lastProgressAt: null
          }
        })
      )
    });
    renderSpace(client);

    expect(await screen.findByRole('button', { name: 'Search & filter' })).toBeTruthy();
  });

  it('stays out of the way in a space that is genuinely empty', async () => {
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([TEAM]),
      listMaterials: vi.fn().mockResolvedValue([]),
      searchCatalog: vi.fn().mockResolvedValue(searchResponse())
    });
    renderSpace(client);

    await screen.findByRole('navigation', { name: 'Space sections' });
    expect(screen.queryByRole('button', { name: 'Search & filter' })).toBeNull();
  });
});

describe('search results past the first fifty', () => {
  it('offers a pager when the total exceeds one page, and reaches page two', async () => {
    const searchCatalog = vi.fn().mockImplementation((_teamId, request) =>
      Promise.resolve(
        searchResponse({
          total: 120,
          items: [
            {
              ...file(`material-p${request.page}`, `page-${request.page}.mp4`),
              classificationVersion: 1,
              classificationSource: 'mime',
              geo: null,
              language: null,
              offer: null,
              tags: [],
              transcriptIngestState: 'not_applicable',
              transcriptTruncated: false,
              lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
            }
          ],
          catalogFreshness: {
            state: 'ready',
            lastSyncedAt: null,
            discoveredCount: 120,
            foldersRemaining: null,
            lastProgressAt: null
          }
        })
      )
    );
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([TEAM]),
      listMaterials: vi.fn().mockResolvedValue([]),
      searchCatalog
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Search & filter' }));
    expect(await screen.findByText('Page 1 of 3')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(searchCatalog).toHaveBeenCalledWith(TEAM.id, expect.objectContaining({ page: 2 }))
    );
    expect(await screen.findByText('page-2.mp4')).toBeTruthy();
  });
});

describe('the search field', () => {
  it('takes focus from a bare slash, and never from someone mid-word', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Somewhere else" />
        <CatalogSearchBar value="" onChange={vi.fn()} />
      </>
    );

    const search = screen.getByRole('searchbox');
    const other = screen.getByLabelText('Somewhere else');
    other.focus();
    await user.keyboard('/');
    expect(document.activeElement).toBe(other);

    other.blur();
    await user.keyboard('/');
    await waitFor(() => expect(document.activeElement).toBe(search));
  });
});
