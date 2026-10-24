// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { User } from '@supabase/supabase-js';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  getSupabaseClient: () => null,
  requireSupabaseClient: () => ({ rpc })
}));

import { AuthContextOverride, type AuthContextValue } from '../apps/web/src/auth/AuthContext';
import { adminAuthStub } from './support/auth-stub.js';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'outside@example.com'
} as User;

const outsideUserContext: AuthContextValue = adminAuthStub({ user, isAdmin: false });

afterEach(() => {
  cleanup();
  localStorage.clear();
  rpc.mockReset();
});

const showcaseAccess = {
  mode: 'showcase',
  canCreate: false,
  pendingTariff: null,
  teams: [],
  invitations: [],
  banner: null,
  toast: null,
  showcase: {
    plans: [
      { code: 'solo', nameUk: 'Соло', nameEn: 'Solo', baseSeats: 1, sortOrder: 10 },
      { code: 'lead', nameUk: 'Лід', nameEn: 'Lead', baseSeats: 3, highlight: true, sortOrder: 20 }
    ],
    contact: { telegram: 'soty_admin', email: null },
    email: 'outside@example.com',
    request: null
  }
};

const workspaceAccess = { ...showcaseAccess, mode: 'workspace' };

function answer(access: unknown) {
  return async (name: string) =>
    name === 'get_my_space_access'
      ? { data: access, error: null }
      : name === 'can_access_team_workspace'
        ? { data: false, error: null }
        : { data: [], error: null };
}

describe('team workspace access (034 — the showcase replaces the waiting-list gate)', () => {
  it('says what it is waiting for while the access check is still pending', () => {
    rpc.mockReturnValue(new Promise(() => {}));
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });

    render(
      <AuthContextOverride value={outsideUserContext}>
        <TeamProvider realtime={false}>
          <TeamSpace client={client} directAddMode="disabled" />
        </TeamProvider>
      </AuthContextOverride>
    );

    expect(screen.getByText('Checking your access…')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the showcase page, not the workspace, to a user with an unrelated legacy team', async () => {
    rpc.mockImplementation(answer(showcaseAccess));
    const legacyTeam = makeTeam({ name: 'A user-created legacy team' });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([legacyTeam]) });

    render(
      <AuthContextOverride value={outsideUserContext}>
        <TeamProvider initialTeams={[legacyTeam]} realtime={false}>
          <TeamSpace client={client} directAddMode="disabled" />
        </TeamProvider>
      </AuthContextOverride>
    );

    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
    // The accepted showcase stays a page with a plan choice and one contact action.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Write to the administrator' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Solo/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Team/ }) as HTMLInputElement).checked).toBe(false);
    expect(rpc).toHaveBeenCalledWith('get_my_space_access', {});
    expect(screen.queryByRole('heading', { name: 'Your spaces' })).toBeNull();
  });

  it('keeps the workspace mounted when the auth session object refreshes', async () => {
    rpc.mockImplementation(answer(workspaceAccess));
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([]) });
    const accessCalls = () =>
      rpc.mock.calls.filter(call => call[0] === 'get_my_space_access').length;
    const { rerender } = render(
      <AuthContextOverride value={outsideUserContext}>
        <TeamProvider realtime={false}>
          <TeamSpace client={client} directAddMode="disabled" />
        </TeamProvider>
      </AuthContextOverride>
    );

    await waitFor(() => expect(accessCalls()).toBe(1));

    // Supabase publishes a fresh context value after returning to a foreground
    // tab even though the signed-in person and their access did not change.
    rerender(
      <AuthContextOverride value={{ ...outsideUserContext }}>
        <TeamProvider realtime={false}>
          <TeamSpace client={client} directAddMode="disabled" />
        </TeamProvider>
      </AuthContextOverride>
    );

    await waitFor(() => expect(accessCalls()).toBe(1));
    expect(screen.queryByText('Checking your access…')).toBeNull();
  });
});
