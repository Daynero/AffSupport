import {
  RESTITCH_DETECTOR_VERSION,
  type TeamFileOperationResult,
  type TeamTransferGrant,
  type ToolContracts
} from '@video-compressor/shared';
import type { TeamProcessRequest } from './process.js';
import type { UpdaterCredential, UpdaterCredentialStore } from './updater-credential.js';

/**
 * The catalog updater's re-stitching computer (023, delivery 2).
 *
 * While this computer is enrolled for a space, it asks the server every half a minute to a minute
 * whether a catalog needs a spare re-stitched copy — only when the app is entitled, not draining for
 * an update, and doing nothing else. A job arrives as the same process request a member's page
 * would send, and runs through the same bridge; a heartbeat keeps its lease and stops it the moment
 * the updater no longer wants it. The copy itself lands through the ordinary finalize, where the
 * server makes it the catalog's spare; the runner only reports how the run went and what it learned
 * about the video.
 */

const POLL_MIN_MS = 30_000;
const POLL_JITTER_MS = 30_000;
const AFTER_JOB_MS = 3_000;
const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REFUSED_BACKOFF_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface UpdaterProcessBridge {
  process(request: TeamProcessRequest): Promise<TeamFileOperationResult>;
  cancel(operationId: string): boolean;
}

export interface UpdaterRunnerOptions {
  store: UpdaterCredentialStore;
  bridge: UpdaterProcessBridge;
  /** Entitled, accepting new tasks, and no other tool at work. */
  canWork: () => boolean;
  build: string;
  contracts: ToolContracts;
  fetch?: typeof fetch;
  random?: () => number;
  log?: (message: string, detail?: string) => void;
}

interface ClaimedJob {
  jobId: string;
  leaseToken: string;
  operationId: string;
  toolId: string;
  options: { defaults: unknown; prepared: unknown };
  sourceGrant: TeamTransferGrant;
  finalizeGrant: TeamTransferGrant;
}

class RefusedError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJob(value: unknown): ClaimedJob | null {
  if (!isRecord(value)) return null;
  const { jobId, leaseToken, operationId, toolId, options, sourceGrant, finalizeGrant } = value;
  if (
    typeof jobId !== 'string' ||
    typeof leaseToken !== 'string' ||
    typeof operationId !== 'string' ||
    toolId !== 'restitch' ||
    !isRecord(options) ||
    !isRecord(sourceGrant) ||
    !isRecord(finalizeGrant)
  ) {
    return null;
  }
  return {
    jobId,
    leaseToken,
    operationId,
    toolId,
    options: { defaults: options.defaults, prepared: options.prepared ?? null },
    sourceGrant: sourceGrant as unknown as TeamTransferGrant,
    finalizeGrant: finalizeGrant as unknown as TeamTransferGrant
  };
}

/** A preparation from an older detector is no preparation: the run inspects for itself. */
function currentPrep(prepared: unknown): unknown {
  return isRecord(prepared) && prepared.detectorVersion === RESTITCH_DETECTOR_VERSION
    ? prepared
    : null;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(message) ? message : 'PROCESS_FAILED';
}

export class UpdaterRunner {
  readonly #store: UpdaterCredentialStore;
  readonly #bridge: UpdaterProcessBridge;
  readonly #canWork: () => boolean;
  readonly #build: string;
  readonly #contracts: ToolContracts;
  readonly #fetch: typeof fetch;
  readonly #random: () => number;
  readonly #log: (message: string, detail?: string) => void;
  #credential: UpdaterCredential | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #active: { operationId: string; promise: Promise<void> } | null = null;
  #failures = 0;
  #stopped = false;

  constructor(options: UpdaterRunnerOptions) {
    this.#store = options.store;
    this.#bridge = options.bridge;
    this.#canWork = options.canWork;
    this.#build = options.build;
    this.#contracts = options.contracts;
    this.#fetch = options.fetch ?? fetch;
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? (() => undefined);
  }

