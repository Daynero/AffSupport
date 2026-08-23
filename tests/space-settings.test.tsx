// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

const STORAGE_KEY = 'wishly.active-team.v1';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderEnteredSpace(
  client: ReturnType<typeof makeClient>,
  teamId: string,
  refreshClient?: { listTeams: () => Promise<ReturnType<typeof makeTeam>[]> }
) {
  localStorage.setItem(STORAGE_KEY, teamId);
  return render(
    <TeamProvider client={refreshClient} realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
}

describe('space settings surface', () => {
  it('exposes every 001 capability behind settings for an owner (<= 2 actions)', async () => {
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    const user = userEvent.setup();
    renderEnteredSpace(client, team.id);

    await screen.findByRole('heading', { name: 'Media buyers' });
    // Action 1 (entering the space) is the cached open; action 2 opens settings.
    await user.click(screen.getByRole('link', { name: 'Space settings' }));

    expect(await screen.findByRole('heading', { name: 'Google Drive storage' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Team audit history' })).toBeTruthy();
  });

  it('hides owner-only controls from a viewer', async () => {
    const team = makeTeam({
      role: 'viewer',
      permissions: DEFAULT_ROLE_PERMISSIONS.viewer
    });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    const user = userEvent.setup();
    renderEnteredSpace(client, team.id);

    await screen.findByRole('heading', { name: 'Media buyers' });
    await user.click(screen.getByRole('link', { name: 'Space settings' }));
    await screen.findByRole('heading', { name: 'Space settings' });

    // Drive connection (owner) and audit (owner/admin) are not shown to a viewer.
    expect(screen.queryByRole('heading', { name: 'Google Drive storage' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Team audit history' })).toBeNull();
  });

  it('refreshes the entered space after connecting Drive, so landings show sync progress', async () => {
    let isConnected = false;
    const disconnectedTeam = makeTeam({ connectionState: 'none' });
    const connectedTeam = makeTeam({ connectionState: 'connected' });
    const folder = { id: 'root-folder', name: 'Campaign root', driveKind: 'my_drive' as const };
    const listTeams = vi
      .fn()
      .mockImplementation(async () => [isConnected ? connectedTeam : disconnectedTeam]);
    const client = makeClient({
      listTeams,
      getConnectionStatus: vi.fn().mockResolvedValue({ state: 'none' }),
      listFolders: vi.fn().mockResolvedValue({ folders: [folder], nextPageToken: null }),
      confirmDriveRoot: vi.fn().mockImplementation(async input => {
        if (!input.confirmed) {
          return {
            state: 'confirmation_required' as const,
            folder,
            account: 'owner@example.test',
            independentAclWarning: true
          };
        }
        isConnected = true;
        return {
          state: 'connected' as const,
          folder,
          syncState: 'scanning' as const,
          connectionId: 'connection-1'
        };
      }),
      searchCatalog: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        activeFilters: { category: ['landing', 'archive'] },
        facets: {},
        catalogFreshness: { state: 'scanning' as const, lastSyncedAt: null }
      })
    });
    const user = userEvent.setup();
    renderEnteredSpace(client, disconnectedTeam.id, client);

    await screen.findByRole('heading', { name: 'Media buyers' });
    await user.click(screen.getByRole('link', { name: 'Space settings' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    // Opening and selecting are separate actions now, so name the select one.
    await user.click(
      await screen.findByRole('button', { name: 'Campaign root — Use this folder' })
    );
    await user.click(await screen.findByRole('button', { name: 'Confirm folder' }));
    await user.click(screen.getByRole('button', { name: 'Back to space' }));
    await user.click(screen.getByRole('link', { name: 'Landings' }));

    expect(await screen.findByText(/Scanning the connected Google Drive folder/i)).toBeTruthy();
    expect(screen.queryByText(/Google Drive is not connected for this space/i)).toBeNull();
  });

  it('queues a full resync for the already connected folder without replacing it', async () => {
    const team = makeTeam({ connectionState: 'connected' });
    const resyncDrive = vi.fn().mockResolvedValue({
      syncJobId: 'resync-job-1',
      initialSyncState: 'scanning' as const
    });
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([team]),
      resyncDrive
    });
    const user = userEvent.setup();
    renderEnteredSpace(client, team.id);

    await screen.findByRole('heading', { name: 'Media buyers' });
    await user.click(screen.getByRole('link', { name: 'Space settings' }));
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(resyncDrive).toHaveBeenCalledWith(team.id);
    expect(client.listFolders).not.toHaveBeenCalled();
    expect(client.confirmDriveRoot).not.toHaveBeenCalled();
    // By text, not by role: the shell header now carries its own status chip
    // for a degraded realtime channel, so "the status element" is ambiguous.
    expect(
      await screen.findByText('A full scan of the connected folder has been queued.')
    ).toBeTruthy();
  });

  it('keeps Sync now available while the Drive callback has opened folder selection', async () => {
    const previousPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(null, '', '/team?drive=connected');
    try {
      const team = makeTeam({ connectionState: 'connected' });
      const resyncDrive = vi.fn().mockResolvedValue({
        syncJobId: 'resync-job-2',
        initialSyncState: 'scanning' as const
      });
      const client = makeClient({
        listTeams: vi.fn().mockResolvedValue([team]),
        listFolders: vi.fn().mockResolvedValue({
          folders: [{ id: 'folder-1', name: 'Current root', driveKind: 'my_drive' as const }],
          nextPageToken: null
        }),
        resyncDrive
      });
      const user = userEvent.setup();
      renderEnteredSpace(client, team.id);

      await screen.findByRole('heading', { name: 'Media buyers' });
      await user.click(screen.getByRole('link', { name: 'Space settings' }));
      await screen.findByRole('button', { name: 'Current root — Open' });
      await user.click(screen.getByRole('button', { name: 'Sync now' }));

      expect(resyncDrive).toHaveBeenCalledWith(team.id);
      expect(client.confirmDriveRoot).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', previousPath);
    }
  });
});
