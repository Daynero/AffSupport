import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { analytics } from '../analytics/service';
import { publicConfig } from '../lib/config';
import type { Database, Profile } from '../lib/database.types';
import { getSupabaseClient } from '../lib/supabase';
import { rememberReturnPath } from '../lib/redirects';
import { syncProfileLanguage } from '../i18n';

export type AuthStatus =
  'initializing' | 'unauthenticated' | 'authenticating' | 'authenticated' | 'signing-out' | 'error';

export type EditableProfilePatch = Partial<
  Pick<Profile, 'display_name' | 'language' | 'marketing_consent' | 'onboarding_completed'>
>;

type AuthErrorCode =
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
  completeOAuthCallback: (code: string) => Promise<void>;
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

const AuthContext = createContext<AuthContextValue | null>(null);
let initialSessionPromise: ReturnType<
  NonNullable<ReturnType<typeof getSupabaseClient>>['auth']['getSession']
> | null = null;

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

async function wait(milliseconds: number) {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchProfile(userId: string): Promise<Profile> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('SUPABASE_CONFIGURATION_MISSING');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (data) return data;
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
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(initialSnapshot);
  const snapshotRef = useRef(snapshot);
  const loadSequence = useRef(0);
  snapshotRef.current = snapshot;

  const establishIdentity = useCallback(async (session: Session) => {
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
    const supabase = getSupabaseClient();
    if (!publicConfig.ok || !supabase) {
      setSnapshot({ ...initialSnapshot, status: 'error', error: 'configuration' });
      return;
    }

    let active = true;
    const promise = initialSession();
    void promise?.then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setSnapshot({ ...initialSnapshot, status: 'error', error: authErrorCode(error) });
      } else if (data.session) {
        void establishIdentity(data.session);
      } else {
        setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
      }
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || event === 'INITIAL_SESSION') return;
      queueMicrotask(() => {
        if (!active) return;
        if (!session || event === 'SIGNED_OUT') {
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
      subscription.unsubscribe();
    };
  }, [establishIdentity]);

  const signInWithGoogle = useCallback(async (returnPath?: string | null) => {
    const supabase = getSupabaseClient();
    if (!supabase || !publicConfig.ok) {
      setSnapshot(current => ({ ...current, status: 'error', error: 'configuration' }));
      return;
    }
    rememberReturnPath(returnPath);
    setSnapshot(current => ({ ...current, status: 'authenticating', error: null }));
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${publicConfig.value.siteUrl}/auth/callback`,
          scopes: 'openid email profile'
        }
      });
      if (error) setSnapshot({ ...initialSnapshot, status: 'error', error: 'oauth' });
    } catch {
      setSnapshot({
        ...initialSnapshot,
        status: 'error',
        error: navigator.onLine ? 'oauth' : 'network'
      });
    }
  }, []);

  const completeOAuthCallback = useCallback(async (code: string) => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('SUPABASE_CONFIGURATION_MISSING');
    setSnapshot(current => ({ ...current, status: 'initializing', error: null }));
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      setSnapshot({ ...initialSnapshot, status: 'error', error: 'callback' });
      throw new Error('OAUTH_CALLBACK_FAILED');
    }
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    setSnapshot(current => ({ ...current, status: 'signing-out', error: null }));
    analytics.track('user_signed_out', {});
    await analytics.flush();
    const error = await (async () => {
      try {
        return (await supabase.auth.signOut()).error;
      } catch {
        return { message: 'NETWORK' };
      }
    })();
    if (error) {
      setSnapshot(current => ({ ...current, status: 'error', error: 'signout' }));
      return;
    }
    analytics.setUser(null);
    sessionStorage.removeItem('wishly.auth.analytics-user.v1');
    setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
  }, []);

  const updateProfile = useCallback(async (patch: EditableProfilePatch) => {
    const current = snapshotRef.current;
    const supabase = getSupabaseClient();
    if (!supabase || !current.user) throw new Error('AUTH_REQUIRED');
    const safePatch: Database['public']['Tables']['profiles']['Update'] = {};
    if ('display_name' in patch)
      safePatch.display_name = patch.display_name?.trim().slice(0, 120) || null;
    if (patch.language === 'en' || patch.language === 'uk') safePatch.language = patch.language;
    if (typeof patch.marketing_consent === 'boolean')
      safePatch.marketing_consent = patch.marketing_consent;
    if (typeof patch.onboarding_completed === 'boolean')
      safePatch.onboarding_completed = patch.onboarding_completed;

    const { data, error } = await supabase
      .from('profiles')
      .update(safePatch)
      .eq('id', current.user.id)
      .select('*')
      .single();
    if (error) {
      setSnapshot(value => ({ ...value, error: 'profile_update' }));
      throw new Error('PROFILE_UPDATE_FAILED');
    }
    setSnapshot(value => ({ ...value, profile: data, error: null }));
    analytics.setLocale(data.language);
    return data;
  }, []);

  const refreshProfile = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current.session) {
      setSnapshot({ ...initialSnapshot, status: 'unauthenticated' });
      return;
    }
    setSnapshot(value => ({ ...value, status: 'initializing', error: null }));
    await establishIdentity(current.session);
  }, [establishIdentity]);

  const loading = ['initializing', 'authenticating', 'signing-out'].includes(snapshot.status);

  return (
    <AuthContext.Provider
      value={{
        ...snapshot,
        loading,
        signInWithGoogle,
        completeOAuthCallback,
        signOut,
        updateProfile,
        refreshProfile
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
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