  async start(): Promise<void> {
    this.#credential = await this.#store.read();
    if (this.#credential) this.#schedule(AFTER_JOB_MS);
  }

  async enroll(credential: UpdaterCredential): Promise<void> {
    await this.#store.write(credential);
    this.#credential = credential;
    this.#failures = 0;
    this.#schedule(0);
  }

  async unenroll(): Promise<void> {
    this.#credential = null;
    this.#clearTimer();
    await this.#store.clear();
    if (this.#active) this.#bridge.cancel(this.#active.operationId);
  }

  status(): { enrolled: { teamId: string; deviceId: string } | null; working: boolean } {
    return {
      enrolled: this.#credential
        ? { teamId: this.#credential.teamId, deviceId: this.#credential.deviceId }
        : null,
      working: this.#active !== null
    };
  }

  busy(): boolean {
    return this.#active !== null;
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    this.#clearTimer();
    const active = this.#active;
    if (active) {
      this.#bridge.cancel(active.operationId);
      await active.promise.catch(() => undefined);
    }
  }

  /** One poll, awaited — the timer calls it, and tests drive it directly. */
  async tick(): Promise<void> {
    this.#timer = null;
    const credential = this.#credential;
    if (this.#stopped || !credential || this.#active) return;
    if (!this.#canWork()) {
      this.#schedule(this.#pollDelay());
      return;
    }
    let job: ClaimedJob | null;
    try {
      const answer = await this.#post(credential, 'claim', {
        deviceId: credential.deviceId,
        build: this.#build,
        toolContracts: this.#contracts
      });
      job = isRecord(answer) ? parseJob(answer.job) : null;
      this.#failures = 0;
    } catch (error) {
      this.#schedule(this.#backoff(error));
      return;
    }
    if (!job) {
      this.#schedule(this.#pollDelay());
      return;
    }
    const promise = this.#run(credential, job).finally(() => {
      this.#active = null;
      this.#schedule(AFTER_JOB_MS);
    });
    this.#active = { operationId: job.operationId, promise };
    await promise;
  }

  async #run(credential: UpdaterCredential, job: ClaimedJob): Promise<void> {
    const lease = { deviceId: credential.deviceId, jobId: job.jobId, leaseToken: job.leaseToken };
    let cancelled = false;
    const heartbeat = setInterval(() => {
      void this.#post(credential, 'heartbeat', lease)
        .then(answer => {
          if (isRecord(answer) && answer.cancel === true && !cancelled) {
            cancelled = true;
            this.#bridge.cancel(job.operationId);
          }
        })
        .catch(error => {
          // A revoked computer or a removed member: nothing it makes will be wanted.
          if (error instanceof RefusedError && !cancelled) {
            cancelled = true;
            this.#bridge.cancel(job.operationId);
          }
        });
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let report: Record<string, unknown>;
    try {
      const result = await this.#bridge.process({
        operationId: job.operationId,
        toolId: job.toolId,
        options: { defaults: job.options.defaults, prepared: currentPrep(job.options.prepared) },
        sourceGrant: job.sourceGrant,
        finalizeGrant: job.finalizeGrant,
        transferUrl: credential.cloudBaseUrl.replace(/\/drive-ops$/u, '/drive-transfer/range'),
        cloudBaseUrl: credential.cloudBaseUrl
      });
      report =
        result.state === 'succeeded'
          ? { outcome: 'finalized', discovered: result.discovered ?? null }
          : {
              outcome: 'failed',
              errorCode: 'PROCESS_FAILED',
              discovered: result.discovered ?? null
            };
    } catch (error) {
      report = { outcome: 'failed', errorCode: errorCode(error) };
    } finally {
      clearInterval(heartbeat);
    }
    if (cancelled) return;
    await this.#post(credential, 'complete', { ...lease, ...report }).catch(error => {
      this.#log('[updater] completion not reported', errorCode(error));
    });
  }

  async #post(
    credential: UpdaterCredential,
    route: 'claim' | 'heartbeat' | 'complete',
    body: Record<string, unknown>
  ): Promise<unknown> {
    const response = await this.#fetch(`${credential.cloudBaseUrl}/updater/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-soty-device-secret': credential.secret },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok && isRecord(payload)) return payload;
    const code =
      isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string'
        ? payload.error.code
        : '';
    if (
      response.status === 401 ||
      response.status === 403 ||
      code === 'PERMISSION_DENIED' ||
      code === 'AUTH_REQUIRED'
    ) {
      throw new RefusedError(code || 'PERMISSION_DENIED');
    }
    throw new Error(code || 'DRIVE_UNAVAILABLE');
  }

  #pollDelay(): number {
    return POLL_MIN_MS + Math.floor(this.#random() * POLL_JITTER_MS);
  }

  #backoff(error: unknown): number {
    if (error instanceof RefusedError) {
      this.#log('[updater] this computer was refused', error.message);
      return REFUSED_BACKOFF_MS;
    }
    this.#failures += 1;
    return Math.min(MAX_BACKOFF_MS, this.#pollDelay() * 2 ** Math.min(this.#failures - 1, 4));
  }

  #schedule(delayMs: number): void {
    if (this.#stopped || !this.#credential) return;
    this.#clearTimer();
    this.#timer = setTimeout(() => void this.tick(), delayMs);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
