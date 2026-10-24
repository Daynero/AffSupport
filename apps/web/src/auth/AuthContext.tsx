import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  useMemo
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { analytics } from '../analytics/service';
import { retireAgentActor } from '../api/entitlement-retirement';
import { retireServerRecovery } from '../api/recovery-server-retirement';
import { getInitialTheme, trackThemePreference } from '../lib/theme';
import { publicConfig } from '../lib/config';
import type { Database, Profile } from '../lib/database.types';
import { getSupabaseClient } from '../lib/supabase';
import { rememberReturnPath } from '../lib/redirects';
import {
  declineHandoff,
  handoffRequestUrl,
  releaseHandoffAttempts,
  sessionHandoffOrigin
} from './session-handoff';
import { beginGoogleSignIn, finishGoogleSignIn, isDirectGoogleCallback } from './google-sign-in';
import { observeSessionLogout } from './session-mutation-analytics';
import { observeProfileSync } from './profile-sync-analytics';
import { subscribeProfileInvalidation, type ProfileRefreshSource } from './profile-invalidation';
import { syncProfileLanguage } from '../i18n';
import {
  authSessionMutationCode,
  captureAuthSessionOwner,
  runAuthSessionMutation,
  signOutExpectedSession
} from './session-mutations';

async function mutateSession<T extends { error: unknown }>(
  run: () => Promise<T>
): Promise<T | { error: Error }> {
  try {
    if (!publicConfig.ok) throw new Error('SUPABASE_CONFIGURATION_MISSING');
    return await runAuthSessionMutation(publicConfig.value.supabaseUrl, run);
  } catch (error) {
    // Existing callback/beta error paths must also handle lock refusal and
    // rejected SDK promises; neither may strand the UI in initialization.
    return { error: new Error(authSessionMutationCode(error), { cause: error }) };
  }
}

export type AuthStatus =
  'initializing' | 'unauthenticated' | 'authenticating' | 'authenticated' | 'signing-out' | 'error';

export type EditableProfilePatch = Partial<
  Pick<Profile, 'display_name' | 'language' | 'marketing_consent' | 'onboarding_completed'>
>;

type AuthErrorCode =
  | 'beta_auth'
  | 'configuration'
  | 'oauth'
  | 'callback'
  | 'profile'
  | 'network'
  | 'session'
  | 'signout'
  | 'profile_update';

export type AuthSnapshot = {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  isAdmin: boolean;
  error: AuthErrorCode | null;
};

export type AuthContextValue = AuthSnapshot & {
  loading: boolean;
  signInWithGoogle: (returnPath?: string | null) => Promise<void>;
  signInWithBetaFixture: (fixture?: 'owner' | 'member') => Promise<void>;
  completeOAuthCallback: (code: string, state?: string | null) => Promise<void>;
  adoptHandedOverSession: (accessToken: string, refreshToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (patch: EditableProfilePatch) => Promise<Profile>;
  refreshProfile: () => Promise<void>;
};

const initialSnapshot: AuthSnapshot = {
  status: 'initializing',
  user: null,
  session: null,
  profile: null,
  isAdmin: false,
  error: null
};

const LOCAL_DEV_AUTH = import.meta.env.VITE_LOCAL_DEV_AUTH === 'true';
const BETA_AUTH = import.meta.env.VITE_APP_ENVIRONMENT === 'beta';
const localDevUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'dev@wishly.local',
  user_metadata: { full_name: 'Soty Developer' },
  app_metadata: {},
  aud: 'authenticated',
  created_at: new Date(0).toISOString()
} as User;
const localDevSession = {
  access_token: 'local-dev-session',
  refresh_token: 'local-dev-session',
  expires_in: Number.MAX_SAFE_INTEGER,
  token_type: 'bearer',
  user: localDevUser
} as Session;
const localDevProfile: Profile = {
  id: localDevUser.id,
  email: localDevUser.email ?? null,
  display_name: 'Soty Developer',
  avatar_url: null,
  language: 'uk',
  plan: 'pro',
  account_status: 'active',
  marketing_consent: false,
  marketing_consent_at: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  last_seen_at: null,
  onboarding_completed: true
};
const localDevSnapshot: AuthSnapshot = {
  status: 'authenticated',
  user: localDevUser,
  session: localDevSession,
  profile: localDevProfile,
  /*
   * The mocked local shell is the whole product on one machine, and the
   * dashboard is part of the product. Real local dev, which talks to a real
   * Supabase, still asks it (`is_admin`) rather than assuming.
   */
  isAdmin: import.meta.env.DEV && import.meta.env.VITE_MOCK_DATA === 'true',
  error: null
};

