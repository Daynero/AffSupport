// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { User } from '@supabase/supabase-js';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('../apps/web/src/lib/supabase', () => ({
  getSupabaseClient: () => null,
  requireSupabaseClient: () => ({ rpc })
}));

import { AuthContextOverride, type AuthContextValue } from '../apps/web/src/auth/AuthContext';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'outside@example.com'
} as User;

const outsideUserContext: AuthContextValue = {
  status: 'authenticated',
  user,
  session: null,
  profile: null,
  isAdmin: false,
  error: null,
  loading: false,
  signInWithGoogle: vi.fn(),
  completeOAuthCallback: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
  refreshProfile: vi.fn()
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  rpc.mockReset();
});

describe('team workspace launch gate', () => {
  it('does not let a user with an unrelated legacy team into the workspace', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const legacyTeam = makeTeam({ name: 'A user-created legacy team' });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([legacyTeam]) });

    render(
      <AuthContextOverride value={outsideUserContext}>
        <TeamProvider initialTeams={[legacyTeam]} realtime={false}>
          <TeamSpace client={client} directAddMode="disabled" />
        </TeamProvider>
      </AuthContextOverride>
    );

    expect(await screen.findByRole('heading', { name: 'ДОНТ ПУШ ЗЕ ХОРСИС' })).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('can_access_team_workspace');
    expect(screen.queryByRole('heading', { name: 'Choose a space' })).toBeNull();
  });
});
