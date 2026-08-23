// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { AuthContextOverride, type AuthContextValue } from '../apps/web/src/auth/AuthContext';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { ToastProvider } from '../apps/web/src/components/toast';
import { SpaceStatePanel } from '../apps/web/src/team/workspace/SpaceStatePanel';
import { makeClient, makeTeam } from './team-space-fixtures';

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
  localStorage.clear();
  vi.restoreAllMocks();
});

const adminAuth = {
  status: 'authenticated',
  user: null,
  session: null,
  profile: null,
  isAdmin: true,
  error: null,
  loading: false,
  signInWithGoogle: vi.fn(),
  completeOAuthCallback: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
  refreshProfile: vi.fn()
} as AuthContextValue;

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

    expect(await screen.findByRole('heading', { name: 'Choose a space' })).toBeTruthy();
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
    renderSpace(client, `/team/${SPACE_ID}/settings`);

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

  it('tells an owner why they cannot leave, instead of offering a dead control', async () => {
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([makeTeam()]) });
    renderSpace(client, `/team/${SPACE_ID}/settings`);

    expect(
      await screen.findByText(
        'A space cannot be left without an owner. Transfer ownership to another member first, then you can leave.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave this space' })).toBeNull();
  });
});

describe('discarding an unfinished space', () => {
  it('is offered to its owner, and names what it removes', async () => {
    const draft = makeTeam({ connectionState: 'none' });
    const deleteDraftTeam = vi.fn().mockResolvedValue(true);
    const client = makeClient({
      // Two ready spaces, so the lobby is shown rather than one being entered.
      listTeams: vi
        .fn()
        .mockResolvedValue([
          draft,
          makeTeam({ id: 'other', name: 'Archive' }),
          makeTeam({ id: 'third', name: 'Vault' })
        ]),
      deleteDraftTeam
    });
    const user = userEvent.setup();
    renderSpace(client);

    await user.click(await screen.findByRole('button', { name: 'Discard this draft' }));
    expect(await screen.findByRole('heading', { name: 'Discard “Media buyers”?' })).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'Discard this draft' })[1]!);
    await waitFor(() => expect(deleteDraftTeam).toHaveBeenCalledWith(SPACE_ID));
    expect(await screen.findByText('Draft space discarded')).toBeTruthy();
  });

  it('is not offered to a member who does not own it', async () => {
    const draft = makeTeam({
      connectionState: 'none',
      role: 'editor',
      permissions: DEFAULT_ROLE_PERMISSIONS.editor
    });
    const client = makeClient({
      listTeams: vi
        .fn()
        .mockResolvedValue([
          draft,
          makeTeam({ id: 'other', name: 'Archive' }),
          makeTeam({ id: 'third', name: 'Vault' })
        ])
    });
    renderSpace(client);

    await screen.findByRole('heading', { name: 'Choose a space' });
    expect(screen.queryByRole('button', { name: 'Discard this draft' })).toBeNull();
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
