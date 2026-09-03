// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { FolderPage, TeamMaterialRow } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { clearThumbnailSessions } from '../apps/web/src/team/explorer/useThumbnailSession';
import { makeTeam } from './team-space-fixtures';

/**
 * What a member can reach without opening a menu.
 *
 * Both of these started as prose: the file's card offered "download" and "delete" and hid
 * everything else behind the row's ⋯, and the selection bar spelled five actions out in
 * full-height buttons that wrapped onto three lines above the files. The actions are the same
 * ones — what changed is that they are icons carrying their names for a screen reader and on
 * hover, which is what this checks: the name is the contract, not the glyph.
 */

afterEach(() => {
  cleanup();
  clearThumbnailSessions();
  localStorage.clear();
  vi.restoreAllMocks();
});

const TEAM = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });

function video(index: number): TeamMaterialRow {
  return {
    id: `id-${index}`,
    teamId: TEAM.id,
    name: `clip-${index}.mp4`,
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 1_000,
    kind: 'video',
    driveFileId: `drive-${index}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false
  };
}

function makeClient(rows: TeamMaterialRow[]): ExplorerShellClient {
  return {
    listFolderTree: vi.fn().mockResolvedValue([]),
    listFolderPage: vi.fn(
      async (): Promise<FolderPage> => ({ rows, total: rows.length, next: null })
    ),
    mintThumbnailSession: vi.fn().mockRejectedValue(new Error('no session in this test')),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn()
  } as unknown as ExplorerShellClient;
}

function renderShell(rows: TeamMaterialRow[]) {
  // The provider reads the active space from storage, and a space with no permissions renders
  // no actions at all — which would make every assertion below pass for the wrong reason.
  localStorage.setItem('wishly.active-team.v1', TEAM.id);
  render(
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[TEAM]}>
        <ExplorerShell
          teamId={TEAM.id}
          client={makeClient(rows)}
          query={{ ...emptyTeamRouteQuery(), view: 'list' }}
          onQueryChange={vi.fn()}
          onFolderChange={vi.fn()}
          onSearched={vi.fn()}
          onPreview={vi.fn()}
        />
      </TeamProvider>
    </ToastProvider>
  );
}

describe('a video’s card', () => {
  it('offers the whole set, each one named', async () => {
    renderShell([video(1)]);
    await screen.findByText('clip-1.mp4');
    fireEvent.click(document.querySelector('.team-explorer-row')!);
    const card = await screen.findByRole('complementary', { name: 'Selected item' });
    await waitFor(() => expect(card.textContent).toContain('clip-1.mp4'));

    const named = (name: string | RegExp) =>
      Array.from(card.querySelectorAll<HTMLElement>('button')).some(button =>
        typeof name === 'string'
          ? button.getAttribute('aria-label') === name
          : name.test(button.getAttribute('aria-label') ?? '')
      );
    // Named "the original" only because there is now something else it could be.
    expect(named('Download the original')).toBe(true);
    expect(named('Download re-stitched')).toBe(true);
    expect(named(/^Share/u)).toBe(true);
    expect(named('Move to trash')).toBe(true);
  });
});

describe('the selection bar', () => {
  it('offers a re-stitched download for the videos in the selection', async () => {
    renderShell([video(1), video(2)]);
    await screen.findByText('clip-2.mp4');
    const rows = document.querySelectorAll<HTMLElement>('.team-explorer-row-check input');
    fireEvent.click(rows[0] as HTMLElement);
    fireEvent.click(rows[1] as HTMLElement);

    const bar = await screen.findByRole('region', { name: 'Selected: 2' });
    const named = (name: string) =>
      Array.from(bar.querySelectorAll<HTMLElement>('button')).some(
        button => button.getAttribute('aria-label') === name
      );
    expect(named('Download re-stitched')).toBe(true);
    expect(named('Move to trash')).toBe(true);
    expect(named('Clear selection')).toBe(true);
    // One line of icons, not five buttons of prose: the bar carries no action text of its own.
    expect(bar.textContent).toBe('Selected: 2');
  });
});
