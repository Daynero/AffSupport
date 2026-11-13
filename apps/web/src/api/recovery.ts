import { request, requestBody } from './client';
import { invokeTeamFunction } from './team';
import { publicConfig } from '../lib/config';
import { ensureAgentEntitlement } from './entitlement';
import { rememberRecoveryInstallation } from './recovery-installation';
import { requireSupabaseClient } from '../lib/supabase';
import { agentIdentityRevision } from './entitlement-retirement';
import { withReadDeadline } from '../team/readCoordinator';

export const RECOVERY_CHANGED = 'soty.recovery.changed';
/** Notify this page and other same-origin tabs without sharing credentials or team data. */
function notifyRecoveryChanged() {
  window.dispatchEvent(new Event(RECOVERY_CHANGED));
  try {
    window.localStorage.setItem(RECOVERY_CHANGED, crypto.randomUUID());
  } catch {
    // Storage can be disabled; returning tabs also re-read ownership on focus.
  }
}
interface Enrollment {
  enrollmentId: string;
  installationId: string;
  ticketDigest: string;
}
export interface BackgroundRecoveryStatus {
  enabled: boolean;
  installationId: string;
  state: string;
  reason: string | null;
  /** Missing on older native apps, which cannot safely coalesce automatic setup. */
  automaticSetup?: 'eligible' | 'pending' | 'ready' | 'blocked' | 'retiring';
}
export interface RecoverySetupObservation {
  flowId: string;
  stage: 'ownership' | 'enroll' | 'delegate' | 'confirm' | 'ready';
  outcome: 'started' | 'succeeded' | 'failed' | 'canceled';
  errorCode?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function status(value: unknown): BackgroundRecoveryStatus {
  if (
    !record(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.installationId !== 'string' ||
    typeof value.state !== 'string' ||
    (value.reason !== null && typeof value.reason !== 'string') ||
    (value.automaticSetup !== undefined &&
      !['eligible', 'pending', 'ready', 'blocked', 'retiring'].includes(
        String(value.automaticSetup)
      ))
  )
    throw new Error('INVALID_RESPONSE');
  return {
    enabled: value.enabled,
    installationId: value.installationId,
    state: value.state,
    reason: value.reason,
    ...(value.automaticSetup !== undefined
      ? { automaticSetup: value.automaticSetup as BackgroundRecoveryStatus['automaticSetup'] }
      : {})
  };
}
function challenge(value: unknown): value is { challengeId: string } {
  return (
    record(value) &&
    typeof value.challengeId === 'string' &&
    /^[0-9a-f-]{36}$/iu.test(value.challengeId)
  );
}
export async function backgroundRecoveryStatus(teamId: string, signal?: AbortSignal) {
  const url = `/api/team/recovery/${encodeURIComponent(teamId)}`;
  return status(await (signal ? request<unknown>(url, 'GET', signal) : request<unknown>(url)));
}

/**
 * One native-owned setup, shared by tabs. The actor and native identity fence
 * are rechecked across every asynchronous boundary; an old page never enrolls
 * whichever account happens to be signed in by the time its reply arrives.
 */
export async function ensureBackgroundRecovery(
  teamId: string,
  scope: {
    actorId: string;
    isCurrent: () => boolean;
    signal?: AbortSignal;
    onSetupStage?: (event: RecoverySetupObservation) => void;
  }
): Promise<BackgroundRecoveryStatus> {
  const flowId = crypto.randomUUID();
  const scopeSignal = scope.signal ?? new AbortController().signal;
  const bounded = <T>(run: (signal: AbortSignal) => Promise<T>) =>
    withReadDeadline(run, scopeSignal, 10_000);
  const identityRevision = agentIdentityRevision();
  let stage: RecoverySetupObservation['stage'] = 'ownership';
  const observe = (outcome: RecoverySetupObservation['outcome'], errorCode?: string) => {
    try {
      scope.onSetupStage?.({ flowId, stage, outcome, ...(errorCode ? { errorCode } : {}) });
    } catch {
      // Diagnostics must not prevent or change ownership.
    }
  };
  const current = async () => {
    if (scope.signal?.aborted || !scope.isCurrent() || identityRevision !== agentIdentityRevision())
      throw new Error('ENTITLEMENT_SIGNIN_REQUIRED');
    const { data, error } = await bounded(() => requireSupabaseClient().auth.getSession());
    if (
      error ||
      data.session?.user.id !== scope.actorId ||
      scope.signal?.aborted ||
      !scope.isCurrent() ||
      identityRevision !== agentIdentityRevision()
    )
      throw new Error('ENTITLEMENT_SIGNIN_REQUIRED');
  };
  observe('started');
  try {
    if (!publicConfig.ok) throw new Error('INVALID_RESPONSE');
    await current();
    await bounded(signal => ensureAgentEntitlement(signal));
    await current();
    let ownership = await bounded(signal => backgroundRecoveryStatus(teamId, signal));
    await current();
    if (!ownership.automaticSetup) throw new Error('AGENT_UPDATE_REQUIRED');
    if (ownership.automaticSetup === 'ready' && ownership.enabled) {
      observe('succeeded');
      stage = 'ready';
      observe('succeeded');
      return ownership;
    }
    if (!['eligible', 'pending'].includes(ownership.automaticSetup))
      throw new Error('PERMISSION_DENIED');
    observe('succeeded');
    stage = 'enroll';
    observe('started');
    const endpoint =
      publicConfig.value.supabaseUrl.replace(/\/$/u, '') + '/functions/v1/team-recovery';
    const value: unknown = await bounded(signal =>
      requestBody(
        '/api/team/recovery/enroll',
        {
          teamId,
          endpoint,
          automatic: true,
          actorId: scope.actorId
        },
        'POST',
        signal
      )
    );
    await current();
    if (!record(value) || typeof value.installationId !== 'string')
      throw new Error('INVALID_RESPONSE');
    rememberRecoveryInstallation(value.installationId);
    if (value.enabled !== true) {
      if (
        typeof value.enrollmentId !== 'string' ||
        !/^[0-9a-f-]{36}$/iu.test(value.enrollmentId) ||
        typeof value.ticketDigest !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(value.ticketDigest)
      )
        throw new Error('INVALID_RESPONSE');
      observe('succeeded');
      stage = 'delegate';
      observe('started');
      const granted = await bounded(signal =>
        invokeTeamFunction(
          'team-recovery',
          {
            action: 'delegate',
            teamId,
            installationId: value.installationId,
            ticketDigest: value.ticketDigest,
            automatic: true,
            expectedActorId: scope.actorId,
            ...(typeof value.renewalDelegationId === 'string'
              ? { renewalDelegationId: value.renewalDelegationId }
              : {})
          },
          challenge,
          { signal }
        )
      );
      await current();
      observe('succeeded');
      stage = 'confirm';
      observe('started');
      const confirmed: unknown = await bounded(signal =>
        requestBody(
          '/api/team/recovery/confirm',
          {
            enrollmentId: value.enrollmentId,
            challengeId: granted.challengeId
          },
          'POST',
          signal
        )
      );
      await current();
      if (!record(confirmed) || confirmed.enabled !== true) throw new Error('INVALID_RESPONSE');
    }
    observe('succeeded');
    ownership = await bounded(signal => backgroundRecoveryStatus(teamId, signal));
    await current();
    if (!ownership.enabled || ownership.automaticSetup !== 'ready')
      throw new Error('INVALID_RESPONSE');
    stage = 'ready';
    observe('succeeded');
    notifyRecoveryChanged();
    return ownership;
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.message)
        ? error.message
        : 'DRIVE_UNAVAILABLE';
    observe(code === 'ENTITLEMENT_SIGNIN_REQUIRED' ? 'canceled' : 'failed', code);
    throw error;
  }
}
export async function enableBackgroundRecovery(teamId: string) {
  if (!publicConfig.ok) throw new Error('INVALID_RESPONSE');
  const health: unknown = await request('/api/health');
  if (
    !record(health) ||
    !Array.isArray(health.capabilities) ||
    !health.capabilities.includes('team-background-recovery') ||
    !health.capabilities.includes('team-background-recovery-actor-bound') ||
    typeof health.entitlementRevision !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(health.entitlementRevision)
  )
    throw new Error('AGENT_UPDATE_REQUIRED');
  await ensureAgentEntitlement();
  const endpoint =
    publicConfig.value.supabaseUrl.replace(/\/$/u, '') + '/functions/v1/team-recovery';
  const value: unknown = await requestBody('/api/team/recovery/enroll', { teamId, endpoint });
  if (
    !record(value) ||
    typeof value.enrollmentId !== 'string' ||
    typeof value.installationId !== 'string' ||
    typeof value.ticketDigest !== 'string'
  )
    throw new Error('INVALID_RESPONSE');
  rememberRecoveryInstallation(value.installationId);
  const enrollment: Enrollment = {
    enrollmentId: value.enrollmentId,
    installationId: value.installationId,
    ticketDigest: value.ticketDigest
  };
  const granted = await invokeTeamFunction(
    'team-recovery',
    {
      action: 'delegate',
      teamId,
      installationId: enrollment.installationId,
      ticketDigest: enrollment.ticketDigest
    },
    challenge
  );
  const confirmed: unknown = await requestBody('/api/team/recovery/confirm', {
    enrollmentId: enrollment.enrollmentId,
    challengeId: granted.challengeId
  });
  if (!record(confirmed) || confirmed.enabled !== true) throw new Error('INVALID_RESPONSE');
  notifyRecoveryChanged();
  return backgroundRecoveryStatus(teamId);
}
export async function disableBackgroundRecovery(teamId: string) {
  const current = await backgroundRecoveryStatus(teamId);
  try {
    await invokeTeamFunction(
      'team-recovery',
      { action: 'revoke', teamId, installationId: current.installationId },
      (value): value is { revoked: boolean } => record(value) && value.revoked === true
    );
  } finally {
    await request(`/api/team/recovery/${encodeURIComponent(teamId)}`, 'DELETE');
    notifyRecoveryChanged();
  }
  return backgroundRecoveryStatus(teamId);
}

export async function retryBackgroundRecovery(teamId: string) {
  await requestBody('/api/team/recovery/retry', { teamId });
  notifyRecoveryChanged();
  return backgroundRecoveryStatus(teamId);
}
