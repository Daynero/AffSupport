// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';
import { spaceReadiness } from '../apps/web/src/team/lobby/SpaceCard';
// Prepare real lazy route transforms outside the interaction deadline.
// Component mounting and section state are still exercised through TeamSpace.
import '../apps/web/src/team/workspace/WorkspaceShell';
import '../apps/web/src/team/explorer/ExplorerShell';

afterEach(() => {
  cleanup();
  localStorage.clear();
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

function renderSpace(client: ReturnType<typeof makeClient>) {
  return render(
    <TeamProvider realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
}

describe('team space lobby', () => {
  it('keeps missing-root recovery limited to the owner', () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      expect(spaceReadiness(makeTeam({ role, connectionState: 'root_missing' }))).toBe('preparing');
    }
    expect(spaceReadiness(makeTeam({ role: 'editor', connectionState: 'pending' }))).toBe(
      'preparing'
    );
    expect(spaceReadiness(makeTeam({ connectionState: 'none' }))).toBe('setup_incomplete');
  });

  it('never leaves an owner outside their own space (2026-11-25)', () => {
    // An expired Google sign-in, a folder Google cannot reach, a connection left half-made:
    // the owner goes in, where the controls that fix it are.
    for (const connectionState of ['needs_reauth', 'unavailable', 'pending'] as const) {
      expect(spaceReadiness(makeTeam({ connectionState }))).toBe('ready');
    }
    // Signing in again is the owner's to do, but the indexed catalog stays readable (011, FR-033).
    expect(spaceReadiness(makeTeam({ role: 'viewer', connectionState: 'needs_reauth' }))).toBe(
      'ready'
    );
  });

  it('gives a member of a space still being set up a way out', async () => {
    history.replaceState(null, '', '/team?all=1');
    // The server forgets the membership once it is left, as the real one does.
    let left = false;
    const client = makeClient({
      listTeams: vi.fn(async () =>
        left ? [] : [makeTeam({ role: 'editor', connectionState: 'pending' })]
      ),
      leaveTeam: vi.fn(async () => {
        left = true;
        return { ok: true as const, warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' };
      })
    });
    const user = userEvent.setup();
    renderSpace(client);
    expect(await screen.findByText('This space is still being set up.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave space…' }));
    expect(await screen.findByRole('dialog', { name: 'Leave “Media buyers”?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Leave this space' }));
    expect(client.leaveTeam).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000001');
    // Off the list at once: the resolver must not send them back into the space they left.
    await waitFor(() => expect(screen.queryByText('This space is still being set up.')).toBeNull());
  });

  it('sends an owner with people in the space to the transfer, not to a delete', async () => {
    history.replaceState(null, '', '/team?all=1');
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([makeTeam({ connectionState: 'needs_reauth' })]),
      getSpaceRemovalPreview: vi.fn().mockResolvedValue({
        role: 'owner',
        otherMembers: 2,
        pendingInvitations: 0,
        files: 4,
        catalogs: 0,
        tasks: 0,
        launches: 0,
        accounts: 0,
        storedVideos: 0,
        tariff: false,
        driveFolder: 'Media'
      })
    });
    const user = userEvent.setup();
    renderSpace(client);
    await user.click(await screen.findByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete space…' }));
    expect(await screen.findByRole('dialog', { name: 'Transfer ownership first' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete space' })).toBeNull();
    expect(client.deleteSpace).not.toHaveBeenCalled();
  });

  it('lists what an owner alone loses and what stays before the five-second hold', async () => {
    history.replaceState(null, '', '/team?all=1');
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([makeTeam({ connectionState: 'pending' })]),
      getSpaceRemovalPreview: vi.fn().mockResolvedValue({
        role: 'owner',
        otherMembers: 0,
        pendingInvitations: 1,
        files: 11,
        catalogs: 2,
        tasks: 0,
        launches: 0,
        accounts: 0,
        storedVideos: 0,
        tariff: true,
        driveFolder: 'Media'
      })
    });
    const user = userEvent.setup();
    renderSpace(client);
    await user.click(await screen.findByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete space…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Media buyers”?' });
    expect(dialog.textContent).toContain('Files in the space’s catalog11');
    expect(dialog.textContent).toContain('Product catalogs2');
    expect(dialog.textContent).not.toContain('Tasks');
    expect(dialog.textContent).toContain(
      'The “Media” folder and every file in your Google Drive stay'
    );
    expect(dialog.textContent).toContain('moves to the next space you create');
    // A click is not a decision.
    await user.click(screen.getByRole('button', { name: 'Delete space' }));
    expect(client.deleteSpace).not.toHaveBeenCalled();
  });

  it('lets the owner enter an existing space with a missing Drive root for recovery', async () => {
    history.replaceState(null, '', '/team?all=1');
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([makeTeam({ connectionState: 'root_missing' })])
    });
    renderSpace(client);
    expect(await screen.findByText(/The owner can restore the folder/)).toBeTruthy();
    expect(screen.queryByText('Being set up')).toBeNull();
    await userEvent.setup().click(await screen.findByRole('button', { name: /Media buyers/ }));
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    expect(screen.queryByText('This space is still being set up.')).toBeNull();
  });

  it('shows the lobby with space cards and enters the chosen space', async () => {
    const other = makeTeam({ id: '20000000-0000-4000-8000-0000000000aa', name: 'Archive team' });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([makeTeam(), other]) });
    const user = userEvent.setup();
    renderSpace(client);

    // Lobby first: both spaces listed, no workspace heading yet.
    expect(await screen.findByRole('heading', { name: 'Your spaces' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Media buyers/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Archive team/ })).toBeTruthy();

    // Enter a space → its workspace shell opens.
    await user.click(screen.getByRole('button', { name: /Media buyers/ }));
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your spaces' })).toBeNull();

    // Changing space now hangs off the space name itself: open the switcher and
    // take the "all spaces" way back to the lobby.
    await user.click(screen.getByRole('button', { name: /Media buyers/ }));
    await user.click(await screen.findByRole('link', { name: 'All spaces' }));
    expect(await screen.findByRole('heading', { name: 'Your spaces' })).toBeTruthy();
  });

  it('offers public plans without granting space creation', async () => {
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Write to the administrator' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Speed up development' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create your first space' })).toBeNull();
  });
});
