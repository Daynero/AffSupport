// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

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

  it('shows the showcase page — not a gate, not a donation — to someone without a space (034)', async () => {
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'A space to work together' })).toBeTruthy();
    // A page with one way forward: no modal, no waiting list, no "speed up development".
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Write to the administrator' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Speed up development' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create your first space' })).toBeNull();
  });
});
