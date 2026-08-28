// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import type { DriveRootResult } from '../apps/web/src/api/team';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';
import { adminAuthStub } from './support/auth-stub';

const NEW_ID = '20000000-0000-4000-8000-0000000000c2';
const folder = { id: 'root-folder', name: 'Team media', driveKind: 'my_drive' as const };
/** What Google's chooser hands back (011); the chooser itself is injected. */
const picked = { id: folder.id, name: folder.name, mimeType: null, resourceKey: null };

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function wizardClient() {
  return makeClient({
    listTeams: vi.fn().mockResolvedValue([]),
    createTeam: vi
      .fn()
      .mockResolvedValue(makeTeam({ id: NEW_ID, name: 'Media buyers', connectionState: 'none' })),
    pickFolders: vi.fn().mockResolvedValue([picked]),
    chooseRoot: vi
      .fn()
      .mockResolvedValue({ state: 'connected', folder, syncState: 'queued' } as DriveRootResult)
  });
}

function renderSpace(client: ReturnType<typeof makeClient>) {
  const adminAuth = adminAuthStub();
  return render(
    <AuthContextOverride value={adminAuth}>
      <TeamProvider realtime={false}>
        <TeamSpace client={client} directAddMode="disabled" />
      </TeamProvider>
    </AuthContextOverride>
  );
}

describe('create space wizard', () => {
  it('requires a name and a connected folder, then opens the new space', async () => {
    const client = wizardClient();
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Create your first space' }));

    // Name step: Continue is blocked until a valid name is entered.
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('Space name'), 'Media buyers');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Folder step: two inputs in total — the name, and a folder picked in
    // Google's chooser. Nothing to confirm afterwards (011, FR-001).
    expect(
      await screen.findByRole('heading', { name: 'Connect a Google Drive folder' })
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Choose folder in Google Drive' }));

    // Completion lands in the new space's workspace shell.
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    await waitFor(() => {
      expect(client.createTeam).toHaveBeenCalledWith('Media buyers');
      expect(client.chooseRoot).toHaveBeenLastCalledWith(
        expect.objectContaining({ teamId: NEW_ID, folderId: 'root-folder', name: 'Team media' })
      );
    });
    expect(screen.queryByRole('button', { name: 'Confirm folder' })).toBeNull();
  });

  it('leaves setup where it was when the chooser is closed, and connects on the next pick', async () => {
    const pickFolders = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([picked]);
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([]),
      createTeam: vi
        .fn()
        .mockResolvedValue(makeTeam({ id: NEW_ID, name: 'Media buyers', connectionState: 'none' })),
      pickFolders,
      chooseRoot: vi
        .fn()
        .mockResolvedValue({ state: 'connected', folder, syncState: 'queued' } as DriveRootResult)
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Create your first space' }));
    await user.type(screen.getByLabelText('Space name'), 'Media buyers');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));

    // Closed without picking: still on the folder step, nothing connected.
    await user.click(await screen.findByRole('button', { name: 'Choose folder in Google Drive' }));
    await waitFor(() => expect(pickFolders).toHaveBeenCalledTimes(1));
    expect(client.chooseRoot).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Connect a Google Drive folder' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Choose folder in Google Drive' }));
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    await waitFor(() => {
      expect(client.chooseRoot).toHaveBeenLastCalledWith(
        expect.objectContaining({ teamId: NEW_ID, folderId: 'root-folder' })
      );
    });
  });

  it('leaves an abandoned setup as a resumable "Continue setup" card, not a ready space', async () => {
    const client = wizardClient();
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Create your first space' }));
    await user.type(screen.getByLabelText('Space name'), 'Media buyers');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByRole('heading', { name: 'Connect a Google Drive folder' })
    ).toBeTruthy();

    // Abandon before connecting a folder.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // The space is shown only as "Continue setup", never as a ready/openable space.
    const card = await screen.findByRole('button', { name: /Media buyers/ });
    expect(card.textContent).toContain('Continue setup');
    expect(card.textContent).not.toContain('Open');
  });
});
