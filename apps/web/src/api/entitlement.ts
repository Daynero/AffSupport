import { FunctionsHttpError } from '@supabase/supabase-js';
import type { AgentEntitlementStatus } from '@video-compressor/shared';
import { requireSupabaseClient } from '../lib/supabase';
import { entitlementPublicationRevision, submitEntitlementToken } from './client';
import {
  agentIdentityRevision,
  flushAgentRetirements,
  publishAgentIdentity
} from './entitlement-retirement';

/**
 * How long the online account check may take before it counts as unavailable.
 *
 * The exchange sits inside a connection attempt, and an attempt without an end is a
 * "Reconnect" button that does nothing (032 W5). The agent keeps its grace window
 * regardless, so giving up here costs nothing but a later retry.
 */
const EXCHANGE_TIMEOUT_MS = 6_000;

/**
 * Exchanges the signed-in Supabase session for a short-lived signed entitlement
 * token (issue-agent-token Edge Function) and hands it to the local agent. The
 * agent verifies the signature offline and keeps working through a grace
 * window, so this only needs to succeed occasionally — callers treat failures
 * as "try again online / signed in", not as fatal.
 *
 * Throws: ENTITLEMENT_BLOCKED (account not active), ENTITLEMENT_SIGNIN_REQUIRED,
 * ENTITLEMENT_UNAVAILABLE (offline / function not deployed / timed out), or agent errors.
 */
export async function ensureAgentEntitlement(
  signal?: AbortSignal
): Promise<AgentEntitlementStatus> {
  const revision = agentIdentityRevision();
  const supabase = requireSupabaseClient();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), EXCHANGE_TIMEOUT_MS);
  const onOuterAbort = () => timeout.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (signal?.aborted) timeout.abort();
  try {
    // Drain old logout before capturing the native fence. Capture it before the
    // cloud exchange, so another tab's logout/handoff can invalidate this request.
    await flushAgentRetirements(timeout.signal);
    const nativeRevision = await entitlementPublicationRevision(timeout.signal);
    let data: { token?: string } | null;
    let error: unknown;
    try {
      ({ data, error } = await supabase.functions.invoke<{ token?: string }>('issue-agent-token', {
        signal: timeout.signal
      }));
    } catch (caught) {
      data = null;
      error = caught;
    }
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
    const token = data.token;
    return await publishAgentIdentity(
      revision,
      () => submitEntitlementToken(token, nativeRevision, timeout.signal),
      timeout.signal
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'ENTITLEMENT_TOKEN_INVALID' || error.message === 'TIMEOUT')
    )
      throw new Error('ENTITLEMENT_UNAVAILABLE', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