const AuthContext = createContext<AuthContextValue | null>(null);
let initialSessionPromise: ReturnType<
  NonNullable<ReturnType<typeof getSupabaseClient>>['auth']['getSession']
> | null = null;

const INITIAL_SESSION_TIMEOUT_MS = 10_000;

/**
 * Supabase auth can wait indefinitely on a browser lock held by a stale tab
 * or extension. The app must never leave the whole product behind an endless
 * "checking session" screen, so turn that state into a recoverable auth error.
 */
function initialSessionWithTimeout() {
  const session = initialSession();
  if (!session) return null;
  return Promise.race([
    session,
    new Promise<never>((_, reject) => {
      window.setTimeout(
        () => reject(new Error('INITIAL_SESSION_TIMEOUT')),
        INITIAL_SESSION_TIMEOUT_MS
      );
    })
  ]);
}

function initialSession() {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  initialSessionPromise ??= supabase.auth.getSession();
  return initialSessionPromise;
}

function authErrorCode(error: unknown): AuthErrorCode {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'network';
  if (error instanceof Error && /session|jwt|refresh/i.test(error.message)) return 'session';
  return 'profile';
}

/** Auth can still recognise an access token while PostgREST has rejected it
 * (for example just after a signing-key rotation or a short clock skew).
 * PostgREST's client error deliberately carries no HTTP status, so recognise
 * its stable JWT rejection codes as well. Refresh once; never loop. */
function isRejectedApiToken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 401 || code === 'PGRST301' || code === 'PGRST303';
}

async function wait(milliseconds: number) {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchProfile(userId: string, signal?: AbortSignal): Promise<Profile> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('SUPABASE_CONFIGURATION_MISSING');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const query = supabase.from('profiles').select('*').eq('id', userId);
    const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();
    if (signal?.aborted) throw new Error('PROFILE_REFRESH_TIMEOUT');
    if (data && data.id === userId) return data;
    if (data) throw new Error('PROFILE_IDENTITY_MISMATCH');
    if (error && error.code !== 'PGRST116') throw error;
    if (attempt < 2) await wait(150 * (attempt + 1));
  }
  throw new Error('PROFILE_NOT_CREATED');
}

async function fetchAdminStatus() {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('is_admin');
  if (error) return false;
  return data === true;
}

