import { useEffect, useState } from 'react';
import { useOptionalAuth } from '../auth/AuthContext';
import { getSupabaseClient } from './supabase';

/**
 * Feature 051: whether the signed-in person may use the release candidate on
 * the `next` address. Administrators always may; the owner lists anyone else in
 * the admin page. Until the candidate that brings `is_release_tester` reaches
 * the database, the function is missing and administrators are let through on
 * the role they already have.
 */
export type ReleaseTesterStatus = 'checking' | 'tester' | 'not_tester';

/** PostgREST answers PGRST202 for a function that is not in its schema cache. */
const MISSING_FUNCTION = 'PGRST202';

export async function fetchReleaseTesterStatus(
  rpc: (name: 'is_release_tester') => PromiseLike<{
    data: unknown;
    error: { code?: string } | null;
  }>,
  isAdmin: boolean
): Promise<Exclude<ReleaseTesterStatus, 'checking'>> {
  try {
    const { data, error } = await rpc('is_release_tester');
    if (error) return error.code === MISSING_FUNCTION && isAdmin ? 'tester' : 'not_tester';
    return data === true ? 'tester' : 'not_tester';
  } catch {
    return isAdmin ? 'tester' : 'not_tester';
  }
}

export function useReleaseTester(enabled: boolean): ReleaseTesterStatus {
  // Optional: the update notice also renders where nobody is signed in, and an
  // absent session simply means "not a tester".
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const isAdmin = auth?.isAdmin ?? false;
  const status = auth?.status ?? 'initializing';
  const [result, setResult] = useState<ReleaseTesterStatus>('checking');
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!enabled || status !== 'authenticated' || !userId) return;
    let live = true;
    setResult('checking');
    const supabase = getSupabaseClient();
    if (!supabase) {
      setResult(isAdmin ? 'tester' : 'not_tester');
      return;
    }
    void fetchReleaseTesterStatus(name => supabase.rpc(name), isAdmin).then(value => {
      if (live) setResult(value);
    });
    return () => {
      live = false;
    };
  }, [enabled, isAdmin, status, userId]);
  return enabled ? result : 'not_tester';
}
