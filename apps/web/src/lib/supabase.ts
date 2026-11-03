import { captureAuthSessionOwner, sameAuthSession } from '../auth/session-mutations';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { publicConfig } from './config';
import { createMockSupabaseClient } from '../dev/mock-supabase';
import type { Database } from './database.types';

let client: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> | null {
  if (!publicConfig.ok) return null;
  /*
   * A development server can answer from memory instead of from a database
   * (021). `import.meta.env.DEV` is a compile-time constant, so this branch —
   * and the module behind it — is dropped from a production build rather than
   * merely unreachable in one.
   */
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_DATA === 'true') {
    client ??= createMockSupabaseClient() as SupabaseClient<Database>;
    return client;
  }
  if (!client) {
    client = createClient<Database>(
      publicConfig.value.supabaseUrl,
      publicConfig.value.supabasePublishableKey,
      {
        auth: {
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      }
    );
  }
  return client;
}

export function requireSupabaseClient(): SupabaseClient<Database> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('SUPABASE_CONFIGURATION_MISSING');
  return supabase;
}

/**
 * Runs one Supabase call and gives a rejected token exactly one second chance.
 *
 * PostgREST refuses an expired or clock-skewed JWT with `PGRST301`/`PGRST303`
 * and, deliberately, **no HTTP status**. Code that only recognised `401` never
 * saw it, so the call failed permanently and the screen said "try again in a
 * minute" — advice that could not work, because nothing was refreshing the
 * token. `AuthContext` learned this for the profile fetch; anything that loads
 * before it, or a tab left open until its token expires, still needs its own
 * answer.
 *
 * Refresh once, retry once. Never a loop: a session that is genuinely gone must
 * surface as a failure rather than spin.
 */
export function isRejectedApiToken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 401 || code === 'PGRST301' || code === 'PGRST303';
}

export async function withFreshSession<T extends { error: unknown }>(
  run: () => PromiseLike<T>,
  options: { signal?: AbortSignal; retryWithToken?: (token: string) => PromiseLike<T> } = {}
): Promise<T> {
  // A rejected old request must never be replayed using a replacement login.
  // The shared intent changes before interactive session commits, including sibling tabs.
  const intent = () => {
    try {
      return publicConfig.ok
        ? captureAuthSessionOwner(publicConfig.value.supabaseUrl, null).intentRevision
        : null;
    } catch {
      return null;
    }
  };
  const owner = intent();
  const stillOwned = () =>
    owner !== null &&
    !owner.startsWith('pending:') &&
    intent() === owner &&
    !options.signal?.aborted;
  const supabase = getSupabaseClient();
  let initialSession: Session | null = null;
  try {
    const snapshot = await supabase?.auth.getSession();
    if (!snapshot?.error) initialSession = snapshot?.data.session ?? null;
  } catch {
    // A first request may still succeed; unknown ownership never authorizes replay.
  }
  if (options.signal?.aborted) throw new DOMException('Read cancelled', 'AbortError');
  const request = run();
  const first = await request;
  if (!isRejectedApiToken(first.error)) return first;
  // An aborted call is the caller's decision, never a reason to refresh.
  if (!stillOwned() || !initialSession) return first;
  // Only the original lazy PostgREST builder can bind replay credentials.
  // An opaque Promise may already own a transport; never invoke its factory again.
  const bindable = request as PromiseLike<T> & {
    setHeader?: (name: string, value: string) => PromiseLike<T>;
  };
  if (typeof bindable.setHeader !== 'function' && !options.retryWithToken) return first;
  const refreshed = await supabase?.auth.refreshSession();
  if (
    !refreshed ||
    refreshed.error ||
    !refreshed.data.session ||
    !stillOwned() ||
    !sameAuthSession(initialSession, refreshed.data.session)
  )
    return first;
  const token = refreshed.data.session.access_token;
  const retried = options.retryWithToken
    ? await options.retryWithToken(token)
    : typeof bindable.setHeader === 'function'
      ? await bindable.setHeader('Authorization', `Bearer ${token}`)
      : first;
  return stillOwned() ? retried : first;
}
