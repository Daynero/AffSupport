// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('heading', { name: 'Space history' })).toBeTruthy();
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
    expect(screen.queryByRole('heading', { name: 'Space history' })).toBeNull();
  });

  it('refreshes the entered space after connecting Drive, so the storage chip shows indexing', async () => {
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
      // 011: the folder is picked in Google's chooser, injected here.
      pickFolders: async () => [
        { id: folder.id, name: folder.name, mimeType: null, resourceKey: null }
      ],
      chooseRoot: vi.fn().mockImplementation(async () => {
        isConnected = true;
        return {
          state: 'connected' as const,
          folder,
          syncState: 'scanning' as const,
          connectionId: 'connection-1'
        };
      }),
      // The storage chip (011, US4) reads one health value; the scan is in flight.
      getStorageHealth: vi
        .fn()
        .mockImplementation(async () =>
          isConnected
            ? { kind: 'indexing' as const, indexedFolders: 1, totalFolders: null, files: 3 }
            : { kind: 'disconnected' as const }
        )
    });
    const user = userEvent.setup();
    renderEnteredSpace(client, disconnectedTeam.id, client);

    await screen.findByRole('heading', { name: 'Media buyers' });
    await user.click(screen.getByRole('link', { name: 'Space settings' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    // No server-side browse and nothing to confirm: pick, and it is connected.
    await user.click(await screen.findByRole('button', { name: 'Choose folder in Google Drive' }));
    await waitFor(() =>
      expect(client.chooseRoot).toHaveBeenCalledWith(
        expect.objectContaining({ folderId: 'root-folder', name: 'Campaign root' })
      )
    );
    await user.click(screen.getByRole('button', { name: 'Back to space' }));

    // The space-wide storage chip, in the header of every view (011): no per-tab copy.
    expect(await screen.findByRole('button', { name: /Indexing · 3 files so far/ })).toBeTruthy();
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
    expect(client.chooseRoot).not.toHaveBeenCalled();
    // By text, not by role: the shell header now carries its own status chip
    // for a degraded realtime channel, so "the status element" is ambiguous.
    expect(
      await screen.findByText('A full scan of the connected folder has been queued.')
    ).toBeTruthy();
  });

  it('carries the Drive return code into the space address with an ampersand', async () => {
    // Found on the beta stack: the built route already ends in `?settings=1`,
    // and the code was appended with a second `?`. The parameter became part
    // of the settings value, so coming back from Google landed on the
    // create-space wizard instead of the folder it had just authorised.
    const previousPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(null, '', '/team?drive=connected');
    try {
      const team = makeTeam({ connectionState: 'connected' });
      const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
      renderEnteredSpace(client, team.id);

      await screen.findByRole('heading', { name: 'Media buyers' });
      await waitFor(() => {
        expect(window.location.search).toContain('settings=1');
        expect(window.location.search).toContain('drive=connected');
      });
      expect(new URLSearchParams(window.location.search).get('settings')).toBe('1');
      expect(new URLSearchParams(window.location.search).get('drive')).toBe('connected');
    } finally {
      window.history.replaceState(null, '', previousPath);
    }
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
        resyncDrive
      });
      const user = userEvent.setup();
      renderEnteredSpace(client, team.id);

      await screen.findByRole('heading', { name: 'Media buyers' });
      await user.click(screen.getByRole('link', { name: 'Space settings' }));
      await user.click(await screen.findByRole('button', { name: 'Sync now' }));

      expect(resyncDrive).toHaveBeenCalledWith(team.id);
      expect(client.chooseRoot).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', previousPath);
    }
  });
});
