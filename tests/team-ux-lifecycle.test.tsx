// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { ToastProvider } from '../apps/web/src/components/toast';
import { SpaceComingSoon } from '../apps/web/src/team/SpaceComingSoon';
import { SpaceStatePanel } from '../apps/web/src/team/workspace/SpaceStatePanel';
import { makeClient, makeTeam } from './team-space-fixtures';
import { adminAuthStub } from './support/auth-stub';

/**
 * US4 — the membership lifecycle has no dead ends.
 *
 * Findings behind these: invitations were visible only on the account page
 * (I1), there was no way to leave a space at all (I2), an abandoned wizard left
 * a permanent half-space (I3), and a disconnected space looked simply empty
 * (I4).
 */

const SPACE_ID = '20000000-0000-4000-8000-000000000001';

afterEach(() => {
  // Unmount effects before restoring their async client implementations.
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const adminAuth = adminAuthStub();

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invitation-1',
    teamId: SPACE_ID,
    teamName: 'Media buyers',
    inviterName: 'Olena',
    targetEmail: 'me@example.test',
    initialRole: 'editor' as const,
    state: 'pending' as const,
    deliveryState: 'sent' as const,
    deliveryErrorCode: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides
  };
}

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

describe('invitations in the lobby', () => {
  it('shows a waiting invitation where spaces are chosen, with who and which role', async () => {
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([]),
      listMyInvitations: vi.fn().mockResolvedValue([invitation()])
    });
    renderSpace(client);

    expect(await screen.findByText('Media buyers')).toBeTruthy();
    expect(screen.getByText('From Olena · joining as Editor')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('enters the space on accept', async () => {
    const acceptInvitation = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([]),
      listMyInvitations: vi.fn().mockResolvedValue([invitation()]),
      acceptInvitation
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith('invitation-1', undefined));
    await waitFor(() => expect(window.location.pathname).toBe(`/team/${SPACE_ID}`));
  });

  it('clears the row on decline and says so', async () => {
    const declineInvitation = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([]),
      listMyInvitations: vi.fn().mockResolvedValue([invitation()]),
      declineInvitation
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Invitation declined')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
  });

  it('holds the lobby even when one space is ready, so the invitation is seen', async () => {
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([makeTeam()]),
      listMyInvitations: vi.fn().mockResolvedValue([invitation({ teamId: 'other-space' })])
    });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'Your spaces' })).toBeTruthy();
  });
});

describe('leaving a space', () => {
  it('confirms with the consequence, then leaves and returns to the lobby', async () => {
    const leaveTeam = vi
      .fn()
      .mockResolvedValue({ ok: true, warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' });
    const member = makeTeam({ role: 'editor', permissions: DEFAULT_ROLE_PERMISSIONS.editor });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([member]), leaveTeam });
    const user = userEvent.setup();
    renderSpace(client, `/team/${SPACE_ID}/members`);

    await user.click(await screen.findByRole('button', { name: 'Leave this space' }));
    expect(await screen.findByRole('heading', { name: 'Leave this space?' })).toBeTruthy();
    expect(
      screen.getByText(
        'You will lose access to its files, tasks and history until someone invites you again.'
      )
    ).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'Leave this space' })[1]!);
    await waitFor(() => expect(leaveTeam).toHaveBeenCalledWith(SPACE_ID));
    // The standing Drive-ACL warning is said at the moment it becomes true.
    expect(await screen.findByText(/stay shared/)).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/team'));
  });

  it('tells an owner why they cannot leave, and offers the way out instead of a dead control', async () => {
    // Two members: the owner alone in a space is offered nothing here at all (070, T051).
    const person = (userId: string, role: 'owner' | 'editor') => ({
      membershipId: `m-${userId}`,
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role,
      baseRole: role,
      permissionOverrides: {},
      effectivePermissions: DEFAULT_ROLE_PERMISSIONS[role],
      joinedAt: '2026-01-01T00:00:00Z'
    });
    const client = makeClient({
      listTeams: vi.fn().mockResolvedValue([makeTeam()]),
      listMembers: vi.fn().mockResolvedValue([person('owner', 'owner'), person('ed', 'editor')])
    });
    renderSpace(client, `/team/${SPACE_ID}/members`);

    // 070 T051: the sentence says why; the button beside it is the way, not an instruction.
    expect(
      await screen.findByText(
        'You own this space. To leave, hand it to another member first.',
        {},
        { timeout: 10_000 }
      )
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Transfer ownership…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave this space' })).toBeNull();
  });
});

describe('discarding an unfinished space', () => {
  // 2026-11-25: the draft dialog became the one way out every space has (a833c3a1) — the card's
  // menu, the list of what goes, and a five-second hold.
  const spaces = (draft: ReturnType<typeof makeTeam>) => [
    draft,
    makeTeam({ id: 'other', name: 'Archive' }),
    makeTeam({ id: 'third', name: 'Vault' })
  ];
  const draftCard = async () =>
    (await screen.findByText('Media buyers')).closest('.team-space-card-shell') as HTMLElement;

  it('is offered to its owner, and names what it removes', async () => {
    const client = makeClient({
      // Two ready spaces, so the lobby is shown rather than one being entered.
      listTeams: vi.fn().mockResolvedValue(spaces(makeTeam({ connectionState: 'none' })))
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(within(await draftCard()).getByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete space…' }));
    expect(await screen.findByRole('dialog', { name: 'Delete “Media buyers”?' })).toBeTruthy();
    // A click is not a decision: the hold is.
    await user.click(screen.getByRole('button', { name: 'Delete space' }));
    expect(client.deleteSpace).not.toHaveBeenCalled();
  });

  it('is not offered to a member who does not own it', async () => {
    const draft = makeTeam({
      connectionState: 'none',
      role: 'editor',
      permissions: DEFAULT_ROLE_PERMISSIONS.editor
    });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue(spaces(draft)) });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(within(await draftCard()).getByRole('button', { name: 'Space actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Leave space…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete space…' })).toBeNull();
  });
});

describe('a space whose storage is disconnected', () => {
  it('explains it to a member, and points them at whoever can fix it', () => {
    render(
      <ToastProvider>
        <SpaceStatePanel space={makeTeam({ connectionState: 'detached' })} canManageDrive={false} />
      </ToastProvider>
    );

    expect(screen.getByText('This space is not connected to storage')).toBeTruthy();
    expect(screen.getByText(/Nothing was deleted/)).toBeTruthy();
    expect(screen.getByText('Ask the space owner to reconnect the folder.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open space settings' })).toBeNull();
  });

  it('gives the owner the way to fix it', () => {
    render(
      <ToastProvider>
        <SpaceStatePanel space={makeTeam({ connectionState: 'detached' })} canManageDrive />
      </ToastProvider>
    );

    expect(screen.getByRole('link', { name: 'Open space settings' })).toBeTruthy();
  });
});

describe('whole-screen states have a way out (070, T030)', () => {
  it('the storage state is the inventory’s empty state, with the door as its action', () => {
    render(
      <ToastProvider>
        <SpaceStatePanel space={makeTeam({ connectionState: 'needs_reauth' })} canManageDrive />
      </ToastProvider>
    );
    const link = screen.getByRole('link', { name: 'Open space settings' });
    expect(link.closest('.ui-empty')).toBeTruthy();
    expect(link.className).toContain('ui-button');
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
  });

  it('the closed space before its announcement offers the way home', () => {
    render(<SpaceComingSoon />);
    expect(screen.getByRole('link', { name: 'Go to the home page' }).getAttribute('href')).toBe(
      '/'
    );
  });
});
