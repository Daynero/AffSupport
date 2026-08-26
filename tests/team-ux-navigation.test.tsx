// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';
import { adminAuthStub } from './support/auth-stub';

/**
 * US1 — orientation. The claim under test is that a person always knows where
 * they are and can get back there: sections are addresses, the browser's own
 * controls work, and an address that resolves to nothing says so without
 * revealing whether the space exists.
 */

const STORAGE_KEY = 'wishly.active-team.v1';
const SECOND_ID = '20000000-0000-4000-8000-0000000000aa';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const adminAuth = adminAuthStub();

function renderSpace(client: ReturnType<typeof makeClient>, address = '/team') {
  window.history.replaceState(null, '', address);
  return render(
    <AuthContextOverride value={adminAuth}>
      <TeamProvider realtime={false}>
        <TeamSpace client={client} directAddMode="disabled" />
      </TeamProvider>
    </AuthContextOverride>
  );
}

describe('team sections are addresses', () => {
  it('renders the content tabs and marks the active one', async () => {
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    renderSpace(client);

    const tabs = await screen.findByRole('navigation', { name: 'Space sections' });
    for (const label of ['Files', 'Tasks', 'Creatives', 'Landings']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
    // Files is the canonical default and carries no path suffix of its own.
    // Waited for, not read once: the tabs render before the resolver has
    // finished settling the address, and the marking follows the address.
    await waitFor(() =>
      expect(tabs.querySelector('[aria-current="page"]')?.textContent).toBe('Files')
    );
  });

  it('moves the address when a tab is used, and marks the new tab', async () => {
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('link', { name: 'Tasks' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${team.id}/tasks`));
    const tabs = screen.getByRole('navigation', { name: 'Space sections' });
    expect(tabs.querySelector('[aria-current="page"]')?.textContent).toBe('Tasks');
  });

  it('opens the section named by the address on first render', async () => {
    // This is what a refresh, a bookmark and a pasted link all look like.
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    renderSpace(client, `/team/${team.id}/landings`);

    const tabs = await screen.findByRole('navigation', { name: 'Space sections' });
    expect(tabs.querySelector('[aria-current="page"]')?.textContent).toBe('Landings');
  });

  it('walks sections on Back before leaving the space', async () => {
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    const user = userEvent.setup();
    renderSpace(client, `/team/${team.id}`);

    await user.click(await screen.findByRole('link', { name: 'Tasks' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${team.id}/tasks`));
    await user.click(screen.getByRole('link', { name: 'Landings' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${team.id}/landings`));

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${team.id}/tasks`));
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${team.id}`));
  });
});

describe('entering a space', () => {
  it('enters directly when exactly one space is ready', async () => {
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${team.id}`));
    expect(screen.queryByRole('heading', { name: 'Choose a space' })).toBeNull();
  });

  it('holds the lobby when an invitation is waiting to be answered', async () => {
    // Being redirected past an unanswered invitation is how people never see it.
    const team = makeTeam();
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([team]),
      listMyInvitations: vi.fn().mockResolvedValue([
        {
          id: 'invitation-1',
          teamId: team.id,
          teamName: team.name,
          inviterName: 'Olena',
          targetEmail: 'me@example.test',
          initialRole: 'editor' as const,
          state: 'pending' as const,
          deliveryState: 'sent' as const,
          deliveryErrorCode: null,
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      ])
    });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'Choose a space' })).toBeTruthy();
  });

  it('lets the URL beat the remembered space', async () => {
    const first = makeTeam();
    const second = makeTeam({ id: SECOND_ID, name: 'Archive team' });
    localStorage.setItem(STORAGE_KEY, first.id);
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([first, second]) });
    renderSpace(client, `/team/${second.id}`);

    expect(await screen.findByRole('heading', { name: /Archive team/ })).toBeTruthy();
  });

  it('answers an unknown space with one neutral screen that names nothing', async () => {
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([makeTeam()]) });
    renderSpace(client, '/team/20000000-0000-4000-8000-0000000000ff');

    const heading = await screen.findByRole('heading', { name: 'This space is not available' });
    expect(heading).toBeTruthy();
    // No name, no counts: the screen must not distinguish absent from denied.
    expect(document.body.textContent).not.toContain('Media buyers');
  });
});

describe('space switcher', () => {
  it('hangs off the space name and lists the other spaces', async () => {
    const first = makeTeam();
    const second = makeTeam({ id: SECOND_ID, name: 'Archive team' });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([first, second]) });
    const user = userEvent.setup();
    renderSpace(client, `/team/${first.id}`);

    await user.click(await screen.findByRole('button', { name: /Media buyers/ }));
    await user.click(await screen.findByRole('link', { name: /Archive team/ }));
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${second.id}`));
  });

  /**
   * This used to assert a plain heading, on the reasoning that a switcher with
   * nowhere to switch to is a control that cannot act (FR-015). The premise was
   * wrong: the menu always carries the way back to the lobby, and the lobby is
   * the only place the create wizard lives. Hiding it left the owner of a
   * single space — which is what the beta fixture and every new account is —
   * with no route to a second one.
   */
  it('still opens, because the lobby is always somewhere to go', async () => {
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    const user = userEvent.setup();
    renderSpace(client, `/team/${team.id}`);

    await user.click(await screen.findByRole('button', { name: /Media buyers/ }));
    expect(await screen.findByRole('link', { name: 'All spaces' })).toBeTruthy();
    // Nothing to switch to, so nothing pretends there is.
    expect(screen.queryByText('Other spaces')).toBeNull();
  });

  /**
   * The loop this closes, found by driving the real stack: "All spaces"
   * navigated to `/team`, the resolver read that as an ordinary arrival and
   * sent the person back into the space they had just left, and entering
   * rewrote the remembered id that leaving had cleared. Two ready spaces were
   * not enough to escape it. The unit suite could not see it because jsdom
   * starts with an empty `localStorage`, so the remembered rule never fired —
   * hence the explicit seed here.
   */
  it('reaches the lobby even when a space is remembered', async () => {
    const first = makeTeam();
    const second = makeTeam({ id: SECOND_ID, name: 'Archive team' });
    localStorage.setItem(STORAGE_KEY, first.id);
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([first, second]) });
    const user = userEvent.setup();
    renderSpace(client, `/team/${first.id}`);

    await user.click(await screen.findByRole('button', { name: /Media buyers/ }));
    await user.click(await screen.findByRole('link', { name: 'All spaces' }));

    expect(await screen.findByRole('heading', { name: 'Choose a space' })).toBeTruthy();
  });
});

describe('create wizard', () => {
  it('steps back to the name step with what was typed still there', async () => {
    const draft = makeTeam({
      id: '20000000-0000-4000-8000-0000000000c2',
      name: 'Media buyers',
      connectionState: 'none'
    });
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([]),
      createTeam: vi.fn().mockResolvedValue(draft),
      listFolders: vi.fn().mockResolvedValue({ folders: [], nextPageToken: null })
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Create your first space' }));
    await user.type(screen.getByLabelText('Space name'), 'Media buyers');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByLabelText('Space name')).toHaveProperty('value', 'Media buyers');

    // Continuing with the same name reuses the draft rather than colliding with
    // it — `create_team` refuses a duplicate name among your own spaces.
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Cancel' });
    expect(client.createTeam).toHaveBeenCalledTimes(1);
  });
});
