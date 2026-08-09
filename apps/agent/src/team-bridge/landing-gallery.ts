import { readFile, stat } from 'node:fs/promises';
import type {
  LandingRenderFailureReason,
  TeamLandingAgentRenderResult,
  TeamLandingRenderJob
} from '@video-compressor/shared';
import type { TeamOperationEvents } from './events.js';
import type { TeamPreviewBridge } from './preview.js';

const MAX_SEGMENTS = 64;
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_RENDER_WATCHDOG_MS = 3 * 60 * 1000;
const FAILURE_REPORT_TIMEOUT_MS = 10_000;

export interface TeamLandingRenderBridgeOptions {
  preview: TeamPreviewBridge;
  events: TeamOperationEvents;
  fetchImpl?: typeof fetch;
  watchdogMs?: number;
}

export class TeamLandingRenderError extends Error {
  readonly reason: LandingRenderFailureReason;

  constructor(reason: LandingRenderFailureReason, cause?: unknown) {
    super('RENDER_FAILED', { cause });
    this.name = 'TeamLandingRenderError';
    this.reason = reason;
  }
}

/** Produces content-free WebP artifacts through scoped Edge grants; no Drive credential is local. */
export class TeamLandingRenderBridge {
  readonly #preview: TeamPreviewBridge;
  readonly #events: TeamOperationEvents;
  readonly #fetch: typeof fetch;
  readonly #watchdogMs: number;
  readonly #active = new Map<string, AbortController>();

  constructor(options: TeamLandingRenderBridgeOptions) {
    this.#preview = options.preview;
    this.#events = options.events;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#watchdogMs = positiveWatchdog(options.watchdogMs ?? DEFAULT_RENDER_WATCHDOG_MS);
  }

