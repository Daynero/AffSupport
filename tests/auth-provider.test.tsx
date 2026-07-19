// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, User } from '@supabase/supabase-js';
import type { Profile } from '../apps/web/src/lib/database.types';

const testState = vi.hoisted(() => ({
  session: null as Session | null,
  unsubscribe: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
  profile: null as Profile | null
}));

vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: {
    ok: true,
    errors: [],
    value: {
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: 'sb_publishable_test_value_for_unit_tests',
      siteUrl: 'http://127.0.0.1:5173',
      adminEmailHint: null,
      legalContactEmail: null,
      productOperator: null
    }
  }
}));

vi.mock('../apps/web/src/lib/supabase', () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: testState.getSession,
      onAuthStateChange: testState.onAuthStateChange,
      signOut: testState.signOut,
      signInWithOAuth: vi.fn(),
      exchangeCodeForSession: vi.fn()
    },
    from: (table: string) =>
      table === 'analytics_events'
        ? { insert: async () => ({ error: null }) }
        : {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: testState.profile, error: null })
              })
            })
          },
    rpc: vi.fn(async (name: string) => ({
      data: name === 'is_admin' ? false : testState.profile?.last_seen_at,
      error: null
    }))
  }),
  requireSupabaseClient: vi.fn()
}));

import {
  AuthProvider,
  resetInitialSessionForTests,
  useAuth
} from '../apps/web/src/auth/AuthContext';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  app_metadata: { provider: 'google' },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-07-18T00:00:00.000Z'
} as User;
const session = {
  user,
  access_token: 'local-test-only',
  refresh_token: 'local-test-only',
  expires_in: 3600
} as Session;
const profile: Profile = {
  id: user.id,
  email: user.email ?? null,
  display_name: 'User',
  avatar_url: null,
  language: 'en',
  plan: 'free',
  account_status: 'active',
  marketing_consent: false,
  marketing_consent_at: null,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
  last_seen_at: new Date().toISOString(),
  onboarding_completed: true
};

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="profile">{auth.profile?.display_name ?? 'none'}</span>
      <button onClick={() => void auth.signOut()}>logout</button>
    </div>
  );
}

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  testState.session = null;
  testState.profile = null;
  testState.unsubscribe.mockReset();
  testState.getSession.mockReset();
  testState.onAuthStateChange.mockReset();
  testState.signOut.mockReset();
  testState.getSession.mockImplementation(async () => ({
    data: { session: testState.session },
    error: null
  }));
  testState.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: testState.unsubscribe } }
  });
  testState.signOut.mockResolvedValue({ error: null });
  resetInitialSessionForTests();
});

afterEach(() => cleanup());

describe('global Supabase auth provider', () => {
  it('gets the initial session once, installs one listener and cleans it up', async () => {
    const view = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
    expect(testState.getSession).toHaveBeenCalledTimes(1);
    expect(testState.onAuthStateChange).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(testState.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('restores a persisted session without rendering unauthenticated content first', async () => {
    testState.session = session;
    testState.profile = profile;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    expect(screen.getByTestId('status').textContent).toBe('initializing');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    expect(screen.getByTestId('profile').textContent).toBe('User');
    expect(testState.getSession).toHaveBeenCalledTimes(1);
  });

  it('signs out through Supabase and clears the authenticated state', async () => {
    testState.session = session;
    testState.profile = profile;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
    expect(testState.signOut).toHaveBeenCalledOnce();
  });
});
