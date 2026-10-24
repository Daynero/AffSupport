import {
  RECOVERY_RETIREMENT_ACK_CODES,
  type RecoveryRetirementAckReason
} from '@video-compressor/shared';
import { analytics } from '../analytics/service';
import type { AnalyticsProperties } from '../analytics/events';
import { publicConfig } from '../lib/config';
import { getSupabaseClient } from '../lib/supabase';
import { recoveryInstallation } from './recovery-installation';

/** Capture the actor JWT; neither cleanup nor its diagnostics may inherit a replacement session. */
export async function retireServerRecovery(actorId: string): Promise<'confirmed' | 'unconfirmed'> {
  let attemptId: string;
  try {
    attemptId = crypto.randomUUID();
  } catch {
    return 'unconfirmed';
  }
  const started = Date.now();
  const common = {
    flow_id: attemptId,
    attempt_id: attemptId,
    flow_step: 'recovery_retirement_ack'
  };
  const emit = (
    name: 'operation_started' | 'operation_completed' | 'operation_failed',
    properties: AnalyticsProperties = {}
  ) => {
    try {
      analytics.trackForActor(actorId, name, { ...common, ...properties });
    } catch {
      /* Diagnosis cannot prevent logout. */
    }
  };
  let settled: 'confirmed' | 'unconfirmed' | null = null;
  const finish = (
    outcome: 'confirmed' | 'unconfirmed',
    reason: RecoveryRetirementAckReason = 'unknown'
  ) => {
    if (settled !== null) return settled;
    settled = outcome;
    const duration_ms = Math.max(0, Date.now() - started);
    if (outcome === 'confirmed') emit('operation_completed', { outcome: 'success', duration_ms });
    else
      emit('operation_failed', {
        outcome: 'failure',
        duration_ms,
        error_category: reason,
        error_code: RECOVERY_RETIREMENT_ACK_CODES[0],
        error_stage: 'library',
        error_fingerprint: `team:library:${RECOVERY_RETIREMENT_ACK_CODES[0]}`
      });
    return outcome;
  };
  emit('operation_started');
  const installationId = recoveryInstallation();
  if (!installationId) return finish('unconfirmed', 'missing_scope');
  const client = getSupabaseClient();
  if (!client || !publicConfig.ok) return finish('unconfirmed', 'configuration');
  const config = publicConfig.value;
  const controller = new AbortController();
  let expire!: (value: 'unconfirmed') => void;
  const expired = new Promise<'unconfirmed'>(resolve => {
    expire = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort();
    finish('unconfirmed', 'timeout');
    expire('unconfirmed');
  }, 6_000);
  const run = async (): Promise<'confirmed' | 'unconfirmed'> => {
    let phase: 'auth' | 'request' | 'receipt' = 'auth';
    try {
      const { data, error } = await client.auth.getSession();
      if (controller.signal.aborted) return finish('unconfirmed', 'timeout');
      if (error) return finish('unconfirmed', 'auth_unavailable');
      if (!data.session?.access_token) return finish('unconfirmed', 'missing_session');
      if (data.session.user.id !== actorId) return finish('unconfirmed', 'session_mismatch');
      const jwt = data.session.access_token;
      phase = 'request';
      const response = await fetch(
        `${config.supabaseUrl.replace(/\/$/u, '')}/rest/v1/rpc/retire_team_recovery_installation_observed`,
        {
          method: 'POST',
          headers: {
            apikey: config.supabasePublishableKey,
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ p_installation: installationId, p_attempt: attemptId }),
          signal: controller.signal,
          cache: 'no-store'
        }
      );
      if (controller.signal.aborted) return finish('unconfirmed', 'timeout');
      if (!response.ok) {
        // An unavailable observed contract must not remove the established logout cleanup.
        // Never replay a request with a lost/refused outcome: only PostgREST's exact
        // missing-function response authorizes this old-contract compatibility path.
        if (response.status === 404) {
          phase = 'receipt';
          const missing: unknown = await response.json();
          if (controller.signal.aborted) return finish('unconfirmed', 'timeout');
          if (
            missing &&
            typeof missing === 'object' &&
            'code' in missing &&
            missing.code === 'PGRST202'
          ) {
            phase = 'request';
            const legacy = await fetch(
              `${config.supabaseUrl.replace(/\/$/u, '')}/rest/v1/rpc/retire_team_recovery_installation`,
              {
                method: 'POST',
                headers: {
                  apikey: config.supabasePublishableKey,
                  authorization: `Bearer ${jwt}`,
                  'content-type': 'application/json'
                },
                body: JSON.stringify({ p_installation: installationId }),
                signal: controller.signal,
                cache: 'no-store'
              }
            );
            if (controller.signal.aborted) return finish('unconfirmed', 'timeout');
            if (!legacy.ok) return finish('unconfirmed', 'server_refused');
            phase = 'receipt';
            const acknowledged: unknown = await legacy.json();
            if (controller.signal.aborted) return finish('unconfirmed', 'timeout');
            return typeof acknowledged === 'number' &&
              Number.isSafeInteger(acknowledged) &&
              acknowledged >= 0
              ? finish('unconfirmed', 'legacy_contract')
              : finish('unconfirmed', 'invalid_receipt');
          }
        }
        return finish('unconfirmed', 'server_refused');
      }
      phase = 'receipt';
      const result: unknown = await response.json();
      if (controller.signal.aborted) return finish('unconfirmed', 'timeout');
      const confirmed =
        result !== null &&
        typeof result === 'object' &&
        'attemptId' in result &&
        result.attemptId === attemptId &&
        'state' in result &&
        result.state === 'server_confirmed' &&
        'retiredCount' in result &&
        typeof result.retiredCount === 'number' &&
        Number.isSafeInteger(result.retiredCount) &&
        result.retiredCount >= 0;
      return confirmed ? finish('confirmed') : finish('unconfirmed', 'invalid_receipt');
    } catch {
      return finish(
        'unconfirmed',
        controller.signal.aborted
          ? 'timeout'
          : phase === 'auth'
            ? 'auth_unavailable'
            : phase === 'receipt'
              ? 'invalid_receipt'
              : 'network'
      );
    }
  };
  try {
    return await Promise.race([run(), expired]);
  } finally {
    clearTimeout(timer);
  }
}
