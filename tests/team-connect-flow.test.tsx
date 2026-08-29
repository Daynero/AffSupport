// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamApiError } from '../apps/web/src/api/team';
import {
  ConnectStorageFlow,
  type ConnectStorageClient
} from '../apps/web/src/team/storage/ConnectStorageFlow';
import { DriveConnectionPanel } from '../apps/web/src/team/drive/DriveConnectionPanel';
import { SelectionList } from '../apps/web/src/team/storage/SelectionList';
import type { PickFolders } from '../apps/web/src/team/storage/loadPicker';

/**
 * Feature 011 (T025): connecting storage is two inputs — authorize Google,
 * pick the folder in Google's chooser — and the space opens on the pick.
 * The chooser itself is injected through the client: what is under test is
 * the flow around it.
 */

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/team');
  vi.restoreAllMocks();
});

const TEAM = 'team-1';
const CONFIG = { apiKey: 'AIzaKey', appId: '123456' };

const picks =
  (folders: Array<{ id: string; name: string }> | null): PickFolders =>
  async () =>
    folders?.map(folder => ({ ...folder, mimeType: null, resourceKey: null })) ?? null;

function makeClient(overrides: Partial<ConnectStorageClient> = {}): ConnectStorageClient {
  return {
    startDriveOAuth: vi
      .fn()
      .mockResolvedValue({ authorizationUrl: 'https://accounts.google.test/auth', expiresAt: 'x' }),
    pickerToken: vi.fn().mockResolvedValue({ accessToken: 'picker-token', expiresAt: 'later' }),
    chooseRoot: vi.fn().mockResolvedValue({
      state: 'connected',
      folder: { id: 'campaigns', name: 'Campaigns', driveKind: 'my_drive', resourceKey: null },
      syncState: 'queued',
      connectionId: 'connection-1'
    }),
    pickFolders: picks([{ id: 'campaigns', name: 'Campaigns' }]),
    ...overrides
  };
}

function renderFlow(
  client: ConnectStorageClient,
  onConnected = vi.fn(),
  config: { apiKey: string; appId: string } | null = CONFIG
) {
  return {
    onConnected,
    ...render(
      <ConnectStorageFlow
        teamId={TEAM}
        client={client}
        onConnected={onConnected}
        onCancel={() => undefined}
        config={config}
      />
    )
  };
}

describe('ConnectStorageFlow', () => {
  it('offers Google first, then the chooser after the callback, and opens the space on a pick', async () => {
    const user = userEvent.setup();
    const pickFolders = vi.fn(picks([{ id: 'campaigns', name: 'Campaigns' }]));
    const client = makeClient({ pickFolders });
    const onConnected = vi.fn();

    const first = renderFlow(client, onConnected);
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    expect(
      (await screen.findByRole('link', { name: 'Continue with Google' }))?.getAttribute('href')
    ).toBe('https://accounts.google.test/auth');
    expect(screen.queryByRole('button', { name: /Choose folder/ })).toBeNull();
    first.unmount();

    // Back from Google: the address says so, and the chooser is the only step left.
    window.history.replaceState(null, '', `/team/${TEAM}?drive=connected`);
    renderFlow(client, onConnected);
    expect(screen.getByText(/Soty permissions are independent/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Choose folder in Google Drive' }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(client.pickerToken).toHaveBeenCalledWith(TEAM);
    expect(pickFolders).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'picker-token', config: CONFIG })
    );
    expect(client.chooseRoot).toHaveBeenCalledWith({
      teamId: TEAM,
      folderId: 'campaigns',
      resourceKey: null,
      name: 'Campaigns'
    });
    expect(screen.queryByText(/confirm/i)).toBeNull();
  });

  it('does nothing on cancel, and explains a chooser that is not configured', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/team/${TEAM}?drive=connected`);
    const client = makeClient({ pickFolders: picks(null) });
    const { onConnected, unmount } = renderFlow(client);
    await user.click(screen.getByRole('button', { name: 'Choose folder in Google Drive' }));
    await waitFor(() => expect(client.pickerToken).toHaveBeenCalled());
    expect(client.chooseRoot).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    unmount();

    // No injected chooser and no keys: the real chooser cannot open, so say so.
    renderFlow(makeClient({ pickFolders: undefined }), vi.fn(), null);
    await user.click(screen.getByRole('button', { name: 'Choose folder in Google Drive' }));
    expect(await screen.findByText(/folder chooser is not configured/)).toBeTruthy();
  });

  it('names the scope gate and a chooser that failed to load', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/team/${TEAM}?drive=connected`);
    const { unmount } = renderFlow(
      makeClient({
        chooseRoot: vi
          .fn()
          .mockRejectedValue(new TeamApiError('RESTRICTED_SCOPE_NOT_APPROVED', false))
      })
    );
    await user.click(screen.getByRole('button', { name: 'Choose folder in Google Drive' }));
    expect(await screen.findByText(/not approved for production/)).toBeTruthy();
    unmount();

    const failing: PickFolders = async () => {
      throw Object.assign(new Error('PICKER_UNAVAILABLE'), { code: 'PICKER_UNAVAILABLE' });
    };
    renderFlow(makeClient({ pickFolders: failing }));
    await user.click(screen.getByRole('button', { name: 'Choose folder in Google Drive' }));
    expect(await screen.findByText(/folder chooser did not load/)).toBeTruthy();
  });
});

