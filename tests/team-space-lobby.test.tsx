// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    expect(await screen.findByRole('heading', { name: 'Choose a space' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Media buyers/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Archive team/ })).toBeTruthy();

    // Enter a space → its workspace shell opens.
    await user.click(screen.getByRole('button', { name: /Media buyers/ }));
    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Choose a space' })).toBeNull();

    // Changing space now hangs off the space name itself: open the switcher and
    // take the "all spaces" way back to the lobby.
    await user.click(screen.getByRole('button', { name: /Media buyers/ }));
    await user.click(await screen.findByRole('link', { name: 'All spaces' }));
    expect(await screen.findByRole('heading', { name: 'Choose a space' })).toBeTruthy();
  });

  it('blocks users without a team behind the workspace launch gate', async () => {
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });
    renderSpace(client);

    expect(
      await screen.findByRole('heading', { name: 'Team spaces are still in closed beta' })
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Notify me when it’s ready' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Speed up development' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create your first space' })).toBeNull();
  });

  it('closes the workspace launch gate and returns home when its backdrop is pressed', async () => {
    history.replaceState(null, '', '/team');
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });
    renderSpace(client);

    const dialog = await screen.findByRole('dialog');
    fireEvent.pointerDown(dialog.parentElement!);

    expect(
      screen.queryByRole('heading', { name: 'Team spaces are still in closed beta' })
    ).toBeNull();
    expect(location.pathname).toBe('/');
  });

  it('closes the workspace launch gate before opening the donation dialog', async () => {
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Speed up development' }));

    expect(
      screen.queryByRole('heading', { name: 'Team spaces are still in closed beta' })
    ).toBeNull();
    expect(screen.getByRole('heading', { name: 'Support the project' })).toBeTruthy();
  });
});
