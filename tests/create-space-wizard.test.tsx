// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';
import { adminAuthStub } from './support/auth-stub';

const NEW_ID = '20000000-0000-4000-8000-0000000000c2';
const folder = { id: 'root-folder', name: 'Team media', driveKind: 'my_drive' as const };

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
    listFolders: vi.fn().mockResolvedValue({ folders: [folder], nextPageToken: null }),
    confirmDriveRoot: vi
      .fn()
      .mockResolvedValueOnce({
        state: 'confirmation_required',
        folder,
        account: 'owner@example.test',
        independentAclWarning: true
      })
      .mockResolvedValueOnce({ state: 'connected', folder, syncState: 'queued' })
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

    // Folder step: cannot finish until a root is connected.
    expect(
      await screen.findByRole('heading', { name: 'Connect a Google Drive folder' })
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Team media — Use this folder' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm folder' }));

    // Completion lands in the new space's workspace shell.
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    await waitFor(() => {
      expect(client.createTeam).toHaveBeenCalledWith('Media buyers');
      expect(client.confirmDriveRoot).toHaveBeenLastCalledWith(
        expect.objectContaining({ teamId: NEW_ID, folderId: 'root-folder', confirmed: true })
      );
    });
  });

  it('connects a nested folder and lets a wrong pick be taken back', async () => {
    // The folder a team actually wants is rarely at the account root.
    const tree: Record<string, { id: string; name: string; driveKind: 'my_drive' }[]> = {
      root: [{ id: 'work', name: 'Work', driveKind: 'my_drive' }],
      work: [{ id: 'creatives', name: 'Creatives', driveKind: 'my_drive' }]
    };
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([]),
      createTeam: vi
        .fn()
        .mockResolvedValue(makeTeam({ id: NEW_ID, name: 'Media buyers', connectionState: 'none' })),
      listFolders: vi.fn(async (_team: string, parentId = 'root') => ({
        folders: tree[parentId] ?? [],
        nextPageToken: null
      })),
      confirmDriveRoot: vi.fn(async (input: { folderId: string; confirmed: boolean }) =>
        input.confirmed
          ? { state: 'connected', folder: tree.work[0], syncState: 'queued' }
          : {
              state: 'confirmation_required',
              folder: { id: input.folderId, name: input.folderId, driveKind: 'my_drive' },
              account: 'owner@example.test',
              independentAclWarning: true
            }
      )
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Create your first space' }));
    await user.type(screen.getByLabelText('Space name'), 'Media buyers');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Google Drive' }));

    // Pick the wrong folder first, then take it back without abandoning setup.
    await user.click(await screen.findByRole('button', { name: 'Work — Use this folder' }));
    await user.click(await screen.findByRole('button', { name: 'Choose a different folder' }));

    // Descend and connect the folder that is actually wanted.
    await user.click(await screen.findByRole('button', { name: 'Work — Open' }));
    await user.click(await screen.findByRole('button', { name: 'Creatives — Use this folder' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm folder' }));

    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    await waitFor(() => {
      expect(client.confirmDriveRoot).toHaveBeenLastCalledWith(
        expect.objectContaining({ teamId: NEW_ID, folderId: 'creatives', confirmed: true })
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