describe('DriveConnectionPanel (settings)', () => {
  it('replaces the root through the chooser and offers restore when the root is gone', async () => {
    const user = userEvent.setup();
    const replaceDriveRoot = vi.fn().mockResolvedValue({
      state: 'connected',
      folder: { id: 'new-root', name: 'New root', driveKind: 'my_drive', resourceKey: null },
      syncState: 'queued'
    });
    const restoreRoot = vi.fn().mockResolvedValue({
      state: 'connected',
      folder: { id: 'root', name: 'Root', driveKind: 'my_drive', resourceKey: null },
      syncState: 'ready'
    });
    const client = {
      getConnectionStatus: vi
        .fn()
        .mockResolvedValue({ state: 'connected', rootFolderName: 'Root', connectionId: 'c1' }),
      pickerToken: vi.fn().mockResolvedValue({ accessToken: 'picker-token', expiresAt: 'later' }),
      chooseRoot: vi.fn(),
      replaceDriveRoot,
      restoreRoot,
      pickFolders: picks([{ id: 'new-root', name: 'New root' }])
    };
    const { unmount } = render(
      <ToastProvider>
        <DriveConnectionPanel teamId={TEAM} client={client} config={CONFIG} />
      </ToastProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Replace folder' }));
    await waitFor(() =>
      expect(replaceDriveRoot).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: TEAM, folderId: 'new-root', folderName: 'New root' })
      )
    );
    expect(await screen.findByText('New root')).toBeTruthy();
    unmount();

    render(
      <ToastProvider>
        <DriveConnectionPanel
          teamId={TEAM}
          client={{
            ...client,
            pickFolders: picks(null),
            getConnectionStatus: vi
              .fn()
              .mockResolvedValue({ state: 'root_missing', rootFolderName: 'Root' })
          }}
          config={CONFIG}
        />
      </ToastProvider>
    );
    expect(await screen.findByText(/was deleted in Google Drive/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore from trash' }));
    await waitFor(() => expect(restoreRoot).toHaveBeenCalledWith(TEAM));
    expect(await screen.findByText('The folder is back.')).toBeTruthy();
  });

  it('carries a reconnect on a connected space through to Google', async () => {
    const user = userEvent.setup();
    const startDriveOAuth = vi
      .fn()
      .mockResolvedValue({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
        expiresAt: 'later'
      });
    render(
      <ToastProvider>
        <DriveConnectionPanel
          teamId={TEAM}
          client={{
            getConnectionStatus: vi
              .fn()
              .mockResolvedValue({
                state: 'connected',
                rootFolderName: 'Root',
                connectionId: 'c1'
              }),
            startDriveOAuth,
            pickerToken: vi.fn(),
            chooseRoot: vi.fn(),
            pickFolders: picks(null)
          }}
          config={CONFIG}
        />
      </ToastProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(startDriveOAuth).toHaveBeenCalledWith(TEAM));
    // The address came back; the step to Google must be on screen, not swallowed.
    expect(
      (await screen.findByRole('link', { name: 'Continue with Google' })).getAttribute('href')
    ).toContain('accounts.google.com');
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });
});

describe('SelectionList (research R1 outcome B)', () => {
  it('adds picked folders one by one and maps a refused folder to copy', async () => {
    const user = userEvent.setup();
    const addDriveSelection = vi
      .fn()
      .mockResolvedValueOnce({
        id: 's2',
        driveFolderId: 'b',
        name: 'B',
        isRoot: false,
        state: 'active'
      })
      .mockRejectedValueOnce(new TeamApiError('SELECTION_UNREACHABLE', false));
    render(
      <ToastProvider>
        <SelectionList
          teamId={TEAM}
          canManage
          client={{
            listDriveSelections: vi
              .fn()
              .mockResolvedValue([
                { id: 's1', driveFolderId: 'root', name: 'Root', isRoot: true, state: 'active' }
              ]),
            addDriveSelection,
            removeDriveSelection: vi.fn().mockResolvedValue(undefined),
            pickerToken: vi.fn().mockResolvedValue({ accessToken: 'picker-token', expiresAt: 'x' }),
            pickFolders: picks([
              { id: 'b', name: 'B' },
              { id: 'outside', name: 'Outside' }
            ])
          }}
          config={CONFIG}
        />
      </ToastProvider>
    );
    expect(await screen.findByText(/main folder/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add folders' }));
    expect(await screen.findByText('B')).toBeTruthy();
    expect(await screen.findByText(/cannot reach that folder/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });
});
