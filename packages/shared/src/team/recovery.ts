import { isRecord } from './contract.js';

/** Actor-bound desktop protocol. A version marker is compatibility, not identity proof. */
export const TEAM_RECOVERY_PROTOCOL_VERSION = 2;

/** Closed native retirement observations; local preparation is not server acknowledgement. */
export const RECOVERY_RETIREMENT_STAGES = [
  'pending_server',
  'server_confirmed',
  'pending_local_cleanup',
  'local_complete',
  'server_unknown'
] as const;
export type RecoveryRetirementStage = (typeof RECOVERY_RETIREMENT_STAGES)[number];

export const RECOVERY_REASONS = [
  'waiting_agent',
  'waiting_drive',
  'needs_agent_setup',
  'permission_revoked',
  'manually_disabled',
  'user_cancelled',
  'source_changed',
  'source_missing',
  'checkpoint_unavailable',
  'queue_registration_failed',
  'retry_exhausted',
  'superseded',
  'unknown'
] as const;
export type RecoveryReason = (typeof RECOVERY_REASONS)[number];
export const RECOVERY_STATES = [
  'registered',
  'running',
  'waiting_dependency',
  'partial',
  'completed',
  'superseded'
] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];
export const RECOVERY_BUDGET = Object.freeze({
  enrollmentMs: 120_000,
  refreshMs: 30 * 24 * 60 * 60_000,
  credentialMs: 300_000,
  rotationReplayMs: 60_000,
  rotationMs: 240_000,
  claimMs: 30_000,
  probeMs: 60_000,
  heartbeatMs: 30_000,
  leaseMs: 120_000,
  requestMs: 10_000,
  episodeMs: 600_000,
  episodesPerHour: 3,
  installationClaimsPerMinute: 12,
  installationProbesPerMinute: 6,
  retryMs: [2_000, 4_000, 8_000, 16_000, 30_000] as readonly number[]
});
export interface WorkspaceRecovery {
  id: string;
  epoch: number;
  state: RecoveryState;
  registeredAt: string;
  lastProgressAt: string;
  counts: Record<
    'pending' | 'running' | 'waiting' | 'resumed' | 'completed' | 'skipped' | 'blocked',
    number
  >;
  reasons: Array<{
    code: RecoveryReason;
    count: number;
    action: 'agent' | 'drive' | 'retry' | 'none';
  }>;
  canManageRecovery: boolean;
}
export function parseWorkspaceRecovery(value: unknown): WorkspaceRecovery | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(value.id) ||
    typeof value.epoch !== 'number' ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    !RECOVERY_STATES.some(state => state === value.state) ||
    typeof value.registeredAt !== 'string' ||
    !Number.isFinite(Date.parse(value.registeredAt)) ||
    typeof value.lastProgressAt !== 'string' ||
    !Number.isFinite(Date.parse(value.lastProgressAt)) ||
    !isRecord(value.counts) ||
    !Array.isArray(value.reasons) ||
    value.reasons.length > RECOVERY_REASONS.length ||
    typeof value.canManageRecovery !== 'boolean'
  )
    return null;
  const counts: WorkspaceRecovery['counts'] = {
    pending: 0,
    running: 0,
    waiting: 0,
    resumed: 0,
    completed: 0,
    skipped: 0,
    blocked: 0
  };
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    const count = value.counts[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
    counts[key] = count;
  }
  const reasons: WorkspaceRecovery['reasons'] = [];
  for (const reason of value.reasons) {
    if (
      !isRecord(reason) ||
      !RECOVERY_REASONS.some(code => code === reason.code) ||
      typeof reason.count !== 'number' ||
      !Number.isSafeInteger(reason.count) ||
      reason.count < 1 ||
      !['agent', 'drive', 'retry', 'none'].includes(String(reason.action))
    )
      return null;
    reasons.push({
      code: reason.code as RecoveryReason,
      count: reason.count,
      action: reason.action as WorkspaceRecovery['reasons'][number]['action']
    });
  }
  return {
    id: value.id,
    epoch: value.epoch,
    state: value.state as RecoveryState,
    registeredAt: value.registeredAt,
    lastProgressAt: value.lastProgressAt,
    counts,
    reasons,
    canManageRecovery: value.canManageRecovery
  };
}
