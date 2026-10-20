import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  isRecord,
  parseTeamTransferGrant,
  parseMaterialRestitchPrep,
  usablePrep,
  RECOVERY_BUDGET,
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
    { ticket: string; teamId: string; endpoint: string; installationId: string; until: number }
  >();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #running = new Map<string, Promise<void>>();
  #paused = new Set<string>();
  #episodes = new Map<string, number[]>();
  #retryNotBefore = new Map<string, number>();
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
    }
    this.#installation = this.#registrations[0]?.installationId ?? this.#installation;
    this.#loaded = true;
    for (const registration of this.#registrations) this.#schedule(registration, 0);
  }
  begin(teamId: string, endpoint: string) {
    if (
      !this.#loaded ||
      !UUID.test(teamId) ||
      (this.#registrations.length >= 6 && !this.#registrations.some(r => r.teamId === teamId))
    )
      throw new Error('WRONG_STATE');
    const id = randomUUID();
    const ticket = randomBytes(32).toString('base64url');
    const now = this.#now();
    for (const [key, item] of this.#enrollments)
      if (item.until <= now) this.#enrollments.delete(key);
    if (this.#enrollments.size >= 6) throw new Error('RATE_LIMITED');
    this.#enrollments.set(id, {
      ticket,
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
        .update(this.options.environment + '|' + enrollment.endpoint + '|' + enrollment.teamId)
        .digest('hex');
    const registration = {
      teamId: enrollment.teamId,
      installationId: enrollment.installationId,
      endpoint: enrollment.endpoint,
      delegationId,
      account
    };
    if (this.#registrations.some(r => r.teamId === enrollment.teamId))
      await this.remove(enrollment.teamId);
    // Secret durability precedes successful enrollment and the metadata index.
    await this.#secrets.write(account, {
      refresh,
      expiresAt,
      rotationId: randomUUID(),
      claim: null,
      claimExpiresAt: null,
      active: null
    });
    this.#registrations = this.#registrations.filter(r => r.teamId !== registration.teamId);
    this.#registrations.push(registration);
    this.#setupRequired = false;
    await this.#save();
    this.#schedule(registration, 0);
    return { enabled: true, installationId: registration.installationId };
  }
  status(teamId: string) {
    const registration = this.#registrations.find(r => r.teamId === teamId);
    const checkpoint = this.#checkpoints.find(c => c.delegationId === registration?.delegationId);
    return {
      enabled: !!registration,
      installationId: registration?.installationId ?? this.#installation,
      state: checkpoint?.stage ?? (this.#setupRequired ? 'blocked' : 'idle'),
      reason: checkpoint?.reason ?? (this.#setupRequired ? 'needs_agent_setup' : null)
    };
  }
  async retry(teamId: string) {
    const registration = this.#registrations.find(r => r.teamId === teamId);
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
    this.#retryNotBefore.delete(registration.delegationId);
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
    const registration = this.#registrations.find(r => r.teamId === teamId);
    if (!registration) return { disabled: true };
    const timer = this.#timers.get(registration.delegationId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(registration.delegationId);
    this.#registrations = this.#registrations.filter(r => r !== registration);
    const checkpoint = this.#checkpoints.find(c => c.delegationId === registration.delegationId);
    if (checkpoint?.operationId) this.options.process.cancel(checkpoint.operationId);
    await this.#running.get(registration.delegationId);
    await this.#secrets.delete(registration.account);
    this.#episodes.delete(registration.delegationId);
    this.#retryNotBefore.delete(registration.delegationId);
    this.#failures.delete(registration.delegationId);
    this.#paused.delete(registration.delegationId);
    this.#checkpoints = this.#checkpoints.filter(c => c.delegationId !== registration.delegationId);
    await this.#save();
    return { disabled: true };
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
      body: JSON.stringify({ action, ...body }),
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
      if (this.options.allowed && !this.options.allowed()) {
        this.#schedule(r, RECOVERY_BUDGET.probeMs);
        return;
      }
      const secrets = await this.#secrets.read(r.account);
      if (!secrets || Date.parse(secrets.expiresAt) <= this.#now())
        throw new Error('AUTH_REQUIRED');
      if (this.#paused.has(r.delegationId)) {
        this.#retryNotBefore.set(r.delegationId, this.#now() + RECOVERY_BUDGET.probeMs);
        await this.#save();
        const probe = await this.#call(r.endpoint, 'probe', secrets.refresh, {});
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
        await this.#checkpoint(r, requestId, active.request.operationId, 'settled');
      }
      if (this.options.process.busy()) {
        this.#schedule(r, RECOVERY_BUDGET.claimMs);
        return;
      }
      await this.#rotate(r, secrets);
      if (!secrets.claim) throw new Error('AUTH_REQUIRED');
      if (saved?.stage !== 'claiming' && saved?.stage !== 'accepted') requestId = randomUUID();
      await this.#checkpoint(r, requestId, null, 'claiming');
      const value =
        secrets.active ?? (await this.#call(r.endpoint, 'claim', secrets.claim, { requestId }));
      if (value.pending === true) {
        await this.#checkpoint(r, requestId, null, 'blocked', 'checkpoint_unavailable');
        return;
      }
      if (value.job === null) {
        this.#failures.delete(r.delegationId);
        await this.#checkpoint(r, requestId, null, 'settled');
        this.#schedule(r, RECOVERY_BUDGET.claimMs);
        return;
      }
      const active = activeClaim(value, r);
      if (!active) throw new Error('INVALID_RESPONSE');
      secrets.active = value;
      await this.#secrets.write(r.account, secrets);
      await this.#checkpoint(r, requestId, active.request.operationId, 'accepted');
      if (this.#closed || !this.#registrations.includes(r)) return;
      await this.#call(r.endpoint, 'checkpoint', active.credential, {
        operationId: active.request.operationId,
        jobId: active.jobId
      });
      if (this.#closed || !this.#registrations.includes(r)) return;
      await this.#checkpoint(r, requestId, active.request.operationId, 'running');
      if (this.#closed || !this.#registrations.includes(r)) return;
      let heartbeatBusy = false;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
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
      const settled = await this.#call(r.endpoint, 'settle', active.credential, {
        operationId: active.request.operationId,
        jobId: active.jobId,
        leaseToken: active.leaseToken
      });
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
      await this.#checkpoint(r, requestId, active.request.operationId, 'settled');
      this.#failures.delete(r.delegationId);
      this.#schedule(r, RECOVERY_BUDGET.claimMs);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'SPACE_BLOCKED') {
        this.#paused.add(r.delegationId);
        this.#schedule(r, RECOVERY_BUDGET.probeMs);
        return;
      }
      if (
        ['AUTH_REQUIRED', 'PERMISSION_DENIED', 'INVALID_INPUT', 'INVALID_RESPONSE'].includes(code)
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
      if (retryAfter > 0) this.#retryNotBefore.set(r.delegationId, this.#now() + retryAfter);
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
      await this.#save();
      this.#schedule(r, delay);
    }
  }
}
