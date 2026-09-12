import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicConfig } from './config';
import type { Database } from './database.types';

let client: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> | null {
  if (!publicConfig.ok) return null;
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
  run: () => PromiseLike<T>
): Promise<T> {
  const first = await run();
  if (!isRejectedApiToken(first.error)) return first;
  const supabase = getSupabaseClient();
  const refreshed = await supabase?.auth.refreshSession();
  if (!refreshed || refreshed.error || !refreshed.data.session) return first;
  return run();
}