  async render(job: TeamLandingRenderJob): Promise<TeamLandingAgentRenderResult> {
    validateJob(job);
    if (this.#active.has(job.operationId)) throw new Error('WRONG_STATE');
    const controller = new AbortController();
    this.#active.set(job.operationId, controller);
    const watchdog = setTimeout(() => {
      controller.abort(new Error('RENDER_TIMEOUT'));
      void this.#preview.close(job.operationId);
    }, this.#watchdogMs);
    watchdog.unref();
    this.#events.update(job.operationId, {
      state: 'running',
      stage: 'downloading',
      progress: 5,
      errorCode: null
    });
    try {
      const preview = await this.#preview.previewLanding({
        operationId: job.operationId,
        transferUrl: job.transferUrl,
        transferGrant: job.sourceGrant
      });
      if (preview.kind !== 'landing' || !preview.screenshotAvailable) {
        throw new TeamLandingRenderError(
          preview.kind === 'unavailable' ? renderReason(preview.reason) : 'render_error'
        );
      }
      this.#events.update(job.operationId, { stage: 'uploading', progress: 45 });
      let segmentCount = 0;
      for (let segment = 0; segment < MAX_SEGMENTS; segment += 1) {
        throwIfAborted(controller.signal);
        const file = this.#preview.screenshotPath(job.operationId, segment);
        if (!file) break;
        const metadata = await stat(file);
        if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SEGMENT_BYTES) {
          throw new TeamLandingRenderError(
            metadata.size > MAX_SEGMENT_BYTES ? 'too_large' : 'render_error'
          );
        }
        const bytes = await readFile(file);
        if (!isWebP(bytes)) throw new TeamLandingRenderError('render_error');
        await edgeValue(
          this.#fetch,
          `${job.artifactUploadUrl}/${encodeURIComponent(job.operationId)}/${segment}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'image/webp',
              'content-length': String(bytes.byteLength),
              'x-wishly-transfer-grant': job.artifactGrant.ticket,
              'x-wishly-landing-fingerprint': preview.validation.fingerprint
            },
            body: bytes,
            signal: controller.signal,
            redirect: 'error'
          }
        );
        segmentCount += 1;
        this.#events.update(job.operationId, {
          stage: 'uploading',
          progress: 45 + Math.min(40, segmentCount * 5)
        });
      }
      if (segmentCount < 1) throw new TeamLandingRenderError('render_error');
      this.#events.update(job.operationId, { stage: 'finalizing', progress: 90 });
      const committed = await edgeValue(
        this.#fetch,
        `${job.artifactUploadUrl}/${encodeURIComponent(job.operationId)}/commit`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-wishly-transfer-grant': job.artifactGrant.ticket
          },
          body: JSON.stringify({
            fingerprint: preview.validation.fingerprint,
            segmentCount
          }),
          signal: controller.signal,
          redirect: 'error'
        }
      );
      if (
        !record(committed) ||
        committed.renderId !== job.renderId ||
        committed.state !== 'ready' ||
        committed.segmentCount !== segmentCount ||
        committed.fingerprint !== preview.validation.fingerprint
      ) {
        throw new Error('INVALID_RESPONSE');
      }
      this.#events.update(job.operationId, {
        state: 'succeeded',
        stage: 'completed',
        progress: 100,
        errorCode: null
      });
      return {
        renderId: job.renderId,
        state: 'ready',
        segmentCount,
        fingerprint: preview.validation.fingerprint
      };
    } catch (cause) {
      const aborted = controller.signal.aborted;
      const timedOut = aborted && safeCode(controller.signal.reason) === 'RENDER_TIMEOUT';
      const canceled = aborted && !timedOut;
      const reason = cause instanceof TeamLandingRenderError ? cause.reason : 'render_error';
      await this.#reportFailure(job, reason).catch(() => undefined);
      this.#events.update(job.operationId, {
        state: canceled ? 'canceled' : 'failed',
        stage: canceled ? 'canceled' : 'failed',
        errorCode: canceled ? 'PREVIEW_CANCELED' : timedOut ? 'RENDER_TIMEOUT' : safeCode(cause)
      });
      if (canceled) throw new Error('PREVIEW_CANCELED', { cause });
      if (timedOut) throw new Error('RENDER_TIMEOUT', { cause });
      if (cause instanceof TeamLandingRenderError) throw cause;
      throw cause;
    } finally {
      clearTimeout(watchdog);
      this.#active.delete(job.operationId);
      await this.#preview.close(job.operationId).catch(() => undefined);
    }
  }

  cancel(operationId: string): boolean {
    const controller = this.#active.get(operationId);
    if (!controller) return false;
    controller.abort(new Error('PREVIEW_CANCELED'));
    void this.#preview.close(operationId);
    return true;
  }

  busy(): boolean {
    return this.#active.size > 0;
  }

  async shutdown(): Promise<void> {
    for (const operationId of this.#active.keys()) this.cancel(operationId);
  }

  async #reportFailure(job: TeamLandingRenderJob, reason: LandingRenderFailureReason) {
    await edgeValue(
      this.#fetch,
      `${job.artifactUploadUrl}/${encodeURIComponent(job.operationId)}/fail`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wishly-transfer-grant': job.artifactGrant.ticket
        },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(FAILURE_REPORT_TIMEOUT_MS),
        redirect: 'error'
      }
    );
  }
}

function validateJob(job: TeamLandingRenderJob): void {
  if (
    !uuid(job.operationId) ||
    !uuid(job.renderId) ||
    !uuid(job.teamId) ||
    !uuid(job.materialId) ||
    !/^[a-z0-9_-]{1,64}$/iu.test(job.preset) ||
    job.sourceGrant.purpose !== 'preview_range' ||
    job.artifactGrant.purpose !== 'preview_range'
  ) {
    throw new Error('INVALID_INPUT');
  }
  for (const value of [job.transferUrl, job.artifactUploadUrl]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('INVALID_INPUT');
    }
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith('/functions/v1/drive-transfer/')
    ) {
      throw new Error('INVALID_INPUT');
    }
  }
}

function renderReason(reason: string): LandingRenderFailureReason {
  return ['unsupported', 'corrupt', 'protected', 'too_large'].includes(reason)
    ? (reason as LandingRenderFailureReason)
    : 'render_error';
}

function isWebP(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 32 &&
    Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.buffer, bytes.byteOffset + 8, 4).toString('ascii') === 'WEBP'
  );
}

async function edgeValue(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw new Error('DRIVE_UNAVAILABLE', { cause });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!record(payload)) throw new Error('INVALID_RESPONSE');
  if (response.ok && payload.ok === true && 'value' in payload) return payload.value;
  const error =
    record(payload.error) && typeof payload.error.code === 'string'
      ? payload.error.code
      : 'DRIVE_UNAVAILABLE';
  throw new Error(error);
}

function safeCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.message)
    ? error.message
    : 'RENDER_FAILED';
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('PREVIEW_CANCELED');
}

function positiveWatchdog(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30 * 60 * 1000) {
    throw new Error('INVALID_INPUT');
  }
  return value;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
