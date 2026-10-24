// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, User } from '@supabase/supabase-js';
import type { Profile } from '../apps/web/src/lib/database.types';
import { createTestAuthLocks } from './support/auth-mutation-locks';
import { analytics } from '../apps/web/src/analytics/service';
import { WorkspaceOperationJournal } from '../apps/web/src/team/explorer/workspaceOperationJournal';

const testState = vi.hoisted(() => ({
  session: null as Session | null,
  unsubscribe: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
  pendingSignOut: null as Promise<void> | null,
  pendingAdoption: null as Promise<void> | null,
  pendingGoogle: null as Promise<void> | null,
  beginGoogleSignIn: vi.fn(),
  retireAgentActor: vi.fn(),
  retireServerRecovery: vi.fn(),
  refreshSession: vi.fn(),
  readProfile: vi.fn(),
  writeProfile: vi.fn(),
  pendingProfile: null as Promise<Profile> | null,
  profileError: null as { code: string; status?: number } | null,
  profile: null as Profile | null
}));

vi.mock('../apps/web/src/auth/google-sign-in', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/auth/google-sign-in')>()),
  beginGoogleSignIn: (...args: unknown[]) => testState.beginGoogleSignIn(...args)
}));

vi.mock('../apps/web/src/api/recovery-server-retirement', () => ({
  retireServerRecovery: (...args: unknown[]) => testState.retireServerRecovery(...args)
}));

vi.mock('../apps/web/src/api/entitlement-retirement', () => ({
  retireAgentActor: (...args: unknown[]) => testState.retireAgentActor(...args)
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
  },
  configuredSiteUrl: () => 'http://127.0.0.1:5173',
  configuredAgentOrigin: () => 'http://127.0.0.1:43120',
  servedByAgent: (origin: string = location.origin) => origin === 'http://127.0.0.1:43120'
}));

vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  getSupabaseClient: () => ({
    auth: {
      getSession: testState.getSession,
      onAuthStateChange: testState.onAuthStateChange,
      signOut: testState.signOut,
      refreshSession: testState.refreshSession,
      signInWithOAuth: vi.fn(),
      exchangeCodeForSession: vi.fn()
    },
    from: (table: string) =>
      table === 'analytics_events'
        ? { insert: async () => ({ error: null }) }
        : {
            update: (patch: unknown) => ({
              eq: (_column: string, id: string) => ({
                select: () => ({ single: () => testState.writeProfile(patch, id) })
              })
            }),
            select: () => ({
              eq: () => ({
                maybeSingle: () => testState.readProfile(),
                abortSignal: (signal: AbortSignal) => ({
                  maybeSingle: () => testState.readProfile(signal)
                })
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
      <button
        onClick={() => {
          testState.pendingGoogle = auth.signInWithGoogle();
        }}
      >
        google
      </button>
      <button
        onClick={() => {
          testState.pendingAdoption = auth.adoptHandedOverSession(
            'synthetic-access',
            'synthetic-refresh'
          );
          void testState.pendingAdoption.catch(() => {});
        }}
      >
        adopt
      </button>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="profile">{auth.profile?.display_name ?? 'none'}</span>
      <span data-testid="onboarded">{String(auth.profile?.onboarding_completed)}</span>
      <span data-testid="error">{auth.error ?? 'none'}</span>
      <button
        onClick={() => {
          testState.pendingProfile = auth.updateProfile({ onboarding_completed: true });
          void testState.pendingProfile.catch(() => {});
        }}
      >
        complete onboarding
      </button>
      <button
        onClick={() => {
          testState.pendingSignOut = auth.signOut();
        }}
      >
        logout
      </button>
    </div>
  );
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: createTestAuthLocks() });
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  testState.session = null;
  testState.profile = null;
  testState.profileError = null;
  testState.unsubscribe.mockReset();
  testState.getSession.mockReset();
  testState.onAuthStateChange.mockReset();
  testState.signOut.mockReset();
  testState.pendingSignOut = null;
  testState.pendingAdoption = null;
  testState.pendingGoogle = null;
  testState.beginGoogleSignIn.mockReset();
  testState.beginGoogleSignIn.mockResolvedValue(null);
  testState.retireAgentActor.mockReset();
  testState.retireAgentActor.mockResolvedValue('confirmed');
  testState.retireServerRecovery.mockReset();
  testState.retireServerRecovery.mockResolvedValue('confirmed');
  testState.refreshSession.mockReset();
  testState.pendingProfile = null;
  testState.readProfile.mockReset();
  testState.readProfile.mockImplementation(async () => ({
    data: testState.profileError ? null : testState.profile,
    error: testState.profileError
  }));
  testState.writeProfile.mockReset();
  testState.writeProfile.mockImplementation(async () => ({ data: testState.profile, error: null }));
  testState.getSession.mockImplementation(async () => ({
    data: { session: testState.session },
    error: null
  }));
  testState.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: testState.unsubscribe } }
  });
  testState.signOut.mockResolvedValue({ error: null });
  testState.refreshSession.mockResolvedValue({ data: { session }, error: null });
  resetInitialSessionForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});

