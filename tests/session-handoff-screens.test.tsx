// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { AuthContextValue as AuthValue } from '../apps/web/src/auth/AuthContext';

const AGENT_ORIGIN = 'http://127.0.0.1:43120';
const site = { current: 'https://soty.pp.ua' };
const agent = { current: AGENT_ORIGIN };

vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: { ok: true, errors: [], value: { environment: 'production' } },
  configuredEnvironment: () => 'production',
  configuredSiteUrl: () => site.current,
  configuredAgentOrigin: () => agent.current,
  servedByAgent: (origin: string = location.origin) => origin === agent.current
}));

const { AuthContextOverride } = await import('../apps/web/src/auth/AuthContext');
const { AuthHandoffPage } = await import('../apps/web/src/auth/AuthScreens');

function authValue(patch: Partial<AuthValue> = {}): AuthValue {
  return {
    status: 'unauthenticated',
    user: null,
    session: null,
    profile: null,
    isAdmin: false,
    error: null,
    loading: false,
    signInWithGoogle: vi.fn().mockResolvedValue(undefined),
    signInWithBetaFixture: vi.fn().mockResolvedValue(undefined),
    completeOAuthCallback: vi.fn().mockResolvedValue(undefined),
    adoptHandedOverSession: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn(),
    refreshProfile: vi.fn().mockResolvedValue(undefined),
    ...patch
  } as AuthValue;
}

/**
 * Keeps the live Location — `history.replaceState` still drives it — and only
 * intercepts the cross-origin jump, which jsdom cannot perform.
 */
function interceptCrossOriginNavigation() {
  const real = window.location;
  const assign = vi.fn();
  const view: Record<string, unknown> = { assign };
  for (const key of [
    'href',
    'origin',
    'protocol',
    'host',
    'hostname',
    'port',
    'pathname',
    'search',
    'hash'
  ])
    Object.defineProperty(view, key, { get: () => real[key as 'href'], enumerable: true });
  Object.defineProperty(window, 'location', { configurable: true, value: view });
  return {
    assign,
    restore: () => Object.defineProperty(window, 'location', { configurable: true, value: real })
  };
}

let navigation: ReturnType<typeof interceptCrossOriginNavigation>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  site.current = 'https://soty.pp.ua';
  agent.current = AGENT_ORIGIN;
  navigation = interceptCrossOriginNavigation();
});

afterEach(() => {
  navigation.restore();
  cleanup();
});

describe('/auth/handoff on the Agent copy of the app', () => {
  beforeEach(() => {
    // Speak as the Agent copy: jsdom cannot change origin, so the config says so.
    agent.current = location.origin;
  });

  it('installs the session the website sent and lands where the user was going', async () => {
    history.replaceState(
      null,
      '',
      '/auth/handoff#access_token=access&refresh_token=refresh&next=/compressor'
    );
    const adoptHandedOverSession = vi.fn().mockResolvedValue(undefined);

    render(
      <AuthContextOverride value={authValue({ adoptHandedOverSession })}>
        <AuthHandoffPage />
      </AuthContextOverride>
    );

    await waitFor(() => expect(adoptHandedOverSession).toHaveBeenCalledWith('access', 'refresh'));
    await waitFor(() => expect(location.pathname).toBe('/compressor'));
    expect(location.hash).toBe('');
  });

  it('falls back to sign-in when the website had no session to give', async () => {
    history.replaceState(null, '', '/auth/handoff');

    render(
      <AuthContextOverride value={authValue()}>
        <AuthHandoffPage />
      </AuthContextOverride>
    );

    await waitFor(() => expect(location.pathname).toBe('/login'));
  });

  it('shows the sign-in error rather than a blank wait when the session will not install', async () => {
    history.replaceState(null, '', '/auth/handoff#access_token=access&refresh_token=stale');
    const adoptHandedOverSession = vi.fn().mockRejectedValue(new Error('SESSION_HANDOFF_FAILED'));

    render(
      <AuthContextOverride value={authValue({ adoptHandedOverSession })}>
        <AuthHandoffPage />
      </AuthContextOverride>
    );

    await waitFor(() => expect(location.search).toBe('?error=callback'));
    expect(location.pathname).toBe('/login');
  });
});

describe('/auth/handoff on the website', () => {
  it('hands its live session to the Agent origin that asked', async () => {
    history.replaceState(
      null,
      '',
      `/auth/handoff?returnTo=${encodeURIComponent(AGENT_ORIGIN)}&next=%2Faccount`
    );

    render(
      <AuthContextOverride
        value={authValue({
          status: 'authenticated',
          session: { access_token: 'access', refresh_token: 'refresh' } as AuthValue['session']
        })}
      >
        <AuthHandoffPage />
      </AuthContextOverride>
    );

    await waitFor(() => expect(navigation.assign).toHaveBeenCalledTimes(1));
    const url = new URL(navigation.assign.mock.calls[0][0] as string);
    expect(url.origin).toBe(AGENT_ORIGIN);
    expect(url.pathname).toBe('/auth/handoff');
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get('access_token')).toBe('access');
    expect(fragment.get('refresh_token')).toBe('refresh');
    expect(fragment.get('next')).toBe('/account');
  });

  it('signs in first when it has nothing to hand over, then comes back here', async () => {
    history.replaceState(null, '', `/auth/handoff?returnTo=${encodeURIComponent(AGENT_ORIGIN)}`);

    render(
      <AuthContextOverride value={authValue()}>
        <AuthHandoffPage />
      </AuthContextOverride>
    );

    await waitFor(() => expect(location.pathname).toBe('/login'));
    expect(navigation.assign).not.toHaveBeenCalled();
    const returnTo = new URLSearchParams(location.search).get('returnTo');
    expect(returnTo).toBe(`/auth/handoff?returnTo=${encodeURIComponent(AGENT_ORIGIN)}`);
  });

  it('waits rather than deciding while the session is still being checked', async () => {
    history.replaceState(null, '', `/auth/handoff?returnTo=${encodeURIComponent(AGENT_ORIGIN)}`);

    render(
      <AuthContextOverride value={authValue({ status: 'initializing' })}>
        <AuthHandoffPage />
      </AuthContextOverride>
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/auth/handoff');
  });

  it('refuses to deliver a session anywhere but this installation Agent', async () => {
    history.replaceState(null, '', '/auth/handoff?returnTo=https%3A%2F%2Fevil.example');

    render(
      <AuthContextOverride
        value={authValue({
          status: 'authenticated',
          session: { access_token: 'access', refresh_token: 'refresh' } as AuthValue['session']
        })}
      >
        <AuthHandoffPage />
      </AuthContextOverride>
    );

    await waitFor(() => expect(location.pathname).toBe('/'));
    expect(navigation.assign).not.toHaveBeenCalled();
  });
});
