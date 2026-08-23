// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveConnectionPanel } from '../apps/web/src/team/drive/DriveConnectionPanel';
import type { DrivePanelClient } from '../apps/web/src/team/drive/DriveConnectionPanel';
import { ToastProvider } from '../apps/web/src/components/toast';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEAM = 'team-1';

const folder = (id: string, name: string) => ({
  id,
  name,
  driveKind: 'my_drive' as const,
  resourceKey: null
});

/**
 * A tree two levels deep. The materials a real team wants to connect almost
 * never sit at the account root, so `Creatives` is reachable only by opening
 * `Work` first.
 */
const TREE: Record<string, ReturnType<typeof folder>[]> = {
  root: [folder('work', 'Work'), folder('personal', 'Personal')],
  work: [folder('creatives', 'Creatives')],
  creatives: []
};

function makePanelClient(overrides: Partial<DrivePanelClient> = {}): DrivePanelClient {
  return {
    getConnectionStatus: vi.fn().mockResolvedValue({ state: 'none' }),
    listFolders: vi.fn(async (_team: string, parentId = 'root') => ({
      folders: TREE[parentId] ?? [],
      nextPageToken: null
    })),
    confirmDriveRoot: vi.fn(async ({ confirmed, folderId }) =>
      confirmed
        ? { state: 'connected' as const, syncJobId: 'job-1' }
        : {
            state: 'confirmation_required' as const,
            folder: folder(folderId, folderId),
            account: 'owner@example.com',
            independentAclWarning: true
          }
    ),
    ...overrides
  } as DrivePanelClient;
}

describe('drive folder navigation', () => {
  it('reaches a nested folder and connects it as the space root', async () => {
    const client = makePanelClient();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <DriveConnectionPanel teamId={TEAM} client={client} />
      </ToastProvider>
    );

    // No startDriveOAuth on this client, so connecting lists the root directly.
    await user.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    await screen.findByRole('button', { name: 'Work — Open' });

    // Opening must navigate, never select.
    await user.click(screen.getByRole('button', { name: 'Work — Open' }));
    await screen.findByRole('button', { name: 'Creatives — Open' });
    expect(client.confirmDriveRoot).not.toHaveBeenCalled();
    expect(client.listFolders).toHaveBeenLastCalledWith(TEAM, 'work', null);

    // The nested folder is now selectable, which it never was before.
    await user.click(screen.getByRole('button', { name: 'Creatives — Use this folder' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm folder' }));

    expect(client.confirmDriveRoot).toHaveBeenLastCalledWith({
      teamId: TEAM,
      folderId: 'creatives',
      resourceKey: null,
      expectedAccount: 'owner@example.com',
      confirmed: true
    });
  });

  it('walks back up the trail and can select the folder currently open', async () => {
    const client = makePanelClient();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <DriveConnectionPanel teamId={TEAM} client={client} />
      </ToastProvider>
    );

    await user.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Work — Open' }));
    await user.click(await screen.findByRole('button', { name: 'Creatives — Open' }));

    // An empty folder still has to be selectable — that is the whole point of
    // being able to commit the folder you are standing in.
    expect(
      await screen.findByText('This folder has no subfolders. Use it as it is, or go back.')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use the open folder' }));
    expect(client.confirmDriveRoot).toHaveBeenLastCalledWith({
      teamId: TEAM,
      folderId: 'creatives',
      resourceKey: null,
      confirmed: false
    });

    // Going back to the account root re-lists it rather than keeping stale rows.
    await user.click(screen.getByRole('button', { name: 'Google Drive' }));
    await screen.findByRole('button', { name: 'Work — Open' });
    expect(client.listFolders).toHaveBeenLastCalledWith(TEAM, 'root', null);
    expect(screen.queryByRole('button', { name: 'Creatives — Open' })).toBeNull();
  });
});