describe('global Supabase auth provider', () => {
  it('still finishes owned logout cleanup when the SDK emits SIGNED_OUT before resolving', async () => {
    testState.session = session;
    testState.profile = profile;
    const purge = vi.spyOn(WorkspaceOperationJournal.prototype, 'purgeActor');
    testState.signOut.mockImplementation(async () => {
      testState.onAuthStateChange.mock.calls[0]![0]('SIGNED_OUT', null);
      return { error: null };
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await act(async () => {
      await testState.pendingSignOut;
    });
    expect(purge).toHaveBeenCalledOnce();
    expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
  });

  it('drops an old profile read after another actor signs in', async () => {
    testState.session = session;
    testState.profile = profile;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('User'));
    let finish!: (value: unknown) => void;
    testState.readProfile.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    act(() => window.dispatchEvent(new Event('focus')));
    const replacement = { ...user, id: '22222222-2222-4222-8222-222222222222' };
    testState.profile = { ...profile, id: replacement.id, display_name: 'Replacement' };
    await act(async () => {
      testState.onAuthStateChange.mock.calls[0]![0]('SIGNED_IN', { ...session, user: replacement });
    });
    await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('Replacement'));
    await act(async () => {
      finish({ data: profile, error: null });
    });
    expect(screen.getByTestId('profile').textContent).toBe('Replacement');
  });

  it('publishes only an opaque invalidation after a confirmed write, even when storage is restricted', async () => {
    testState.session = session;
    testState.profile = { ...profile, onboarding_completed: false };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('false'));
    testState.profile = profile;
    await userEvent.click(screen.getByRole('button', { name: 'complete onboarding' }));
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('true'));
    const signal = localStorage.getItem('soty.auth.profile-change.v1:https://project.supabase.co');
    expect(signal).toMatch(/^[a-f0-9-]{36}$/u);
    expect(signal).not.toContain(user.id);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('restricted');
    });
    await userEvent.click(screen.getByRole('button', { name: 'complete onboarding' }));
    await expect(testState.pendingProfile).resolves.toMatchObject({ id: user.id });
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('coalesces invalidations during a read and refetches after the pending response', async () => {
    testState.session = session;
    testState.profile = { ...profile, onboarding_completed: false };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('false'));
    const before = testState.readProfile.mock.calls.length;
    let finish!: (value: unknown) => void;
    testState.readProfile.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    act(() => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
    });
    expect(testState.readProfile).toHaveBeenCalledTimes(before + 1);
    testState.profile = profile;
    await act(async () => {
      finish({ data: { ...profile, onboarding_completed: false }, error: null });
    });
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('true'));
    expect(testState.readProfile).toHaveBeenCalledTimes(before + 2);
  });

  it('does not overwrite a completed local write with an older background response', async () => {
    testState.session = session;
    testState.profile = { ...profile, onboarding_completed: false };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('false'));
    let finish!: (value: unknown) => void;
    testState.readProfile.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    act(() => window.dispatchEvent(new Event('focus')));
    testState.profile = profile;
    await userEvent.click(screen.getByRole('button', { name: 'complete onboarding' }));
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('true'));
    await act(async () => {
      finish({ data: { ...profile, onboarding_completed: false }, error: null });
    });
    expect(screen.getByTestId('onboarded').textContent).toBe('true');
  });

  it('bounds a stalled background read and retries on the next activation without blocking the page', async () => {
    testState.session = session;
    testState.profile = profile;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    testState.readProfile.mockImplementationOnce(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    vi.useFakeTimers();
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    vi.useRealTimers();
    testState.profile = { ...profile, display_name: 'Recovered' };
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('Recovered'));
  });

  it('aborts a background read and removes activation listeners on unmount', async () => {
    testState.session = session;
    testState.profile = profile;
    const mounted = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    let readSignal!: AbortSignal;
    testState.readProfile.mockImplementationOnce(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          readSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('unmounted')), { once: true });
        })
    );
    act(() => window.dispatchEvent(new Event('focus')));
    mounted.unmount();
    expect(readSignal.aborted).toBe(true);
    const count = testState.readProfile.mock.calls.length;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(testState.readProfile).toHaveBeenCalledTimes(count);
  });

  it('refreshes a sibling onboarding completion on focus without leaving the authenticated screen', async () => {
    testState.session = session;
    testState.profile = { ...profile, onboarding_completed: false };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('false'));
    testState.profile = profile;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('true'));
  });

  it('refetches an invalidated profile rather than trusting data in a sibling message', async () => {
    testState.session = session;
    testState.profile = { ...profile, onboarding_completed: false };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('false'));
    testState.profile = profile;
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'soty.auth.profile-change.v1:https://project.supabase.co',
          newValue: 'opaque-change',
          storageArea: localStorage
        })
      )
    );
    await waitFor(() => expect(screen.getByTestId('onboarded').textContent).toBe('true'));
  });

  it.each(['success', 'error'] as const)(
    'does not publish a delayed old-actor profile update %s into the replacement account',
    async outcome => {
      testState.session = session;
      testState.profile = profile;
      let finish!: (value: unknown) => void;
      testState.writeProfile.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      );
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>
      );
      await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('User'));
      await userEvent.click(screen.getByRole('button', { name: 'complete onboarding' }));
      const replacement = { ...user, id: '22222222-2222-4222-8222-222222222222' };
      testState.profile = { ...profile, id: replacement.id, display_name: 'Replacement' };
      await act(async () => {
        testState.onAuthStateChange.mock.calls[0]![0]('SIGNED_IN', {
          ...session,
          user: replacement
        });
      });
      await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('Replacement'));
      await act(async () => {
        finish({
          data: outcome === 'success' ? profile : null,
          error: outcome === 'error' ? { message: 'old-user-only' } : null
        });
        await testState.pendingProfile?.catch(() => {});
      });
      expect(screen.getByTestId('profile').textContent).toBe('Replacement');
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
      expect(screen.getByTestId('error').textContent).toBe('none');
      expect(
        localStorage.getItem('soty.auth.profile-change.v1:https://project.supabase.co')
      ).toBeNull();
    }
  );

  it('does not finish an old logout after a new Google intent starts before a replacement session exists', async () => {
    testState.session = session;
    testState.profile = profile;
    let retire!: (value: string) => void, failGoogle!: (error: Error) => void;
    testState.retireServerRecovery.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          retire = resolve;
        })
    );
    testState.beginGoogleSignIn.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failGoogle = reject;
        })
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(testState.retireServerRecovery).toHaveBeenCalledWith(user.id));
    await userEvent.click(screen.getByRole('button', { name: 'google' }));
    await waitFor(() => expect(testState.beginGoogleSignIn).toHaveBeenCalledTimes(1));
    await act(async () => {
      retire('confirmed');
      await testState.pendingSignOut;
    });
    expect(testState.signOut).not.toHaveBeenCalled();
    expect(screen.getByTestId('status').textContent).toBe('authenticating');
    await act(async () => {
      failGoogle(new Error('SYNTHETIC_GOOGLE_FAILURE'));
      await testState.pendingGoogle;
    });
    expect(screen.getByTestId('status').textContent).toBe('error');
  });

  it('shows a recoverable signout error without clearing a session when Web Locks are unavailable', async () => {
    testState.session = session;
    testState.profile = profile;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    Reflect.deleteProperty(navigator, 'locks');
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await act(async () => {
      await testState.pendingSignOut;
    });
    expect(testState.signOut).not.toHaveBeenCalled();
    expect(screen.getByTestId('status').textContent).toBe('error');
    expect(screen.getByTestId('profile').textContent).toBe('User');
  });
  it('maps an unavailable handoff mutation lane to the existing callback failure instead of leaving initialization pending', async () => {
    testState.session = session;
    testState.profile = profile;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    Reflect.deleteProperty(navigator, 'locks');
    await userEvent.click(screen.getByRole('button', { name: 'adopt' }));
    await act(async () => {
      await expect(testState.pendingAdoption).rejects.toThrow('SESSION_HANDOFF_FAILED');
    });
    expect(screen.getByTestId('status').textContent).toBe('error');
  });

  it.each(['retirement', 'analytics', 'sdk', 'same-actor'] as const)(
    'preserves a replacement session across a delayed %s logout boundary',
    async boundary => {
      testState.session = session;
      testState.profile = profile;
      let finishBoundary!: () => void;
      const delayed = new Promise<void>(resolve => {
        finishBoundary = resolve;
      });
      if (boundary === 'analytics') {
        vi.spyOn(analytics, 'flush').mockImplementationOnce(() => delayed);
      } else if (boundary === 'sdk') {
        testState.signOut.mockImplementationOnce(async () => {
          await delayed;
          return { error: null };
        });
      } else {
        testState.retireServerRecovery.mockImplementationOnce(async () => {
          await delayed;
          return 'confirmed';
        });
      }
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>
      );
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
      await userEvent.click(screen.getByRole('button', { name: 'logout' }));
      await waitFor(() => expect(testState.retireServerRecovery).toHaveBeenCalledWith(user.id));
      if (boundary === 'sdk')
        await waitFor(() => expect(testState.signOut).toHaveBeenCalledTimes(1));
      const replacement = {
        ...user,
        id: boundary === 'same-actor' ? user.id : '22222222-2222-4222-8222-222222222222',
        email: 'replacement@example.test'
      };
      testState.session = { ...session, user: replacement };
      testState.profile = {
        ...profile,
        id: replacement.id,
        email: replacement.email,
        display_name: 'Replacement'
      };
      const callback = testState.onAuthStateChange.mock.calls[0]![0];
      await act(async () => {
        callback('SIGNED_IN', testState.session);
      });
      await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('Replacement'));
      await act(async () => {
        finishBoundary();
        await testState.pendingSignOut;
      });
      expect(testState.signOut).toHaveBeenCalledTimes(boundary === 'sdk' ? 1 : 0);
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
      expect(screen.getByTestId('profile').textContent).toBe('Replacement');
    }
  );
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
    expect(testState.retireServerRecovery).toHaveBeenCalledWith(user.id);
    expect(testState.retireServerRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      testState.signOut.mock.invocationCallOrder[0]!
    );
    expect(testState.retireAgentActor).toHaveBeenCalledWith(user.id);
  });

  it('retires the previous actor on an external SIGNED_OUT event', async () => {
    testState.session = session;
    testState.profile = profile;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    const callback = testState.onAuthStateChange.mock.calls[0][0];
    callback('SIGNED_OUT', null);
    await waitFor(() => expect(testState.retireAgentActor).toHaveBeenCalledWith(user.id));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
  });

  it('allows cloud signout while native retirement remains durably pending', async () => {
    testState.session = session;
    testState.profile = profile;
    testState.retireAgentActor.mockResolvedValue('pending');
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
    expect(testState.retireAgentActor).toHaveBeenCalledWith(user.id);
    expect(testState.signOut).toHaveBeenCalledOnce();
  });

  it('refreshes a rejected API token once before declaring the profile unavailable', async () => {
    testState.session = session;
    testState.profile = profile;
    // PostgREST omits HTTP status from its client error. PGRST303 is the
    // production response for an access token whose issued-at time is ahead.
    testState.profileError = { code: 'PGRST303' };
    testState.refreshSession.mockImplementation(async () => {
      testState.profileError = null;
      return { data: { session }, error: null };
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    expect(testState.refreshSession).toHaveBeenCalledOnce();
  });
});
