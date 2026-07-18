// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, User } from '@supabase/supabase-js';

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
      productOperator: null,
      deleteAccountEnabled: false
    }
  }
}));

import { AuthContextOverride, type AuthContextValue } from '../apps/web/src/auth/AuthContext';
import {
  AuthCallbackPage,
  BlockedAccountScreen,
  LoginPage,
  ProfileOnboarding
} from '../apps/web/src/auth/AuthScreens';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import AccountPage from '../apps/web/src/pages/AccountPage';
import type { Profile } from '../apps/web/src/lib/database.types';
import { emptyQueueState } from './web-auth-helpers';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.com',
  app_metadata: { provider: 'google' },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-07-18T00:00:00.000Z'
} as User;

const session = { user, access_token: 'test', refresh_token: 'test', expires_in: 3600 } as Session;

const profile: Profile = {
  id: user.id,
  email: user.email ?? null,
  display_name: 'Wishly Owner',
  avatar_url: null,
  language: 'en',
  plan: 'free',
  account_status: 'active',
  marketing_consent: false,
  marketing_consent_at: null,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
  last_seen_at: '2026-07-18T00:00:00.000Z',
  onboarding_completed: true
};

function authValue(patch: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'unauthenticated',
    user: null,
    session: null,
    profile: null,
    isAdmin: false,
    error: null,
    loading: false,
    signInWithGoogle: vi.fn().mockResolvedValue(undefined),
    completeOAuthCallback: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn().mockResolvedValue(profile),
    refreshProfile: vi.fn().mockResolvedValue(undefined),
    ...patch
  };
}

const agentValue: AgentContextValue = {
  connection: 'connected',
  state: emptyQueueState,
  setState: vi.fn(),
  connectedOnce: true,
  agentVersion: '0.4.0-test.1',
  platform: 'macos',
  reconnect: vi.fn()
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'en');
  history.replaceState(null, '', '/login');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Wishly login and OAuth callback', () => {
  it('renders the localized login page and starts Google OAuth with a safe return route', async () => {
    const signInWithGoogle = vi.fn().mockResolvedValue(undefined);
    history.replaceState(null, '', '/login?returnTo=%2Fcompressor');
    render(
      <AuthContextOverride value={authValue({ signInWithGoogle })}>
        <LoginPage />
      </AuthContextOverride>
    );

    expect(screen.getByRole('heading', { name: 'Sign in to Wishly' })).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    expect(button.querySelector('img')?.getAttribute('src')).toBe('/google-sign-in.svg');
    await userEvent.click(button);
    expect(signInWithGoogle).toHaveBeenCalledWith('/compressor');
    expect(document.querySelector('.login-legal')?.textContent).toBe(
      'By continuing, you agree to the Terms of Use and Privacy Policy.'
    );
  });

  it('keeps the Google button width stable and prevents repeat input while authenticating', () => {
    render(
      <AuthContextOverride value={authValue({ status: 'authenticating', loading: true })}>
        <LoginPage />
      </AuthContextOverride>
    );
    const button = screen.getByRole('button', { name: 'Opening Google…' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.className).toContain('is-loading');
  });

  it('switches the complete login experience to Ukrainian without changing routes', async () => {
    render(
      <AuthContextOverride value={authValue()}>
        <LoginPage />
      </AuthContextOverride>
    );
    await userEvent.click(screen.getByRole('button', { name: 'UA' }));
    expect(screen.getByRole('heading', { name: 'Увійдіть у Wishly' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Продовжити з Google' })).toBeTruthy();
    expect(document.querySelector('.login-legal')?.textContent).toBe(
      'Продовжуючи, ви погоджуєтеся з Умовами використання та Політикою конфіденційності.'
    );
    expect(location.pathname).toBe('/login');
  });

  it('redirects an authenticated visitor away from /login', async () => {
    render(
      <AuthContextOverride value={authValue({ status: 'authenticated', user, session, profile })}>
        <LoginPage />
      </AuthContextOverride>
    );
    await waitFor(() => expect(location.pathname).toBe('/'));
  });

  it('exchanges the callback code once and returns to the requested route', async () => {
    const completeOAuthCallback = vi.fn().mockResolvedValue(undefined);
    sessionStorage.setItem('wishly.auth.return-path.v1', '/compressor');
    history.replaceState(null, '', '/auth/callback?code=unique-code-1');
    render(
      <AuthContextOverride value={authValue({ completeOAuthCallback })}>
        <AuthCallbackPage />
      </AuthContextOverride>
    );
    await waitFor(() => expect(location.pathname).toBe('/compressor'));
    expect(completeOAuthCallback).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('');
  });

  it('turns a provider cancellation into a clear login error route', async () => {
    history.replaceState(null, '', '/auth/callback?error=access_denied');
    render(
      <AuthContextOverride value={authValue()}>
        <AuthCallbackPage />
      </AuthContextOverride>
    );
    await waitFor(() => expect(location.pathname).toBe('/login'));
    expect(new URLSearchParams(location.search).get('error')).toBe('access_denied');
  });
});

describe('profile onboarding, account and blocked state', () => {
  it('keeps marketing off by default and stores an explicit onboarding choice', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ ...profile, onboarding_completed: true });
    render(
      <AuthContextOverride
        value={authValue({
          status: 'authenticated',
          user,
          session,
          profile: { ...profile, onboarding_completed: false },
          updateProfile
        })}
      >
        <ProfileOnboarding />
      </AuthContextOverride>
    );
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Continue to Wishly' }));
    expect(updateProfile).toHaveBeenCalledWith({
      language: 'en',
      marketing_consent: false,
      onboarding_completed: true
    });
  });

  it('updates only editable account fields and leaves deletion disabled until backend deploy', async () => {
    const updateProfile = vi.fn().mockResolvedValue(profile);
    render(
      <AuthContextOverride
        value={authValue({ status: 'authenticated', user, session, profile, updateProfile })}
      >
        <AgentContextOverride value={agentValue}>
          <AccountPage />
        </AgentContextOverride>
      </AuthContextOverride>
    );
    const name = screen.getByLabelText('Display name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Updated Name');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateProfile).toHaveBeenCalledWith({
      display_name: 'Updated Name',
      language: 'en',
      marketing_consent: true
    });
    expect(
      (screen.getByRole('button', { name: 'Delete account' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText('Google')).toBeTruthy();
    expect(screen.getByText('0.4.0-test.1')).toBeTruthy();
  });

  it('keeps sign-out available on a blocked account', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthContextOverride value={authValue({ signOut })}>
        <BlockedAccountScreen />
      </AuthContextOverride>
    );
    expect(screen.getByText('This account is blocked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });
});
