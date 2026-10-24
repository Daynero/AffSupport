// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';
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

  it('keeps the public entry closed before the announcement without offering plans or creation', async () => {
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'Workspace in development' })).toBeTruthy();
    // Keep the closed entry quiet until the announcement.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write to the administrator' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Speed up development' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create your first space' })).toBeNull();
  });
});
