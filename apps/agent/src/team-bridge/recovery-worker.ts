import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  isRecord,
  parseTeamTransferGrant,
  parseMaterialRestitchPrep,
  usablePrep,
  RECOVERY_BUDGET,
  TEAM_RECOVERY_PROTOCOL_VERSION,
  type RecoveryRetirementStage,
  type AppEnvironment
} from '@video-compressor/shared';
import {
  platformRecoverySecrets,
  type RecoverySecretStore,
  type RecoverySecrets
} from '../platform/recovery-credentials.js';
import {
  RecoveryJournal,
  type RecoveryCheckpoint,
  type RecoveryRegistration
} from './recovery-journal.js';
import type { TeamProcessBridge, TeamProcessRequest } from './process.js';

const UUID = /^[0-9a-f-]{36}$/iu;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
class RecoveryRequestError extends Error {
  constructor(
    code: string,
    readonly retryAfterMs: number
  ) {
    super(code);
  }
}
export function recoveryEndpoint(value: unknown, environment: AppEnvironment): string {
  if (typeof value !== 'string') throw new Error('INVALID_INPUT');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/functions/v1/team-recovery')
  )
    throw new Error('INVALID_INPUT');
  if (
    environment === 'beta'
      ? !(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:')
      : url.protocol !== 'https:'
  )
    throw new Error('INVALID_INPUT');
  return url.toString();
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_RESPONSE');
  return value;
}
function activeClaim(
  value: unknown,
  registration: RecoveryRegistration
): { request: TeamProcessRequest; jobId: string; leaseToken: string; credential: string } | null {
  if (
    !isRecord(value) ||
    !isRecord(value.job) ||
    typeof value.operationCredential !== 'string' ||
    !TOKEN.test(value.operationCredential)
  )
    return null;
  const job = value.job;
  const sourceGrant = parseTeamTransferGrant(job.sourceGrant);
  const finalizeGrant = parseTeamTransferGrant(job.finalizeGrant);
  if (
    typeof job.operationId !== 'string' ||
    !UUID.test(job.operationId) ||
    typeof job.jobId !== 'string' ||
    !UUID.test(job.jobId) ||
    typeof job.leaseToken !== 'string' ||
    !TOKEN.test(job.leaseToken) ||
    job.toolId !== 'restitch' ||
    !isRecord(job.options) ||
    sourceGrant?.purpose !== 'process_input' ||
    finalizeGrant?.purpose !== 'finalize'
  )
    return null;
  const prepared = parseMaterialRestitchPrep(job.options.prepared);
  const root = registration.endpoint.replace(/team-recovery$/u, '');
  return {
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    credential: value.operationCredential,
    request: {
      operationId: job.operationId,
      toolId: 'restitch',
      options: {
        ...job.options,
        prepared: usablePrep(
          prepared.ok ? prepared.value : null,
          typeof job.videoDriveVersion === 'string' ? job.videoDriveVersion : null
        )
      },
      sourceGrant,
      finalizeGrant,
      transferUrl: root + 'drive-transfer/range',
      cloudBaseUrl: root + 'drive-ops'
    }
  };
}
export interface RecoveryWorkerOptions {
  environment: AppEnvironment;
  currentActorId: () => string | null;
  allowed?: () => boolean;
  journal: RecoveryJournal;
  process: Pick<TeamProcessBridge, 'process' | 'cancel' | 'busy'>;
  secrets?: RecoverySecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  record?: (code: string, props: Record<string, string | number | boolean>) => void;
}
/** One persisted claim per delegation; all media runs through the existing bridge/governor. */
export class TeamRecoveryWorker {
  #registrations: RecoveryRegistration[] = [];
  #checkpoints: RecoveryCheckpoint[] = [];
  #enrollments = new Map<
    string,
    {
      ticket: string;
      teamId: string;
      endpoint: string;
      installationId: string;
      until: number;
      actorId: string;
      cancelled?: boolean;
    }
  >();
  #redeeming = new Set<{ teamId: string; cancelled?: boolean }>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #running = new Map<string, Promise<void>>();
  #paused = new Set<string>();
  #episodes = new Map<string, number[]>();
  #retryNotBefore = new Map<string, number>();
  #serverRetryNotBefore = new Map<string, number>();
  #retirements = new Map<string, Promise<void>>();
  #retirementStages = new Map<string, string>();
  #settingUp = 0;
  #identityWaits = new Set<string>();
  #closed = false;
  #loaded = false;
  #setupRequired = false;
  #installation: string = randomUUID();
  #failures = new Map<string, { count: number; since: number }>();
  readonly #secrets: RecoverySecretStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  constructor(readonly options: RecoveryWorkerOptions) {
    this.#secrets = options.secrets ?? platformRecoverySecrets;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }
  async load() {
    let saved: Awaited<ReturnType<RecoveryJournal['load']>>;
    try {
      saved = await this.options.journal.load();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'INVALID_RESPONSE') throw error;
      await this.options.journal.quarantine();
      this.#setupRequired = true;
      this.#loaded = true;
      throw error;
    }
    this.#registrations = saved.registrations.map(r => ({
      ...r,
      endpoint: recoveryEndpoint(r.endpoint, this.options.environment)
    }));
    this.#checkpoints = saved.checkpoints;
    for (const checkpoint of this.#checkpoints) {
      if (checkpoint.retryEpisodes)
        this.#episodes.set(checkpoint.delegationId, checkpoint.retryEpisodes);
      if (checkpoint.retryAttempt !== undefined && checkpoint.retrySince !== undefined)
        this.#failures.set(checkpoint.delegationId, {
          count: checkpoint.retryAttempt,
          since: checkpoint.retrySince
        });
      if (checkpoint.retryNotBefore)
        this.#retryNotBefore.set(checkpoint.delegationId, checkpoint.retryNotBefore);
      if (checkpoint.serverRetryNotBefore !== undefined)
        this.#serverRetryNotBefore.set(checkpoint.delegationId, checkpoint.serverRetryNotBefore);
    }
    this.#installation = this.#registrations[0]?.installationId ?? this.#installation;
    this.#loaded = true;
    for (const registration of this.#registrations) this.#schedule(registration, 0);
  }
  get installationId(): string {
    return this.#installation;
  }
  begin(teamId: string, endpoint: string) {
    const actorId = this.options.currentActorId();
    const now = this.#now();
    for (const [key, item] of this.#enrollments)
      if (item.until <= now) this.#enrollments.delete(key);
    if (
      !this.#loaded ||
      !UUID.test(teamId) ||
      !actorId ||
      !UUID.test(actorId) ||
      this.#registrations.length + this.#enrollments.size + this.#settingUp >= 6
    )
      throw new Error('WRONG_STATE');
    const id = randomUUID();
    const ticket = randomBytes(32).toString('base64url');
    if (this.#enrollments.size >= 6) throw new Error('RATE_LIMITED');
    this.#enrollments.set(id, {
      ticket,
      actorId,
      teamId,
      endpoint: recoveryEndpoint(endpoint, this.options.environment),
      installationId: this.#installation,
      until: now + RECOVERY_BUDGET.enrollmentMs
    });
    return {
      enrollmentId: id,
      installationId: this.#installation,
      ticketDigest: createHash('sha256').update(ticket).digest('hex')
    };
  }
  async enroll(enrollmentId: string, challengeId: string) {
    const enrollment = this.#enrollments.get(enrollmentId);
    this.#enrollments.delete(enrollmentId);
    if (!enrollment || enrollment.until <= this.#now() || !UUID.test(challengeId))
      throw new Error('EXPIRED');
    this.#settingUp += 1;
    this.#redeeming.add(enrollment);
    try {
      const response = await this.#call(enrollment.endpoint, 'redeem', enrollment.ticket, {
        challengeId
      });
      const delegationId = text(response.delegationId);
      const refresh = text(response.refresh);
      const expiresAt = text(response.expiresAt);
      if (
        !UUID.test(delegationId) ||
        !TOKEN.test(refresh) ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        response.teamId !== enrollment.teamId ||
        response.installationId !== enrollment.installationId
      )
        throw new Error('INVALID_RESPONSE');
      const account =
        'soty-recovery-' +
        createHash('sha256')
          .update(
            this.options.environment +
              '|' +
              enrollment.endpoint +
              '|' +
              enrollment.teamId +
              '|' +
              delegationId
          )
          .digest('hex');
      // A legacy/malformed actor field must deny setup without losing a valid
      // refresh handle needed to retire the delegation the server just issued.
      const actorId = typeof response.actorId === 'string' ? response.actorId : '';
      const matches = () =>
        !enrollment.cancelled &&
        UUID.test(actorId) &&
        actorId === enrollment.actorId &&
        actorId === this.options.currentActorId();
      const registration: RecoveryRegistration = {
        ...(UUID.test(actorId) ? { actorId } : {}),
        ...(!matches() ? { revoking: true } : {}),
        teamId: enrollment.teamId,
        installationId: enrollment.installationId,
        endpoint: enrollment.endpoint,
        delegationId,
        account
      };
      if (matches() && this.#registrations.some(r => r.teamId === enrollment.teamId))
        await this.#removeRegistrations(enrollment.teamId);
      // Secret durability precedes successful enrollment and the metadata index.
      await this.#secrets.write(account, {
        refresh,
        expiresAt,
        rotationId: randomUUID(),
        claim: null,
        claimExpiresAt: null,
        active: null
      });
      if (!matches()) registration.revoking = true;
      this.#registrations.push(registration);
      this.#setupRequired = false;
      await this.#save();
      if (!matches() || !this.#isCurrent(registration)) {
        await this.#retire(registration);
        const failure = !Object.hasOwn(response, 'actorId')
          ? 'AGENT_UPDATE_REQUIRED'
          : !UUID.test(actorId)
            ? 'INVALID_RESPONSE'
            : 'PERMISSION_DENIED';
        throw new Error(failure);
      }
      this.#schedule(registration, 0);
      return { enabled: true, installationId: registration.installationId };
    } finally {
      this.#settingUp -= 1;
      this.#redeeming.delete(enrollment);
    }
  }
  status(teamId: string) {
    const registration =
      this.#registrations.find(r => r.teamId === teamId && this.#isCurrent(r)) ??
      this.#registrations.find(r => r.teamId === teamId);
    const checkpoint = this.#checkpoints.find(c => c.delegationId === registration?.delegationId);
    return {
      enabled:
        !!registration &&
        !registration.revoking &&
        !!registration.actorId &&
        (this.options.currentActorId() === null || this.#isCurrent(registration)),
      installationId: registration?.installationId ?? this.#installation,
      state:
        registration && !this.#isCurrent(registration)
          ? 'blocked'
          : (checkpoint?.stage ?? (this.#setupRequired ? 'blocked' : 'idle')),
      reason:
        registration && !this.#isCurrent(registration)
          ? registration.actorId && this.options.currentActorId() !== null
            ? 'permission_revoked'
            : 'needs_agent_setup'
          : (checkpoint?.reason ?? (this.#setupRequired ? 'needs_agent_setup' : null))
    };
  }
  async retry(teamId: string) {
    const registration = this.#registrations.find(r => r.teamId === teamId && this.#isCurrent(r));
    const checkpoint = this.#checkpoints.find(c => c.delegationId === registration?.delegationId);
    if (
      !registration ||
      checkpoint?.reason !== 'retry_exhausted' ||
      this.#running.has(registration.delegationId)
    )
      throw new Error('WRONG_STATE');
    const secrets = await this.#secrets.read(registration.account);
    const active = secrets?.active ? activeClaim(secrets.active, registration) : null;
    if (secrets?.active && !active) throw new Error('INVALID_RESPONSE');
    // Retry transport/registration only. Any potentially executed grant is settled,
    // never handed to the process bridge a second time.
    this.#episodes.delete(registration.delegationId);
    // Explicit retry may waive our cooldown, never a server Retry-After. A legacy
    // journal cannot distinguish the two, so conservatively retain its deadline.
    const serverDeadline =
      this.#serverRetryNotBefore.get(registration.delegationId) ??
      this.#retryNotBefore.get(registration.delegationId) ??
      0;
    this.#retryNotBefore.delete(registration.delegationId);
    if (serverDeadline > this.#now())
      this.#retryNotBefore.set(registration.delegationId, serverDeadline);
    this.#failures.delete(registration.delegationId);
    await this.#checkpoint(
      registration,
      checkpoint.requestId,
      active?.request.operationId ?? null,
      active ? 'running' : 'claiming'
    );
    this.#schedule(registration, 0);
    return { retrying: true };
  }
  async remove(teamId: string) {
    this.#cancelSetups(teamId);
    return this.#removeRegistrations(teamId);
  }
  #cancelSetups(teamId?: string) {
    for (const [id, setup] of this.#enrollments) {
      if (teamId === undefined || setup.teamId === teamId) {
        setup.cancelled = true;
        this.#enrollments.delete(id);
      }
    }
    for (const setup of this.#redeeming)
      if (teamId === undefined || setup.teamId === teamId) setup.cancelled = true;
  }
  async #removeRegistrations(teamId: string) {
    const registrations = this.#registrations.filter(r => r.teamId === teamId);
    for (const r of registrations) await this.#markRetiring(r);
    for (const r of registrations) {
      await this.#running.get(r.delegationId);
      await this.#retire(r);
    }
    return { disabled: true };
  }
  /** Stop old ownership durably before the next native account becomes current. */
  async prepareActorChange(actorId: string | null) {
    this.#cancelSetups();
    for (const r of this.#registrations.filter(r => r.actorId !== actorId || !r.actorId)) {
      await this.#markRetiring(r);
      const running = this.#running.get(r.delegationId);
      if (running) void running.finally(() => this.#schedule(r, 0)).catch(() => undefined);
      else this.#schedule(r, 0);
    }
  }
  #isCurrent(r: RecoveryRegistration) {
    return (
      !r.revoking &&
      typeof r.actorId === 'string' &&
      UUID.test(r.actorId) &&
      r.actorId === this.options.currentActorId?.()
    );
  }
  #recordRetirement(r: RecoveryRegistration, stage: RecoveryRetirementStage) {
    if (this.#retirementStages.get(r.delegationId) === stage) return;
    this.#retirementStages.set(r.delegationId, stage);
    this.options.record?.('recovery_retirement', { stage, delegation_id: r.delegationId });
  }
  async #markRetiring(r: RecoveryRegistration) {
    const newlyRetiring = !r.revoking;
    r.revoking = true;
    if (!r.actorId) this.#setupRequired = true;
    const timer = this.#timers.get(r.delegationId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(r.delegationId);
    const checkpoint = this.#checkpoints.find(c => c.delegationId === r.delegationId);
    if (newlyRetiring && checkpoint?.operationId)
      this.options.process.cancel(checkpoint.operationId);
    const reason = r.actorId ? 'permission_revoked' : 'needs_agent_setup';
    if (checkpoint?.stage === 'blocked' && checkpoint.reason === reason) {
      // The checkpoint may predate actor retirement, or a prior save may have failed.
      // Memory equality is never evidence that the revoking marker reached disk.
      await this.#save();
      this.#recordRetirement(r, r.revocationConfirmed ? 'pending_local_cleanup' : 'pending_server');
      return;
    }
    await this.#checkpoint(
      r,
      checkpoint?.requestId ?? randomUUID(),
      checkpoint?.operationId ?? null,
      'blocked',
      reason
    );
    this.#recordRetirement(r, r.revocationConfirmed ? 'pending_local_cleanup' : 'pending_server');
  }
  #retire(r: RecoveryRegistration): Promise<void> {
    const running = this.#retirements.get(r.delegationId);
    if (running) return running;
    const task = this.#retireNow(r).finally(() => this.#retirements.delete(r.delegationId));
    this.#retirements.set(r.delegationId, task);
    return task;
  }
  async #retireNow(r: RecoveryRegistration) {
    if (!this.#registrations.includes(r)) return;
    await this.#markRetiring(r);
    const floor = (this.#retryNotBefore.get(r.delegationId) ?? 0) - this.#now();
    if (floor > 0) {
      this.#schedule(r, floor);
      return;
    }
    try {
      if (!r.revocationConfirmed) {
        const secrets = await this.#secrets.read(r.account);
        if (!secrets) {
          this.#setupRequired = true;
          this.#recordRetirement(r, 'server_unknown');
          return;
        }
        const value = await this.#call(r.endpoint, 'disconnect', secrets.refresh, {});
        if (value.revoked !== true) throw new Error('INVALID_RESPONSE');
        r.revocationConfirmed = true;
      }
      // A previous acknowledgement write may have failed; commit it before deleting the handle.
      await this.#save();
      this.#recordRetirement(r, 'server_confirmed');
      await this.#secrets.delete(r.account);
      this.#registrations = this.#registrations.filter(row => row !== r);
      this.#episodes.delete(r.delegationId);
      this.#retryNotBefore.delete(r.delegationId);
      this.#serverRetryNotBefore.delete(r.delegationId);
      this.#failures.delete(r.delegationId);
      this.#paused.delete(r.delegationId);
      this.#identityWaits.delete(r.delegationId);
      this.#checkpoints = this.#checkpoints.filter(c => c.delegationId !== r.delegationId);
      await this.#save();
      this.#recordRetirement(r, 'local_complete');
      this.#retirementStages.delete(r.delegationId);
    } catch (error) {
      this.#recordRetirement(r, r.revocationConfirmed ? 'pending_local_cleanup' : 'pending_server');
      const serverFloor = error instanceof RecoveryRequestError ? error.retryAfterMs : 0;
      const delay = Math.max(RECOVERY_BUDGET.probeMs, serverFloor);
      this.#retryNotBefore.set(r.delegationId, this.#now() + delay);
      if (serverFloor > 0)
        this.#serverRetryNotBefore.set(r.delegationId, this.#now() + serverFloor);
      await this.#save();
      this.#schedule(r, delay);
    }
  }
  async #checkIdentity(r: RecoveryRegistration) {
    if (this.#closed || !this.#registrations.includes(r)) return false;
    if (!r.revoking && r.actorId && this.options.currentActorId() === null) {
      if (!this.#identityWaits.has(r.delegationId)) {
        this.#identityWaits.add(r.delegationId);
        this.options.record?.('recovery_state', {
          stage: 'blocked',
          reason: 'needs_agent_setup',
          delegation_id: r.delegationId
        });
      }
      this.#schedule(r, RECOVERY_BUDGET.probeMs);
      return false;
    }
    if (this.#isCurrent(r)) {
      this.#identityWaits.delete(r.delegationId);
      return true;
    }
    await this.#retire(r);
    return false;
  }
  async idle() {
    await Promise.allSettled(this.#running.values());
  }
  async shutdown() {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const checkpoint of this.#checkpoints)
      if (checkpoint.stage === 'running' && checkpoint.operationId)
        this.options.process.cancel(checkpoint.operationId);
    await Promise.allSettled(this.#running.values());
    await this.#save();
  }
  #save() {
    this.#checkpoints = this.#checkpoints.map(checkpoint => {
      const value = { ...checkpoint };
      delete value.retryEpisodes;
      delete value.retryNotBefore;
      delete value.serverRetryNotBefore;
      delete value.retryAttempt;
      delete value.retrySince;
      const failure = this.#failures.get(checkpoint.delegationId);
      return {
        ...value,
        ...(this.#episodes.has(checkpoint.delegationId)
          ? { retryEpisodes: this.#episodes.get(checkpoint.delegationId) }
          : {}),
        ...(this.#retryNotBefore.has(checkpoint.delegationId)
          ? { retryNotBefore: this.#retryNotBefore.get(checkpoint.delegationId) }
          : {}),
        ...(this.#serverRetryNotBefore.has(checkpoint.delegationId)
          ? { serverRetryNotBefore: this.#serverRetryNotBefore.get(checkpoint.delegationId) }
          : {}),
        ...(failure ? { retryAttempt: failure.count, retrySince: failure.since } : {})
      };
    });
    return this.options.journal.save({
      registrations: this.#registrations,
      checkpoints: this.#checkpoints
    });
  }
  async #checkpoint(
    r: RecoveryRegistration,
    requestId: string,
    operationId: string | null,
    stage: RecoveryCheckpoint['stage'],
    reason: string | null = null
  ) {
    this.#checkpoints = this.#checkpoints.filter(c => c.delegationId !== r.delegationId);
    this.#checkpoints.push({
      delegationId: r.delegationId,
      requestId,
      operationId,
      stage,
      reason,
      updatedAt: new Date(this.#now()).toISOString(),
      ...(this.#episodes.has(r.delegationId)
        ? { retryEpisodes: this.#episodes.get(r.delegationId) }
        : {}),
      ...(this.#retryNotBefore.has(r.delegationId)
        ? { retryNotBefore: this.#retryNotBefore.get(r.delegationId) }
        : {}),
      ...(this.#serverRetryNotBefore.has(r.delegationId)
        ? { serverRetryNotBefore: this.#serverRetryNotBefore.get(r.delegationId) }
        : {})
    });
    await this.#save();
    if (operationId || stage === 'blocked' || reason) {
      this.options.record?.('recovery_state', {
        stage,
        reason: reason ?? 'none',
        request_id: requestId,
        delegation_id: r.delegationId,
        ...(operationId ? { operation_id: operationId } : {})
      });
    }
  }
  #schedule(r: RecoveryRegistration, ms: number) {
    if (this.#closed || !this.#registrations.includes(r)) return;
    const previous = this.#timers.get(r.delegationId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#timers.delete(r.delegationId);
      const task = this.#tick(r).finally(() => this.#running.delete(r.delegationId));
      this.#running.set(r.delegationId, task);
      void task.catch(() => undefined);
    }, ms);
    timer.unref();
    this.#timers.set(r.delegationId, timer);
  }
  async #call(endpoint: string, action: string, credential: string, body: Record<string, unknown>) {
    const response = await this.#fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-team-recovery-credential': credential },
      body: JSON.stringify({ action, ...body, protocolVersion: TEAM_RECOVERY_PROTOCOL_VERSION }),
      redirect: 'error',
      signal: AbortSignal.timeout(RECOVERY_BUDGET.requestMs)
    });
    const value: unknown = await response.json();
    if (!response.ok || !isRecord(value) || value.ok !== true || !isRecord(value.value)) {
      const code =
        isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string'
          ? value.error.code
          : 'DRIVE_UNAVAILABLE';
      const header = response.headers.get('retry-after');
      const seconds = header && /^\d+$/u.test(header) ? Number(header) * 1000 : 0;
      const date = header && !seconds ? Date.parse(header) - this.#now() : 0;
      throw new RecoveryRequestError(
        code,
        Math.max(0, seconds || (Number.isFinite(date) ? date : 0))
      );
    }
    return value.value;
  }
  async #rotate(r: RecoveryRegistration, secrets: RecoverySecrets) {
    if (
      secrets.claim &&
      secrets.claimExpiresAt &&
      Date.parse(secrets.claimExpiresAt) > this.#now() + 60_000
    )
      return;
    // Persist rotation ID before send. The same ID is reused after a lost response.
    await this.#secrets.write(r.account, secrets);
    const value = await this.#call(r.endpoint, 'rotate', secrets.refresh, {
      rotationId: secrets.rotationId
    });
    if (
      typeof value.refresh !== 'string' ||
      !TOKEN.test(value.refresh) ||
      typeof value.claim !== 'string' ||
      !TOKEN.test(value.claim) ||
      typeof value.claimExpiresAt !== 'string'
    )
      throw new Error('INVALID_RESPONSE');
    secrets.refresh = value.refresh;
    secrets.claim = value.claim;
    secrets.claimExpiresAt = value.claimExpiresAt;
    secrets.rotationId = randomUUID();
    await this.#secrets.write(r.account, secrets);
  }
  async #tick(r: RecoveryRegistration) {
    let requestId =
      this.#checkpoints.find(c => c.delegationId === r.delegationId)?.requestId ?? randomUUID();
    try {
      if (!(await this.#checkIdentity(r))) return;
      const retryDelay = (this.#retryNotBefore.get(r.delegationId) ?? 0) - this.#now();
      if (retryDelay > 0) {
        this.#schedule(r, retryDelay);
        return;
      }
      if (this.options.allowed && !this.options.allowed()) {
        this.#schedule(r, RECOVERY_BUDGET.probeMs);
        return;
      }
      const secrets = await this.#secrets.read(r.account);
      if (!(await this.#checkIdentity(r))) return;
      if (!secrets || Date.parse(secrets.expiresAt) <= this.#now())
        throw new Error('AUTH_REQUIRED');
      if (this.#paused.has(r.delegationId)) {
        this.#retryNotBefore.set(r.delegationId, this.#now() + RECOVERY_BUDGET.probeMs);
        await this.#save();
        const probe = await this.#call(r.endpoint, 'probe', secrets.refresh, {});
        if (!(await this.#checkIdentity(r))) return;
        if (probe.allowed !== true) {
          this.#schedule(r, RECOVERY_BUDGET.probeMs);
          return;
        }
        this.#paused.delete(r.delegationId);
      }
      let saved = this.#checkpoints.find(c => c.delegationId === r.delegationId);
      if (saved?.stage === 'blocked') {
        const history = this.#episodes.get(r.delegationId);
        // No guessed restart budget: old journals without history require explicit retry.
        if (
          saved.reason !== 'retry_exhausted' ||
          !history?.length ||
          history.length >= RECOVERY_BUDGET.episodesPerHour
        )
          return;
        const remaining = (this.#retryNotBefore.get(r.delegationId) ?? 0) - this.#now();
        if (remaining > 0) {
          this.#schedule(r, Math.max(remaining, RECOVERY_BUDGET.probeMs));
          return;
        }
        this.#retryNotBefore.set(r.delegationId, this.#now() + RECOVERY_BUDGET.probeMs);
        await this.#save();
        const probe = await this.#call(r.endpoint, 'probe', secrets.refresh, {});
        if (!(await this.#checkIdentity(r))) return;
        if (probe.allowed !== true) {
          this.#schedule(r, RECOVERY_BUDGET.probeMs);
          return;
        }
        const active = secrets.active ? activeClaim(secrets.active, r) : null;
        if (secrets.active && !active) throw new Error('INVALID_RESPONSE');
        this.#episodes.set(r.delegationId, [
          ...history.filter(t => t > this.#now() - 3_600_000),
          this.#now()
        ]);
        this.#failures.set(r.delegationId, { count: 0, since: this.#now() });
        this.#retryNotBefore.delete(r.delegationId);
        await this.#checkpoint(
          r,
          requestId,
          active?.request.operationId ?? null,
          active ? 'running' : 'claiming'
        );
        saved = this.#checkpoints.find(c => c.delegationId === r.delegationId);
      }
      if (saved?.stage === 'running') {
        // A prior process may have uploaded before its reply was lost. Never rerun it.
        const active = activeClaim(secrets.active, r);
        if (!active) throw new Error('INVALID_RESPONSE');
        const settled = await this.#call(r.endpoint, 'settle', active.credential, {
          operationId: active.request.operationId,
          jobId: active.jobId,
          leaseToken: active.leaseToken
        });
        if (!(await this.#checkIdentity(r))) return;
        if (settled.pending === true) {
          await this.#checkpoint(
            r,
            requestId,
            active.request.operationId,
            'blocked',
            'checkpoint_unavailable'
          );
          return;
        }
        secrets.active = null;
        await this.#secrets.write(r.account, secrets);
        this.#retryNotBefore.delete(r.delegationId);
        this.#serverRetryNotBefore.delete(r.delegationId);
        await this.#checkpoint(r, requestId, active.request.operationId, 'settled');
      }
      if (this.options.process.busy()) {
        this.#schedule(r, RECOVERY_BUDGET.claimMs);
        return;
      }
      await this.#rotate(r, secrets);
      if (!(await this.#checkIdentity(r))) return;
      if (!secrets.claim) throw new Error('AUTH_REQUIRED');
      if (saved?.stage !== 'claiming' && saved?.stage !== 'accepted') requestId = randomUUID();
      await this.#checkpoint(r, requestId, null, 'claiming');
      if (!(await this.#checkIdentity(r))) return;
      const value =
        secrets.active ?? (await this.#call(r.endpoint, 'claim', secrets.claim, { requestId }));
      if (!(await this.#checkIdentity(r))) return;
      if (value.pending === true) {
        await this.#checkpoint(r, requestId, null, 'blocked', 'checkpoint_unavailable');
        return;
      }
      if (value.job === null) {
        this.#failures.delete(r.delegationId);
        this.#retryNotBefore.delete(r.delegationId);
        this.#serverRetryNotBefore.delete(r.delegationId);
        await this.#checkpoint(r, requestId, null, 'settled');
        this.#schedule(r, RECOVERY_BUDGET.claimMs);
        return;
      }
      const active = activeClaim(value, r);
      if (!active) throw new Error('INVALID_RESPONSE');
      secrets.active = value;
      await this.#secrets.write(r.account, secrets);
      await this.#checkpoint(r, requestId, active.request.operationId, 'accepted');
      if (!(await this.#checkIdentity(r))) return;
      await this.#call(r.endpoint, 'checkpoint', active.credential, {
        operationId: active.request.operationId,
        jobId: active.jobId
      });
      if (!(await this.#checkIdentity(r))) return;
      await this.#checkpoint(r, requestId, active.request.operationId, 'running');
      if (!(await this.#checkIdentity(r))) return;
      let heartbeatBusy = false;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
        if (!this.#isCurrent(r)) {
          if (!r.revoking && r.actorId && this.options.currentActorId() === null)
            this.options.process.cancel(active.request.operationId);
          else void this.#markRetiring(r).catch(() => undefined);
          return;
        }
        heartbeatBusy = true;
        void this.#call(r.endpoint, 'heartbeat', active.credential, {
          operationId: active.request.operationId,
          jobId: active.jobId,
          leaseToken: active.leaseToken
        })
          .then(value => {
            if (value.cancel === true) this.options.process.cancel(active.request.operationId);
          })
          .catch(() => this.options.process.cancel(active.request.operationId))
          .finally(() => {
            heartbeatBusy = false;
          });
      }, RECOVERY_BUDGET.heartbeatMs);
      heartbeat.unref();
      try {
        await this.options.process.process(active.request);
      } finally {
        clearInterval(heartbeat);
      }
      if (!(await this.#checkIdentity(r))) return;
      const settled = await this.#call(r.endpoint, 'settle', active.credential, {
        operationId: active.request.operationId,
        jobId: active.jobId,
        leaseToken: active.leaseToken
      });
      if (!(await this.#checkIdentity(r))) return;
      if (settled.pending === true) {
        await this.#checkpoint(
          r,
          requestId,
          active.request.operationId,
          'blocked',
          'checkpoint_unavailable'
        );
        return;
      }
      secrets.active = null;
      await this.#secrets.write(r.account, secrets);
      this.#retryNotBefore.delete(r.delegationId);
      this.#serverRetryNotBefore.delete(r.delegationId);
      await this.#checkpoint(r, requestId, active.request.operationId, 'settled');
      this.#failures.delete(r.delegationId);
      this.#schedule(r, RECOVERY_BUDGET.claimMs);
    } catch (error) {
      if (this.#closed || !this.#registrations.includes(r)) return;
      if (!this.#isCurrent(r)) {
        await this.#checkIdentity(r);
        return;
      }
      const code = error instanceof Error ? error.message : '';
      if (code === 'PROCESS_RESULT_UNCERTAIN') {
        const saved = this.#checkpoints.find(c => c.delegationId === r.delegationId);
        await this.#checkpoint(
          r,
          requestId,
          saved?.operationId ?? null,
          'blocked',
          'checkpoint_unavailable'
        );
        return;
      }
      if (code === 'SPACE_BLOCKED') {
        this.#paused.add(r.delegationId);
        this.#schedule(r, RECOVERY_BUDGET.probeMs);
        return;
      }
      if (
        [
          'AUTH_REQUIRED',
          'PERMISSION_DENIED',
          'INVALID_INPUT',
          'INVALID_RESPONSE',
          'AGENT_UPDATE_REQUIRED'
        ].includes(code)
      ) {
        await this.#checkpoint(
          r,
          requestId,
          null,
          'blocked',
          code === 'PERMISSION_DENIED' ? 'permission_revoked' : 'needs_agent_setup'
        );
        return;
      }
      let episode = this.#failures.get(r.delegationId);
      if (!episode) {
        const history = (this.#episodes.get(r.delegationId) ?? []).filter(
          t => t > this.#now() - 3_600_000
        );
        if (history.length >= RECOVERY_BUDGET.episodesPerHour) {
          await this.#checkpoint(r, requestId, null, 'blocked', 'retry_exhausted');
          return;
        }
        this.#episodes.set(r.delegationId, [...history, this.#now()]);
        episode = { count: 0, since: this.#now() };
      }
      const baseDelay = RECOVERY_BUDGET.retryMs[episode.count];
      const retryAfter = error instanceof RecoveryRequestError ? error.retryAfterMs : 0;
      if (retryAfter > 0) {
        const serverDeadline = this.#now() + retryAfter;
        this.#retryNotBefore.set(r.delegationId, serverDeadline);
        this.#serverRetryNotBefore.set(r.delegationId, serverDeadline);
      } else if (!this.#serverRetryNotBefore.has(r.delegationId)) {
        this.#serverRetryNotBefore.set(r.delegationId, 0);
      }
      const delay =
        baseDelay === undefined
          ? undefined
          : Math.max(Math.round(baseDelay * (0.8 + Math.random() * 0.4)), retryAfter);
      episode.count = Math.min(6, episode.count + 1);
      this.#failures.set(r.delegationId, episode);
      if (delay === undefined || this.#now() - episode.since + delay > RECOVERY_BUDGET.episodeMs) {
        this.#retryNotBefore.set(
          r.delegationId,
          Math.max(
            this.#retryNotBefore.get(r.delegationId) ?? 0,
            this.#now() + RECOVERY_BUDGET.probeMs
          )
        );
        await this.#checkpoint(r, requestId, null, 'blocked', 'retry_exhausted');
        if ((this.#episodes.get(r.delegationId)?.length ?? 3) < RECOVERY_BUDGET.episodesPerHour)
          this.#schedule(r, Math.max(RECOVERY_BUDGET.probeMs, retryAfter));
        return;
      }
      this.#retryNotBefore.set(r.delegationId, this.#now() + delay);
      await this.#save();
      this.#schedule(r, delay);
    }
  }
}
