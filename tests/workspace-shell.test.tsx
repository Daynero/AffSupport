// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

const STORAGE_KEY = 'wishly.active-team.v1';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderEnteredSpace(client: ReturnType<typeof makeClient>, teamId: string) {
  localStorage.setItem(STORAGE_KEY, teamId);
  return render(
    <TeamProvider realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
}

describe('content-first workspace shell', () => {
  it('opens an empty space with no filters and no side panels, management behind settings', async () => {
    const team = makeTeam();
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([team]),
      listMaterials: vi.fn().mockResolvedValue([])
    });
    const user = userEvent.setup();
    renderEnteredSpace(client, team.id);

    // Content-first: the explorer is the default, showing the folder's empty state (011).
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();

    // Empty space → zero facet controls until a search is opened; search itself is one click away.
    expect(screen.queryByText('GEO')).toBeNull();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();

    // Management is not shown beside the content by default.
    expect(screen.queryByRole('heading', { name: 'Google Drive storage' })).toBeNull();

    // It is one click away behind the single "Space settings" entry.
    await user.click(screen.getByRole('link', { name: 'Space settings' }));
    expect(await screen.findByRole('heading', { name: 'Google Drive storage' })).toBeTruthy();
  });

  it('keeps the indexed catalog browsable, read-only, when storage needs a person', async () => {
    // Found in the beta run: every non-connected state fell through to the
    // state panel, so an expired token hid the whole explorer and read as data
    // loss. What was indexed stays visible; only the writes go dark (FR-033).
    const team = makeTeam({ connectionState: 'needs_reauth' });
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([team]),
      listFolderPage: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'material-1',
            teamId: team.id,
            driveFileId: 'file-1',
            parentFolderId: null,
            name: 'summer-lp.zip',
            kind: 'file',
            category: 'landing',
            mimeType: 'application/zip',
            fileExtension: 'zip',
            sizeBytes: 2048,
            modifiedAt: null,
            driveVersion: '1',
            previewState: 'pending',
            thumbnailReady: false,
            sortKey: '1|summer-lp.zip'
          }
        ],
        total: 1,
        next: null
      }),
      getStorageHealth: vi
        .fn()
        .mockResolvedValue({ kind: 'attention', reason: 'needs_reauth', fixer: 'owner' })
    });
    renderEnteredSpace(client, team.id);

    expect(await screen.findByText('summer-lp.zip')).toBeTruthy();
    expect(
      screen.getByText('Read-only until storage is reconnected — nothing here is lost.')
    ).toBeTruthy();
    // The writes are the only thing that goes away.
    expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull();
  });
});
