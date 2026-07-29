import { FunctionsHttpError } from '@supabase/supabase-js';
import type { AgentEntitlementStatus } from '@video-compressor/shared';
import { requireSupabaseClient } from '../lib/supabase';
import { submitEntitlementToken } from './client';

/**
 * Exchanges the signed-in Supabase session for a short-lived signed entitlement
 * token (issue-agent-token Edge Function) and hands it to the local agent. The
 * agent verifies the signature offline and keeps working through a grace
 * window, so this only needs to succeed occasionally — callers treat failures
 * as "try again online / signed in", not as fatal.
 *
 * Throws: ENTITLEMENT_BLOCKED (account not active), ENTITLEMENT_SIGNIN_REQUIRED,
 * ENTITLEMENT_UNAVAILABLE (offline / function not deployed), or agent errors.
 */
export async function ensureAgentEntitlement(): Promise<AgentEntitlementStatus> {
  const supabase = requireSupabaseClient();
  const { data, error } = await supabase.functions.invoke<{ token?: string }>('issue-agent-token');
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const status = error.context?.status;
      if (status === 403) throw new Error('ENTITLEMENT_BLOCKED', { cause: error });
      if (status === 401) throw new Error('ENTITLEMENT_SIGNIN_REQUIRED', { cause: error });
    }
    throw new Error('ENTITLEMENT_UNAVAILABLE', { cause: error });
  }
  if (typeof data?.token !== 'string' || data.token.length === 0) {
    throw new Error('ENTITLEMENT_UNAVAILABLE');
  }
  return submitEntitlementToken(data.token);
}
