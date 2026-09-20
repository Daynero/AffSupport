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
      environment: 'production',
      supabaseUrl: 'https://project.supabase.co',
      supabasePublishableKey: 'sb_publishable_test_value_for_unit_tests',
      siteUrl: 'http://127.0.0.1:5173',
      adminEmailHint: null,
      legalContactEmail: null,
      productOperator: null
    }
  },
  configuredSiteUrl: () => 'http://127.0.0.1:5173',
  configuredAgentOrigin: () => 'http://127.0.0.1:43120',
  servedByAgent: (origin: string = location.origin) => origin === 'http://127.0.0.1:43120',
  configuredEnvironment: () => 'production'
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
import { adminAuthStub } from './support/auth-stub.js';
import { agentContextStub } from './support/agent-stub.js';

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
  display_name: 'Soty Owner',
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
  return adminAuthStub({
    status: 'unauthenticated',
    isAdmin: false,
    updateProfile: vi.fn().mockResolvedValue(profile),
    ...patch
  });
}

const agentValue: AgentContextValue = agentContextStub({ capabilities: ['landing'] });

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

describe('Soty login and OAuth callback', () => {
  it('renders the localized login page and starts Google OAuth with a safe return route', async () => {
    const signInWithGoogle = vi.fn().mockResolvedValue(undefined);
    history.replaceState(null, '', '/login?returnTo=%2Fcompressor');
    render(
      <AuthContextOverride value={authValue({ signInWithGoogle })}>
        <LoginPage />
      </AuthContextOverride>
    );

    expect(screen.getByRole('heading', { name: 'Sign in to Soty' })).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    expect(button.querySelector('img')?.getAttribute('src')).toBe('/google-g-logo.svg');
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AuthContextOverride value={authValue()}>
        <LoginPage />
      </AuthContextOverride>
    );
    await userEvent.click(screen.getByRole('radio', { name: 'UA' }));
    expect(screen.getByRole('heading', { name: 'Увійдіть у Soty' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Продовжити з Google' })).toBeTruthy();
    expect(document.querySelector('.login-legal')?.textContent).toBe(
      'Продовжуючи, ви погоджуєтеся з Умовами використання та Політикою конфіденційності.'
    );
    expect(location.pathname).toBe('/login');
    expect(consoleError).not.toHaveBeenCalled();
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
    await userEvent.click(screen.getByRole('button', { name: 'Continue to Soty' }));
    expect(updateProfile).toHaveBeenCalledWith({
      language: 'en',
      marketing_consent: false,
      onboarding_completed: true
    });
  });

  it('writes each account choice as it is made, with no Save button to press', async () => {
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
    // The page used to end in a honey "Save changes" that shouted whether or not
    // anything had changed. Nothing is said about saving until something is.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();

    // The name is stored when the field is left — Enter leaves it.
    const name = screen.getByLabelText('Display name');
    await userEvent.clear(name);
    await userEvent.type(name, '  Updated   Name {Enter}');
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({ display_name: 'Updated Name' })
    );
    expect(await screen.findByText('Saved')).toBeTruthy();

    // The newsletter is a switch that writes itself.
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ marketing_consent: true }));

    // Leaving the field unchanged is not a write.
    const calls = updateProfile.mock.calls.length;
    await userEvent.click(name);
    await userEvent.tab();
    expect(updateProfile.mock.calls.length).toBe(calls);

    // Account deletion was removed from the UI entirely.
    expect(screen.queryByRole('button', { name: 'Delete account' })).toBeNull();
    // The email is said once, with where it comes from, because it cannot be edited here.
    expect(screen.getAllByText('owner@example.com')).toHaveLength(1);
    expect(
      screen.getByText('Comes from your Google account and cannot be changed here.')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('stores the language the moment it is chosen and shows the page in it', async () => {
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
    await userEvent.click(screen.getByRole('radio', { name: 'UA' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ language: 'uk' }));
    expect(localStorage.getItem('language')).toBe('uk');
    expect(await screen.findByText('Профіль')).toBeTruthy();
  });

  it('says the installed version and the update check as two separate facts', () => {
    const renderWith = (agent: AgentContextValue) =>
      render(
        <AuthContextOverride value={authValue({ status: 'authenticated', user, session, profile })}>
          <AgentContextOverride value={agent}>
            <AccountPage />
          </AgentContextOverride>
        </AuthContextOverride>
      );

    // Without a fetched release manifest the UI must not guess that a build is current.
    const checking = renderWith(agentValue);
    expect(screen.getByText('0.4.0')).toBeTruthy();
    expect(screen.getByText('Checking…')).toBeTruthy();
    expect(screen.queryByText('Up to date')).toBeNull();
    checking.unmount();

    // A check that failed is a chip of its own, not a clause glued to the version.
    const unavailable = renderWith(
      agentContextStub({
        capabilities: ['landing'],
        releaseManifest: { status: 'unavailable', manifest: null }
      })
    );
    expect(screen.getByText('0.4.0')).toBeTruthy();
    expect(screen.getByText('Could not check')).toBeTruthy();
    expect(screen.queryByText('Up to date')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Download the update' })).toBeNull();
    unavailable.unmount();

    // No local app at all: the state says so and offers the way to get one.
    const reconnect = vi.fn();
    renderWith(
      agentContextStub({
        connection: 'not_installed_or_not_running',
        agentVersion: null,
        reconnect
      })
    );
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText('Not running')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(reconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Download the app' })).toBeTruthy();
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