function shouldUpdateLastSeen(profile: Profile) {
  if (!profile.last_seen_at) return true;
  return Date.now() - new Date(profile.last_seen_at).getTime() >= 6 * 60 * 60 * 1000;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(
    LOCAL_DEV_AUTH ? localDevSnapshot : initialSnapshot
  );
  const snapshotRef = useRef(snapshot);
  const loadSequence = useRef(0);
  const signInGeneration = useRef(0);
  const profileRevision = useRef(0);
  const profileInvalidation = useRef<ReturnType<typeof subscribeProfileInvalidation> | null>(null);
  snapshotRef.current = snapshot;

  const establishIdentity = useCallback(async (session: Session, canRefreshToken = true) => {
    const sequence = ++loadSequence.current;
    try {
      const [profile, isAdmin] = await Promise.all([
        fetchProfile(session.user.id),
        fetchAdminStatus()
      ]);
      if (sequence !== loadSequence.current) return;
      setSnapshot({
        status: 'authenticated',
        session,
        user: session.user,
        profile,
        isAdmin,
        error: null
      });
      analytics.setUser(session.user.id);
      trackThemePreference(getInitialTheme());
      analytics.setLocale(profile.language);
      if (profile.onboarding_completed) syncProfileLanguage(profile.language);

      const signInMarker = sessionStorage.getItem('wishly.auth.analytics-user.v1');
      if (signInMarker !== session.user.id) {
        analytics.track('user_signed_in', {});
        sessionStorage.setItem('wishly.auth.analytics-user.v1', session.user.id);
      }

      if (shouldUpdateLastSeen(profile)) {
        const supabase = getSupabaseClient();
        const { data: touchedAt, error } = await supabase!.rpc('touch_last_seen');
        if (!error && touchedAt && sequence === loadSequence.current) {
          setSnapshot(current =>
            current.profile
              ? { ...current, profile: { ...current.profile, last_seen_at: touchedAt } }
              : current
          );
        }
      }
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      if (canRefreshToken && isRejectedApiToken(error)) {
        const supabase = getSupabaseClient();
        const refreshed = supabase ? await supabase.auth.refreshSession() : null;
        if (!refreshed?.error && refreshed?.data.session) {
          await establishIdentity(refreshed.data.session, false);
          return;
        }
      }
      setSnapshot({
        status: 'error',
        session,
        user: session.user,
        profile: null,
        isAdmin: false,
        error: authErrorCode(error)
      });
    }
  }, []);

  useEffect(() => {
    if (LOCAL_DEV_AUTH) return;
    const supabase = getSupabaseClient();
    if (!publicConfig.ok || !supabase) {
      setSnapshot({ ...initialSnapshot, status: 'error', error: 'configuration' });
      return;
    }

    let active = true;
    const promise = initialSessionWithTimeout();
    const initializationWatchdog = window.setTimeout(() => {
      if (active && snapshotRef.current.status === 'initializing') {
        setSnapshot({ ...initialSnapshot, status: 'error', error: 'network' });
      }
    }, INITIAL_SESSION_TIMEOUT_MS);
    void promise
      ?.then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setSnapshot({ ...initialSnapshot, status: 'error', error: authErrorCode(error) });
        } else if (data.session) {
          void establishIdentity(data.session);
        } else {
          setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
        }
      })
      .catch(error => {
        if (!active) return;
        setSnapshot({
          ...initialSnapshot,
          status: 'error',
          error: authErrorCode(error)
        });
      });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || event === 'INITIAL_SESSION') return;
      // Fence pending logout immediately, before asynchronous profile loading or a render.
      if (session && event === 'SIGNED_IN') signInGeneration.current += 1;
      // A signout invalidates profile work, but is not a replacement login:
      // the initiating logout still owns its journal/handoff cleanup.
      if (!session || event === 'SIGNED_OUT') profileRevision.current += 1;
      queueMicrotask(() => {
        if (!active) return;
        if (!session || event === 'SIGNED_OUT') {
          const previousActor = snapshotRef.current.user?.id;
          if (previousActor) {
            void retireAgentActor(previousActor);
            void retireServerRecovery(previousActor);
          }
          loadSequence.current += 1;
          analytics.setUser(null);
          sessionStorage.removeItem('wishly.auth.analytics-user.v1');
          setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
          return;
        }
        if (
          event === 'TOKEN_REFRESHED' &&
          snapshotRef.current.profile &&
          snapshotRef.current.user?.id === session.user.id
        ) {
          setSnapshot(current => ({ ...current, session, user: session.user }));
          return;
        }
        void establishIdentity(session);
      });
    });

    return () => {
      active = false;
      loadSequence.current += 1;
      window.clearTimeout(initializationWatchdog);
      subscription.unsubscribe();
    };
  }, [establishIdentity]);

  useEffect(() => {
    if (LOCAL_DEV_AUTH || !publicConfig.ok) return;
    let active = true;
    let controller: AbortController | null = null;
    let pending: ProfileRefreshSource | null = null;
    const refresh = async (source: ProfileRefreshSource) => {
      if (!active) return;
      if (controller) {
        pending = source;
        return;
      }
      const current = snapshotRef.current;
      if (current.status !== 'authenticated' || !current.user) return;
      const actor = current.user.id,
        generation = signInGeneration.current,
        sequence = loadSequence.current,
        revision = profileRevision.current;
      const owns = () =>
        active &&
        snapshotRef.current.status === 'authenticated' &&
        snapshotRef.current.user?.id === actor &&
        generation === signInGeneration.current &&
        sequence === loadSequence.current &&
        revision === profileRevision.current;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 10_000);
      const observation = observeProfileSync(actor, 'refresh', source);
      try {
        const profile = await fetchProfile(actor, request.signal);
        if (!owns()) {
          observation.superseded();
          return;
        }
        setSnapshot(value => (owns() && value.user?.id === actor ? { ...value, profile } : value));
        analytics.setLocale(profile.language);
        if (profile.onboarding_completed) syncProfileLanguage(profile.language);
        observation.completed();
      } catch {
        if (!owns()) observation.superseded();
        else
          observation.failed(
            request.signal.aborted ? 'PROFILE_REFRESH_TIMEOUT' : 'PROFILE_REFRESH_FAILED'
          );
        // Keep the last known profile usable. A later activation retries the read.
      } finally {
        window.clearTimeout(timeout);
        controller = null;
        const next = pending;
        pending = null;
        if (active && next) void refresh(next);
      }
    };
    const subscription = subscribeProfileInvalidation(publicConfig.value.supabaseUrl, source => {
      void refresh(source);
    });
    profileInvalidation.current = subscription;
    return () => {
      active = false;
      controller?.abort();
      subscription.dispose();
      if (profileInvalidation.current === subscription) profileInvalidation.current = null;
    };
  }, []);

  const signInWithGoogle = useCallback(async (returnPath?: string | null) => {
    if (LOCAL_DEV_AUTH) return;
    signInGeneration.current += 1;
    try {
      if (!publicConfig.ok) throw new Error('SUPABASE_CONFIGURATION_MISSING');
      await runAuthSessionMutation(publicConfig.value.supabaseUrl, async () => undefined);
    } catch {
      setSnapshot(current => ({ ...current, status: 'error', error: 'oauth' }));
      return;
    }
    // In the Agent's copy of the app the provider callback is registered against
    // the website, so signing in here means signing in there and being handed the
    // result back. Asking explicitly also lifts a previous sign-out's block.
    const handoff = handoffRequestUrl(returnPath ?? location.pathname);
    if (handoff) {
      releaseHandoffAttempts();
      setSnapshot(current => ({ ...current, status: 'authenticating', error: null }));
      location.assign(handoff);
      return;
    }
    const supabase = getSupabaseClient();
    if (!supabase || !publicConfig.ok) {
      setSnapshot(current => ({ ...current, status: 'error', error: 'configuration' }));
      return;
    }
    const config = publicConfig.value;
    rememberReturnPath(returnPath);
    setSnapshot(current => ({ ...current, status: 'authenticating', error: null }));
    try {
      // Returning through the site keeps supabase.co out of the Google client
      // (brand verification); without the function the provider redirect below
      // is the same sign-in it always was.
      const direct = await beginGoogleSignIn({
        supabaseUrl: config.supabaseUrl,
        publishableKey: config.supabasePublishableKey
      });
      if (direct) {
        location.assign(direct);
        return;
      }
      const { error } = await mutateSession(() =>
        supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: `${config.siteUrl}/auth/callback`,
            scopes: 'openid email profile'
          }
        })
      );
      if (error) setSnapshot({ ...initialSnapshot, status: 'error', error: 'oauth' });
    } catch {
      setSnapshot({
        ...initialSnapshot,
        status: 'error',
        error: navigator.onLine ? 'oauth' : 'network'
      });
    }
  }, []);

  // The local beta stack has no Google provider credentials. Its fixture is
  // deliberately a password account so real Supabase authentication, session
  // handling, and entitlement checks remain testable without leaving localhost.
  const signInWithBetaFixture = useCallback(async (fixture: 'owner' | 'member' = 'owner') => {
    if (!BETA_AUTH || LOCAL_DEV_AUTH) return;
    signInGeneration.current += 1;
    const supabase = getSupabaseClient();
    if (!supabase || !publicConfig.ok) {
      setSnapshot(current => ({ ...current, status: 'error', error: 'configuration' }));
      return;
    }
    setSnapshot(current => ({ ...current, status: 'authenticating', error: null }));
    const { error } = await mutateSession(() =>
      supabase.auth.signInWithPassword({
        email: fixture === 'member' ? 'member@soty.local' : 'beta@soty.local',
        password: fixture === 'member' ? 'beta-member-password' : 'beta-password'
      })
    );
    if (error) setSnapshot({ ...initialSnapshot, status: 'error', error: 'beta_auth' });
  }, []);

  /**
   * Installs a session the website handed over (see auth/session-handoff).
   *
   * `setSession` emits the same auth state change a fresh sign-in does, so the
   * profile load, analytics identity and entitlement refresh all follow on their
   * own — this is the same arrival, by a different door.
   */
  const adoptHandedOverSession = useCallback(async (accessToken: string, refreshToken: string) => {
    if (LOCAL_DEV_AUTH) return;
    signInGeneration.current += 1;
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('SUPABASE_CONFIGURATION_MISSING');
    setSnapshot(current => ({ ...current, status: 'initializing', error: null }));
    const { error } = await mutateSession(() =>
      supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      })
    );
    if (error) {
      setSnapshot({ ...initialSnapshot, status: 'error', error: 'callback' });
      throw new Error('SESSION_HANDOFF_FAILED');
    }
  }, []);

  const completeOAuthCallback = useCallback(async (code: string, state?: string | null) => {
    if (LOCAL_DEV_AUTH) return;
    signInGeneration.current += 1;
    const supabase = getSupabaseClient();
    if (!supabase || !publicConfig.ok) throw new Error('SUPABASE_CONFIGURATION_MISSING');
    setSnapshot(current => ({ ...current, status: 'initializing', error: null }));
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    const { error } = isDirectGoogleCallback(params)
      ? await finishGoogleSignIn(
          {
            supabaseUrl: publicConfig.value.supabaseUrl,
            publishableKey: publicConfig.value.supabasePublishableKey
          },
          code
        ).then(
          ({ idToken, nonce }) =>
            mutateSession(() =>
              supabase.auth.signInWithIdToken({ provider: 'google', token: idToken, nonce })
            ),
          () => ({ error: new Error('GOOGLE_SIGN_IN_EXCHANGE_FAILED') })
        )
      : await mutateSession(() => supabase.auth.exchangeCodeForSession(code));
    if (error) {
      setSnapshot({ ...initialSnapshot, status: 'error', error: 'callback' });
      throw new Error('OAUTH_CALLBACK_FAILED');
    }
  }, []);

  const signOut = useCallback(async () => {
    if (LOCAL_DEV_AUTH) return;
    const supabase = getSupabaseClient();
    if (!supabase) return;
    const actorId = snapshotRef.current.user?.id;
    const observation = observeSessionLogout(actorId);
    let expectedOwner: ReturnType<typeof captureAuthSessionOwner>;
    try {
      if (!publicConfig.ok) throw new Error('SUPABASE_CONFIGURATION_MISSING');
      expectedOwner = captureAuthSessionOwner(
        publicConfig.value.supabaseUrl,
        snapshotRef.current.session
      );
    } catch (error) {
      observation.failed(error);
      setSnapshot(current => ({ ...current, status: 'error', error: 'signout' }));
      return;
    }
    const generation = signInGeneration.current;
    const stillOwnsLogout = () =>
      generation === signInGeneration.current &&
      (!snapshotRef.current.user || snapshotRef.current.user.id === actorId);
    // Publish the durable intent before cloud signout or an outstanding token exchange.
    // Offline native cleanup remains pending; it must not prevent cloud signout.
    if (actorId) void retireAgentActor(actorId);
    setSnapshot(current => ({ ...current, status: 'signing-out', error: null }));
    // The server must see this while the actor's captured JWT is still available.
    if (actorId) await retireServerRecovery(actorId);
    if (!stillOwnsLogout()) {
      observation.superseded();
      return;
    }
    if (actorId) analytics.trackForActor(actorId, 'user_signed_out', {});
    await analytics.flush();
    if (!stillOwnsLogout()) {
      observation.superseded();
      return;
    }
    const result = await (async () => {
      try {
        if (!publicConfig.ok) throw new Error('SUPABASE_CONFIGURATION_MISSING');
        return await signOutExpectedSession(
          publicConfig.value.supabaseUrl,
          supabase.auth,
          expectedOwner,
          undefined,
          undefined,
          () => observation.acquired()
        );
      } catch (error) {
        observation.failed(error);
        return {
          error: { message: authSessionMutationCode(error) },
          superseded: false,
          session: null
        };
      }
    })();
    if (!stillOwnsLogout()) {
      observation.superseded();
      return;
    }
    if (result.superseded) {
      observation.superseded();
      if (result.session) void establishIdentity(result.session);
      else setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
      return;
    }
    if (result.error) {
      observation.failed(result.error);
      setSnapshot(current => ({ ...current, status: 'error', error: 'signout' }));
      return;
    }
    observation.completed();
    if (actorId) {
      const { WorkspaceOperationJournal } =
        await import('../team/explorer/workspaceOperationJournal');
      await new WorkspaceOperationJournal({ actorId }).purgeActor();
    }
    // Remembered sync jobs belong to the account that started them.
    const { clearFolderResyncMemory } = await import('../team/explorer/useFolderResync');
    if (!stillOwnsLogout()) {
      observation.superseded();
      return;
    }
    clearFolderResyncMemory();
    analytics.setUser(null);
    sessionStorage.removeItem('wishly.auth.analytics-user.v1');
    // Otherwise the next automatic ask would find the website's session still
    // live and sign the user straight back in.
    if (sessionHandoffOrigin()) declineHandoff();
    setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
  }, [establishIdentity]);

  const updateProfile = useCallback(async (patch: EditableProfilePatch) => {
    const current = snapshotRef.current;
    if (LOCAL_DEV_AUTH) {
      const profile = {
        ...localDevProfile,
        ...current.profile,
        ...patch,
        updated_at: new Date().toISOString()
      };
      setSnapshot(value => ({ ...value, profile, error: null }));
      return profile;
    }
    const supabase = getSupabaseClient();
    if (!supabase || !current.user || current.status !== 'authenticated')
      throw new Error('AUTH_REQUIRED');
    const actor = current.user.id,
      generation = signInGeneration.current,
      sequence = loadSequence.current,
      revision = ++profileRevision.current;
    const owns = () =>
      snapshotRef.current.status === 'authenticated' &&
      snapshotRef.current.user?.id === actor &&
      generation === signInGeneration.current &&
      sequence === loadSequence.current &&
      revision === profileRevision.current;
    const observation = observeProfileSync(actor, 'update', 'form');
    const safePatch: Database['public']['Tables']['profiles']['Update'] = {};
    if ('display_name' in patch)
      safePatch.display_name = patch.display_name?.trim().slice(0, 120) || null;
    if (patch.language === 'en' || patch.language === 'uk') safePatch.language = patch.language;
    if (typeof patch.marketing_consent === 'boolean')
      safePatch.marketing_consent = patch.marketing_consent;
    if (typeof patch.onboarding_completed === 'boolean')
      safePatch.onboarding_completed = patch.onboarding_completed;

    let data: Profile;
    try {
      const result = await supabase
        .from('profiles')
        .update(safePatch)
        .eq('id', current.user.id)
        .select('*')
        .single();
      if (!owns()) {
        observation.superseded();
        throw new Error('PROFILE_UPDATE_SUPERSEDED');
      }
      if (result.error || !result.data || result.data.id !== actor)
        throw new Error('PROFILE_UPDATE_FAILED');
      data = result.data;
    } catch (error) {
      if (!owns()) {
        observation.superseded();
        throw new Error('PROFILE_UPDATE_SUPERSEDED', { cause: error });
      }
      observation.failed('PROFILE_UPDATE_FAILED');
      setSnapshot(value =>
        owns() && value.user?.id === actor ? { ...value, error: 'profile_update' } : value
      );
      throw new Error('PROFILE_UPDATE_FAILED', { cause: error });
    }
    // Invalidate background reads that began while this write was pending.
    profileRevision.current += 1;
    const completedRevision = profileRevision.current;
    setSnapshot(value =>
      value.user?.id === actor &&
      generation === signInGeneration.current &&
      completedRevision === profileRevision.current
        ? { ...value, profile: data, error: null }
        : value
    );
    analytics.setLocale(data.language);
    profileInvalidation.current?.publish();
    observation.completed();
    return data;
  }, []);

  const refreshProfile = useCallback(async () => {
    if (LOCAL_DEV_AUTH) return;
    const current = snapshotRef.current;
    if (!current.session) {
      setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
      return;
    }
    setSnapshot(value => ({ ...value, status: 'initializing', error: null }));
    await establishIdentity(current.session);
  }, [establishIdentity]);

  const loading = ['initializing', 'authenticating', 'signing-out'].includes(snapshot.status);

  /**
   * Memoised, because an object literal here is a new value on every render of
   * this provider — and this provider sits above the whole application. Every
   * consumer re-rendered whenever anything in it moved, including consumers
   * that only ever read `isAdmin`.
   *
   * The callbacks below are already stable (`useCallback`), so the only thing
   * that legitimately changes this value is the snapshot itself.
   */
  const value = useMemo<AuthContextValue>(
    () => ({
      ...snapshot,
      loading,
      signInWithGoogle,
      signInWithBetaFixture,
      completeOAuthCallback,
      adoptHandedOverSession,
      signOut,
      updateProfile,
      refreshProfile
    }),
    [
      snapshot,
      loading,
      signInWithGoogle,
      signInWithBetaFixture,
      completeOAuthCallback,
      adoptHandedOverSession,
      signOut,
      updateProfile,
      refreshProfile
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** Auth snapshot when mounted in the app; null in isolated component previews/tests. */
export function useOptionalAuth() {
  return useContext(AuthContext);
}

export function AuthContextOverride({
  value,
  children
}: {
  value: AuthContextValue;
  children: ReactNode;
}) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function resetInitialSessionForTests() {
  initialSessionPromise = null;
}
