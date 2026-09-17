// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageHealth } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { StorageChip } from '../apps/web/src/team/storage/StorageChip';

/**
 * Feature 011 (T070): the chip says one thing per storage state, and the detail
 * behind it offers the one action that fixes it — to the person who can.
 */

afterEach(() => {
  cleanup();
});

function show(
  health: StorageHealth,
  options: {
    isOwner?: boolean;
    canManage?: boolean;
    client?: Parameters<typeof StorageChip>[0]['client'];
  } = {}
) {
  const client = options.client ?? {};
  render(
    <ToastProvider>
      <StorageChip
        teamId="team-1"
        health={health}
        client={client}
        isOwner={options.isOwner ?? false}
        canManage={options.canManage ?? false}
        settingsHref="/team/explorer?settings=1"
      />
    </ToastProvider>
  );
  return client;
}

describe('StorageChip', () => {
  it('reads as indexing, preparing or waiting with live counts, and is quiet when up to date', () => {
    show({ kind: 'indexing', indexedFolders: 3, totalFolders: 12, files: 40 });
    expect(
      screen.getByRole('button', { name: /Indexing · 3 of 12 folders · 40 files/ })
    ).toBeTruthy();
    cleanup();
    show({ kind: 'preparing', ready: 5, pending: 7 });
    expect(screen.getByRole('button', { name: 'Preparing previews · 5 of 12' })).toBeTruthy();
    cleanup();
    show({ kind: 'waiting_provider', since: new Date().toISOString() });
    expect(screen.getByRole('button', { name: 'Waiting for Google Drive…' })).toBeTruthy();
    cleanup();
    // Healthy is the default and says nothing (024, FR-094).
    show({ kind: 'connected', lastReconciledAt: new Date().toISOString() });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says where the indexing runs, so a spinner is not mistaken for a stuck one', async () => {
    // The owner (024): "I pressed pause and it keeps animating — forever?"
    show({ kind: 'indexing', indexedFolders: 185, totalFolders: null, files: 750 });
    await userEvent.click(screen.getByRole('button', { name: /Indexing/ }));
    expect(
      await screen.findByText(
        'The reading happens on our side and carries on with this tab closed.'
      )
    ).toBeTruthy();
  });

  it('asks before re-reading a healthy space, and says what the re-read costs', async () => {
    // The owner pressed "Check now" by accident and set ten thousand files walking (024).
    const resyncDrive = vi.fn().mockResolvedValue(undefined);
    show({ kind: 'preparing', ready: 5, pending: 7 }, { canManage: true, client: { resyncDrive } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Preparing previews/ }));
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(resyncDrive).not.toHaveBeenCalled();
    expect(screen.getByText(/reads the whole Drive again/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Yes, read it all again' }));
    expect(resyncDrive).toHaveBeenCalledWith('team-1');
  });

  it('lets the owner reconnect from the detail and tells a member who can', async () => {
    const user = userEvent.setup();
    const startDriveOAuth = vi.fn(async () => ({
      authorizationUrl: 'https://accounts.google.test/auth',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    show(
      { kind: 'attention', reason: 'needs_reauth', fixer: 'owner' },
      { client: { startDriveOAuth } }
    );
    await user.click(screen.getByRole('button', { name: 'Storage needs the owner to reconnect' }));
    expect(screen.getByText('Only the owner can fix this.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    cleanup();

    show(
      { kind: 'attention', reason: 'needs_reauth', fixer: 'owner' },
      { isOwner: true, canManage: true, client: { startDriveOAuth } }
    );
    await user.click(screen.getByRole('button', { name: 'Storage needs the owner to reconnect' }));
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(startDriveOAuth).toHaveBeenCalledWith('team-1');
    const link = await screen.findByRole('link', { name: 'Continue with Google' });
    expect(link.getAttribute('href')).toBe('https://accounts.google.test/auth');
  });

  it('offers a new scan after a failed sync to anyone who manages the space', async () => {
    const user = userEvent.setup();
    const resyncDrive = vi.fn(async () => undefined);
    show(
      { kind: 'attention', reason: 'sync_failed', fixer: 'manager' },
      { canManage: true, client: { resyncDrive } }
    );
    await user.click(screen.getByRole('button', { name: 'The last sync failed' }));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(resyncDrive).toHaveBeenCalledWith('team-1');
    expect(await screen.findByText('A full scan has been queued')).toBeTruthy();
  });

  it('explains a provider pause without offering a retry that cannot help', async () => {
    const user = userEvent.setup();
    show({ kind: 'waiting_provider', since: new Date().toISOString() }, { canManage: true });
    await user.click(screen.getByRole('button', { name: 'Waiting for Google Drive…' }));
    expect(screen.getByText(/asked Soty to slow down/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });
});
