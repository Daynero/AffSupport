// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
    expect(spaceReadiness(makeTeam({ connectionState: 'pending' }))).toBe('preparing');
    expect(spaceReadiness(makeTeam({ connectionState: 'none' }))).toBe('setup_incomplete');
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
