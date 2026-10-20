import { request, requestBody } from './client';
import { invokeTeamFunction } from './team';
import { publicConfig } from '../lib/config';

export const RECOVERY_CHANGED = 'soty.recovery.changed';
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
    (value.reason !== null && typeof value.reason !== 'string')
  )
    throw new Error('INVALID_RESPONSE');
  return {
    enabled: value.enabled,
    installationId: value.installationId,
    state: value.state,
    reason: value.reason
  };
}
function challenge(value: unknown): value is { challengeId: string } {
  return (
    record(value) &&
    typeof value.challengeId === 'string' &&
    /^[0-9a-f-]{36}$/iu.test(value.challengeId)
  );
}
export async function backgroundRecoveryStatus(teamId: string) {
  return status(await request<unknown>(`/api/team/recovery/${encodeURIComponent(teamId)}`));
}
export async function enableBackgroundRecovery(teamId: string) {
  if (!publicConfig.ok) throw new Error('INVALID_RESPONSE');
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
  window.dispatchEvent(new Event(RECOVERY_CHANGED));
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
    window.dispatchEvent(new Event(RECOVERY_CHANGED));
  }
  return backgroundRecoveryStatus(teamId);
}

export async function retryBackgroundRecovery(teamId: string) {
  await requestBody('/api/team/recovery/retry', { teamId });
  window.dispatchEvent(new Event(RECOVERY_CHANGED));
  return backgroundRecoveryStatus(teamId);
}
