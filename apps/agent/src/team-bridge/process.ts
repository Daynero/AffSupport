import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  COMPRESSION_LIFECYCLE,
  LANDING_JOB_LIFECYCLE,
  TRANSCRIPTION_LIFECYCLE,
  isSettled,
  type AgentSettings,
  type AgentSettingsPatch,
  type LandingSettings,
  type TeamAgentProcessRequest,
  type TeamFileOperationResult
} from '@video-compressor/shared';
import { parseSettingsPatch } from '../compressor/settings-validation.js';
import type { LandingOptimizer } from '../landing/optimizer.js';
import type { JobQueue } from '../queue/queue.js';
import { activeGovernorOrNull } from '../power/spawn.js';
import type { TranscriptionQueue } from '../queue/transcription-queue.js';
import type { TeamOperationEvents } from './events.js';
import type {
  DownloadedTeamSource,
  TeamResultUploadRequest,
  TeamSourceDownloadRequest
} from './transfer.js';

const DEFAULT_WATCHDOG_MS = 6 * 60 * 60 * 1000;
/**
 * How long a hold stands without being re-asserted by the page that took it.
 *
 * A browser does not always tell the agent it has gone: a reload leaves the
 * socket open and the request handler simply keeps running, which is why the
 * run itself survives a refresh. A *pause* must not survive one — nothing would
 * ever lift it, and a stopped child would sit on the machine until the app is
 * quit. So the interface re-asserts a pause it still wants, and a hold nobody
 * has spoken for in this long is let go.
 */
const PAUSE_LAPSE_MS = 120_000;
const JOB_OBSERVE_INTERVAL_MS = 75;
const CANCEL_SETTLE_MS = 5_000;

export interface TeamProcessRequest extends TeamAgentProcessRequest {
  transferUrl: string;
  cloudBaseUrl: string;
}

export interface TeamProcessDelegateInput {
  operationId: string;
  workspace: string;
  sourceFile: string;
  sourceSizeBytes: number;
  sourceVersion: string | null;
  sourceChecksum: string | null;
  options: unknown;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  /**
   * Offers a way to suspend this run's local work, and withdraws it (`null`)
   * once there is nothing left to suspend.
   *
   * A delegate that never calls it simply cannot be paused, and the bridge says
   * so rather than reporting a pause it did not perform — a landing
   * optimization, for instance, has no pausable child of its own.
   */
  pausable: (setPaused: ((paused: boolean) => boolean) | null) => void;
}

export interface TeamProcessDelegateResult {
  file: string;
  mimeType: string;
  sizeBytes: number;
  cleanup?: () => Promise<void>;
  /**
   * Anything the run had to work out for itself and that is worth keeping.
   *
   * 015 uses it for what an inspection found: the caller stores it, and the next member's
   * delivery of the same material skips the six to fourteen seconds it cost. The bridge only
   * carries it — it does not look inside, and it does not write it anywhere.
   */
  discovered?: unknown;
}

export type TeamProcessDelegate = (
  input: TeamProcessDelegateInput
) => Promise<TeamProcessDelegateResult>;

export interface TeamProcessTransfer {
  downloadSource(
    request: TeamSourceDownloadRequest,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource>;
  uploadResult(
    request: TeamResultUploadRequest,
    signal: AbortSignal
  ): Promise<TeamFileOperationResult>;
}

export interface TeamProcessBridgeOptions {
  transfer: TeamProcessTransfer;
  delegates: Readonly<Record<string, TeamProcessDelegate>>;
  events: TeamOperationEvents;
  watchdogMs?: number;
}

export interface TeamProcessPipelines {
  compressor: JobQueue;
  transcription: TranscriptionQueue;
  landing: LandingOptimizer;
}

export function createTeamProcessDelegates(
  pipelines: TeamProcessPipelines
): Record<string, TeamProcessDelegate> {
  return {
    compressor: compressionDelegate(pipelines.compressor, false),
    imageEmbedding: compressionDelegate(pipelines.compressor, true),
    transcription: transcriptionDelegate(pipelines.transcription),
    translation: transcriptionDelegate(pipelines.transcription, true),
    landingOptimizer: landingDelegate(pipelines.landing)
  };
}

interface ActiveProcess {
  controller: AbortController;
  /** Assigned the moment `#run` is called; nothing reads it before that. */
  promise: Promise<TeamFileOperationResult> | null;
  paused: boolean;
  /** Lets a hold go if the page that took it stops saying it still wants it. */
  lapse: ReturnType<typeof setTimeout> | null;
  /** What the running delegate offers, while it is in a phase that can be held. */
  pause: ((paused: boolean) => boolean) | null;
  /** Stops and restarts the run's wall-clock budget across a pause. */
  watchdog: { hold: () => void; resume: () => void } | null;
}

/** Coordinates a cloud-authorized team operation with an existing local tool. */
export class TeamProcessBridge {
  readonly #transfer: TeamProcessTransfer;
  readonly #delegates: Readonly<Record<string, TeamProcessDelegate>>;
  readonly #events: TeamOperationEvents;
  readonly #watchdogMs: number;
  readonly #active = new Map<string, ActiveProcess>();

  constructor(options: TeamProcessBridgeOptions) {
    this.#transfer = options.transfer;
    this.#delegates = Object.freeze({ ...options.delegates });
    this.#events = options.events;
    this.#watchdogMs = positiveWatchdog(options.watchdogMs ?? DEFAULT_WATCHDOG_MS);
  }

  process(request: TeamProcessRequest): Promise<TeamFileOperationResult> {
    validateRequest(request);
    const delegate = this.#delegates[request.toolId];
    if (!delegate) return Promise.reject(new Error('AGENT_UPDATE_REQUIRED'));
    if (this.#active.has(request.operationId)) {
      return Promise.reject(new Error('WRONG_STATE'));
    }

    const controller = new AbortController();
    const active: ActiveProcess = {
      controller,
      promise: null,
      paused: false,
      lapse: null,
      pause: null,
      watchdog: null
    };
    const promise = this.#run(request, delegate, controller, active);
    active.promise = promise;
    this.#active.set(request.operationId, active);
    void promise
      .finally(() => {
        this.#active.delete(request.operationId);
      })
      .catch(() => undefined);
    return promise;
  }

  cancel(operationId: string): boolean {
    const active = this.#active.get(operationId);
    if (!active) return false;
    // A suspended process is not delivered its termination signal until it runs
    // again, so a cancel during a pause would otherwise wait for a resume that
    // is never coming.
    this.#resume(active);
    active.controller.abort(new Error('PROCESS_CANCELED'));
    return true;
  }

  /**
   * Suspends or resumes the local work behind one operation.
   *
   * The run stays `running` as far as the cloud is concerned: the file is still
   * checked out, the grants are still spent, and only this machine's CPU is
   * given back. Nothing here is persisted: a pause belongs to the page that
   * pressed it, and `resume()` is what the route calls when that page goes
   * away — a run whose only means of being resumed has closed would otherwise
   * hold a suspended child for as long as the app stays open.
   */
  setPaused(operationId: string, paused: boolean): 'ok' | 'not-found' | 'unsupported' {
    const active = this.#active.get(operationId);
    if (!active) return 'not-found';
    if (!paused) {
      this.#resume(active);
      return 'ok';
    }
    // Asking again for a pause already in force is how the interface says it is
    // still there; it must not take a second hold.
    if (!active.paused) {
      if (!active.pause || !active.pause(true)) return 'unsupported';
      active.paused = true;
      active.watchdog?.hold();
    }
    this.#armLapse(active);
    return 'ok';
  }

  #armLapse(active: ActiveProcess): void {
    if (active.lapse) clearTimeout(active.lapse);
    active.lapse = setTimeout(() => this.#resume(active), PAUSE_LAPSE_MS);
    active.lapse.unref();
  }

  paused(operationId: string): boolean {
    return this.#active.get(operationId)?.paused === true;
  }

  /**
   * Lets a held run go again without touching the queue that held it.
   *
   * The work is deliberately not cancelled: the agent finishes and uploads the
   * result on its own, so a closed page loses nothing, while a pause it can no
   * longer lift would strand a stopped process indefinitely.
   */
  resume(operationId: string): void {
    const active = this.#active.get(operationId);
    if (active) this.#resume(active);
  }

  #resume(active: ActiveProcess): void {
    if (active.lapse) clearTimeout(active.lapse);
    active.lapse = null;
    if (!active.paused) return;
    active.paused = false;
    active.pause?.(false);
    active.watchdog?.resume();
  }

  busy(): boolean {
    return this.#active.size > 0;
  }

  supportedTools(): string[] {
    return Object.keys(this.#delegates).sort();
  }

  async shutdown(): Promise<void> {
    for (const active of this.#active.values()) {
      // Resume first, for the same reason a cancel does: a stopped child never
      // sees the signal, and the agent would wait out its grace period.
      this.#resume(active);
      active.controller.abort(new Error('PROCESS_CANCELED'));
    }
    await Promise.allSettled(
      [...this.#active.values()].map(active => active.promise).filter(promise => promise !== null)
    );
  }

  async #run(
    request: TeamProcessRequest,
    delegate: TeamProcessDelegate,
    controller: AbortController,
    active: ActiveProcess
  ): Promise<TeamFileOperationResult> {
    let downloaded: DownloadedTeamSource | null = null;
    let cleanupOutput: (() => Promise<void>) | null = null;
    // Scaled, not fixed — the same rule the landing bridge already follows.
    // This ceiling covers a compression or transcription that runs as a managed
    // child, so at a 20% limit the work legitimately takes roughly five times as
    // long, and an unscaled six-hour budget would abort a job for honouring the
    // user's own limit.
    const watchdog = pausableDeadline(
      activeGovernorOrNull()?.scaleTimeout(this.#watchdogMs) ?? this.#watchdogMs,
      () => controller.abort(new Error('PROCESS_TIMEOUT'))
    );
    // Paused time is not spent time: a run held for an hour has not been
    // running for an hour, and letting the budget expire during a pause would
    // fail work the person only meant to set aside.
    active.watchdog = watchdog;

    try {
      this.#events.update(request.operationId, {
        state: 'running',
        stage: 'downloading',
        progress: 0,
        errorCode: null
      });
      downloaded = await this.#transfer.downloadSource(
        {
          operationId: request.operationId,
          transferUrl: request.transferUrl,
          grant: request.sourceGrant
        },
        controller.signal
      );
      throwIfAborted(controller.signal);

      this.#events.update(request.operationId, {
        stage: 'processing',
        progress: 20
      });
      const output = await delegate({
        operationId: request.operationId,
        workspace: downloaded.workspace,
        sourceFile: downloaded.file,
        sourceSizeBytes: downloaded.sizeBytes,
        sourceVersion: downloaded.sourceVersion,
        sourceChecksum: downloaded.sourceChecksum,
        options: request.options,
        signal: controller.signal,
        pausable: setPaused => {
          active.pause = setPaused;
          // A run paused before its local job existed is honoured the moment
          // one does, rather than quietly starting at full speed.
          if (active.paused && setPaused) setPaused(true);
        },
        onProgress: progress => {
          this.#events.update(request.operationId, {
            stage: 'processing',
            progress: 20 + clampProgress(progress) * 0.5
          });
        }
      });
      throwIfAborted(controller.signal);
      validateDelegateResult(output);
      cleanupOutput = output.cleanup ?? null;

      this.#events.update(request.operationId, {
        stage: 'uploading',
        progress: 70
      });
      const result = await this.#transfer.uploadResult(
        {
          operationId: request.operationId,
          cloudBaseUrl: request.cloudBaseUrl,
          finalizeGrant: request.finalizeGrant,
          file: output.file,
          mimeType: output.mimeType,
          sizeBytes: output.sizeBytes,
          onProgress: (completed, total) => {
            const ratio = total > 0 ? completed / total : 0;
            this.#events.update(request.operationId, {
              stage: 'uploading',
              progress: 70 + clampProgress(ratio * 100) * 0.25
            });
          }
        },
        controller.signal
      );
      throwIfAborted(controller.signal);

      this.#events.update(request.operationId, {
        stage: 'finalizing',
        progress: 96
      });
      if (result.state === 'succeeded') {
        this.#events.update(request.operationId, {
          state: 'succeeded',
          stage: 'completed',
          progress: 100,
          errorCode: null
        });
      } else {
        this.#events.update(request.operationId, {
          state: result.state === 'canceled' ? 'canceled' : 'failed',
          stage: result.state === 'canceled' ? 'canceled' : 'failed',
          errorCode: result.state === 'canceled' ? 'PROCESS_CANCELED' : 'PROCESS_FAILED'
        });
      }
      return result;
    } catch (error) {
      const canceled = controller.signal.aborted;
      // Debug (013): the generic PROCESS_FAILED hid every real upload error;
      // surface the underlying message in the agent's stdout.
      if (!canceled) {
        const describe = (err: unknown, depth = 0): string => {
          if (!(err instanceof Error)) return String(err);
          const cause = depth < 3 && err.cause !== undefined ? describe(err.cause, depth + 1) : '';
          return `${err.message}${cause ? ` <= cause: ${cause}` : ''}`;
        };
        console.error(
          '[team-process] failed:',
          describe(error),
          error instanceof Error ? (error.stack ?? '') : ''
        );
      }
      const code = canceled ? abortCode(controller.signal) : safeErrorCode(error);
      this.#events.update(request.operationId, {
        state: canceled ? 'canceled' : 'failed',
        stage: canceled ? 'canceled' : 'failed',
        errorCode: code
      });
      throw new Error(code, { cause: error });
    } finally {
      watchdog.clear();
      // Nothing local is left to hold: transfers are not pausable, and pausing
      // an operation that has finished its work would hold nothing while
      // telling the person it had.
      active.pause = null;
      active.paused = false;
      if (active.lapse) clearTimeout(active.lapse);
      active.lapse = null;
      active.watchdog = null;
      await cleanupOutput?.().catch(() => undefined);
      await downloaded?.cleanup().catch(() => undefined);
    }
  }
}

function compressionDelegate(queue: JobQueue, embedding: boolean): TeamProcessDelegate {
  return async input => {
    const sourceKey = `team:${input.operationId}`;
    const settings = compressionSettings(queue, input.options, embedding);
    const warnings = await queue.addTeamUploaded(
      input.sourceFile,
      'team-source.mp4',
      sourceKey,
      settings
    );
    let job = queue.teamJob(sourceKey);
    if (warnings.length || !job) throw new Error('UNSUPPORTED_MEDIA');
    let handoff = false;
    try {
      if (!(await queue.start([job.id]))) throw new Error('WRONG_STATE');
      input.pausable(paused => queue.setPaused(job!.id, paused) === 'ok');
      job = await waitForTerminal({
        read: () => queue.teamJob(sourceKey),
        signal: input.signal,
        cancel: () => queue.cancel(job!.id),
        terminal: value => isSettled(COMPRESSION_LIFECYCLE, value.status),
        progress: value => input.onProgress(value.progress ?? 0)
      });
      if (input.signal.aborted || job.status === 'cancelled') throw new Error('PROCESS_CANCELED');
      if (job.status !== 'completed' || !job.outputPath) throw new Error('PROCESS_FAILED');
      const output = await stat(job.outputPath);
      if (!output.isFile() || output.size < 1) throw new Error('INVALID_RESPONSE');
      handoff = true;
      return {
        file: job.outputPath,
        mimeType: 'video/mp4',
        sizeBytes: output.size,
        cleanup: async () => {
          await queue.discardTeamJob(job!.id);
        }
      };
    } finally {
      input.pausable(null);
      if (!handoff && job) await queue.discardTeamJob(job.id);
    }
  };
}

function compressionSettings(queue: JobQueue, value: unknown, embedding: boolean): AgentSettings {
  if (!record(value)) throw new Error('INVALID_INPUT');
  const current = queue.state().settings;
  const parsed = parseSettingsPatch(value as AgentSettingsPatch, current.imageEmbedding);
  if (!parsed.ok) throw new Error('INVALID_INPUT');
  const imageEmbedding = {
    ...current.imageEmbedding,
    ...(parsed.patch.imageEmbedding ?? {}),
    enabled: embedding
  };
  if (
    embedding &&
    imageEmbedding.startImages.length === 0 &&
    imageEmbedding.endImages.length === 0
  ) {
    throw new Error('EMBED_IMAGES_REQUIRED');
  }
  return {
    ...current,
    ...parsed.patch,
    outputMode: 'next-to-originals',
    outputFolder: null,
    imageEmbedding
  };
}

function transcriptionDelegate(queue: TranscriptionQueue, translate = false): TeamProcessDelegate {
  return async input => {
    const options = record(input.options) ? input.options : null;
    if (!options) throw new Error('INVALID_INPUT');
    const allowedKeys = translate ? ['language', 'targetLanguage'] : ['language'];
    const unknownKeys = Object.keys(options).filter(key => !allowedKeys.includes(key));
    const language = options.language ?? queue.state().settings.language;
    const targetLanguage = translate ? options.targetLanguage : null;
    if (
      unknownKeys.length > 0 ||
      typeof language !== 'string' ||
      !/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/u.test(language) ||
      (translate &&
        (typeof targetLanguage !== 'string' ||
          !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(targetLanguage)))
    ) {
      throw new Error('INVALID_INPUT');
    }
    const validatedTargetLanguage =
      translate && typeof targetLanguage === 'string' ? targetLanguage : null;
    const tooling = queue.state().tools;
    if (!tooling.ffmpeg || !tooling.whisper || !tooling.model) {
      throw new Error('AGENT_REQUIRED');
    }

    const sourceKey = `team:${input.operationId}`;
    const warnings = await queue.addTeamUploaded(
      input.sourceFile,
      'team-source.mp4',
      sourceKey,
      language
    );
    let job = queue.teamJob(sourceKey);
    if (warnings.length || !job) throw new Error('UNSUPPORTED_MEDIA');
    let handoff = false;
    try {
      if (!(await queue.start([job.id]))) throw new Error('WRONG_STATE');
      input.pausable(paused => queue.setPaused(job!.id, paused) === 'ok');
      job = await waitForTerminal({
        read: () => queue.teamJob(sourceKey),
        signal: input.signal,
        cancel: () => queue.cancel(job!.id),
        terminal: value => isSettled(TRANSCRIPTION_LIFECYCLE, value.status),
        progress: value => input.onProgress(value.progress ?? 0)
      });
      if (input.signal.aborted || job.status === 'cancelled') throw new Error('PROCESS_CANCELED');
      if (job.status !== 'completed') throw new Error('PROCESS_FAILED');
      const document = await queue.document(job.id);
      let outputText =
        document?.segments.map(segment => segment.sourceText).join('\n') ?? job.text ?? '';
      let outputName = 'transcript.txt';
      if (validatedTargetLanguage) {
        const request = await queue.requestTranslation(job.id, validatedTargetLanguage);
        if (request.outcome === 'unavailable') throw new Error('AGENT_REQUIRED');
        if (request.outcome === 'invalid-language' || request.outcome === 'no-document') {
          throw new Error('INVALID_INPUT');
        }
        const translation =
          request.outcome === 'completed'
            ? request.translation
            : await waitForTeamTranslation(
                queue,
                job.id,
                validatedTargetLanguage,
                input.signal,
                progress => input.onProgress(70 + progress * 0.3)
              );
        outputText = translation.segments.map(segment => segment.translatedText).join('\n');
        outputName = 'translation.txt';
      }
      const outputPath = path.join(input.workspace, outputName);
      await writeFile(outputPath, outputText || '\n', { encoding: 'utf8', mode: 0o600 });
      const output = await stat(outputPath);
      handoff = true;
      return {
        file: outputPath,
        mimeType: 'text/plain',
        sizeBytes: output.size,
        cleanup: async () => {
          await queue.remove(job!.id);
        }
      };
    } finally {
      // The translation pass that may follow is not the same child and cannot be
      // held, so the offer is withdrawn with the transcription it belonged to.
      input.pausable(null);
      if (!handoff && job) await queue.remove(job.id);
    }
  };
}

async function waitForTeamTranslation(
  queue: TranscriptionQueue,
  jobId: string,
  targetLanguage: string,
  signal: AbortSignal,
  onProgress: (progress: number) => void
) {
  for (;;) {
    if (signal.aborted) throw new Error('PROCESS_CANCELED');
    const translation = await queue.translation(jobId, targetLanguage);
    if (!translation) throw new Error('WRONG_STATE');
    const total = Math.max(translation.totalCharacters ?? translation.totalSegments ?? 0, 1);
    const completed = translation.totalCharacters
      ? (translation.completedCharacters ?? 0)
      : (translation.completedSegments ?? 0);
    onProgress(Math.min(100, Math.round((completed / total) * 100)));
    if (translation.status === 'completed') return translation;
    if (translation.status === 'failed') throw new Error('PROCESS_FAILED');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, JOB_OBSERVE_INTERVAL_MS);
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('PROCESS_CANCELED'));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

function landingDelegate(optimizer: LandingOptimizer): TeamProcessDelegate {
  return async input => {
    const current = optimizer.state().settings;
    const settings = landingSettings(current, input.options);
    const jobId = await optimizer.prepareTeamZip(input.sourceFile, settings);
    let handoff = false;
    try {
      const started = optimizer.start([jobId]);
      const startGuard = started.then(ok => {
        if (!ok) throw new Error('WRONG_STATE');
        return new Promise<never>(() => undefined);
      });
      const job = await Promise.race([
        waitForTerminal({
          read: () => optimizer.teamJob(jobId),
          signal: input.signal,
          cancel: () => optimizer.cancel(jobId),
          terminal: value => isSettled(LANDING_JOB_LIFECYCLE, value.status),
          progress: value => input.onProgress(value.progress ?? 0)
        }),
        startGuard
      ]);
      if (input.signal.aborted) throw new Error('PROCESS_CANCELED');
      if (job.status !== 'completed' || !job.outputPath || !job.outputIsArchive) {
        throw new Error('PROCESS_FAILED');
      }
      const output = await stat(job.outputPath);
      if (!output.isFile() || output.size < 1) throw new Error('INVALID_RESPONSE');
      handoff = true;
      return {
        file: job.outputPath,
        mimeType: 'application/zip',
        sizeBytes: output.size,
        cleanup: async () => {
          await optimizer.remove(jobId);
        }
      };
    } finally {
      if (!handoff) await optimizer.remove(jobId);
    }
  };
}

function landingSettings(current: LandingSettings, value: unknown): LandingSettings {
  if (!record(value)) throw new Error('INVALID_INPUT');
  const allowed = new Set(['imageQuality', 'videoQuality', 'archive']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('INVALID_INPUT');
  const imageQuality = value.imageQuality ?? current.imageQuality;
  const videoQuality = value.videoQuality ?? current.videoQuality;
  if (
    !['optimal', 'high'].includes(String(imageQuality)) ||
    !['optimal', 'high'].includes(String(videoQuality)) ||
    (value.archive !== undefined && value.archive !== true)
  ) {
    throw new Error('INVALID_INPUT');
  }
  return {
    imageQuality: imageQuality as LandingSettings['imageQuality'],
    videoQuality: videoQuality as LandingSettings['videoQuality'],
    archive: true
  };
}

interface TerminalObserver<T> {
  read: () => T | null;
  signal: AbortSignal;
  cancel: () => boolean | Promise<boolean>;
  terminal: (value: T) => boolean;
  progress: (value: T) => void;
}

function waitForTerminal<T>(observer: TerminalObserver<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelDeadline: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (cancelDeadline) clearTimeout(cancelDeadline);
      observer.signal.removeEventListener('abort', abort);
      action();
    };
    const abort = () => {
      void Promise.resolve(observer.cancel()).catch(() => undefined);
      cancelDeadline = setTimeout(
        () => finish(() => reject(new Error('PROCESS_CANCELED'))),
        CANCEL_SETTLE_MS
      );
      cancelDeadline.unref();
    };
    const tick = () => {
      const value = observer.read();
      if (!value) {
        finish(() =>
          reject(new Error(observer.signal.aborted ? 'PROCESS_CANCELED' : 'WRONG_STATE'))
        );
        return;
      }
      observer.progress(value);
      if (observer.terminal(value)) {
        finish(() => resolve(value));
        return;
      }
      timer = setTimeout(tick, JOB_OBSERVE_INTERVAL_MS);
      timer.unref();
    };
    observer.signal.addEventListener('abort', abort, { once: true });
    if (observer.signal.aborted) abort();
    tick();
  });
}

/**
 * A wall-clock deadline that can be stopped and started again.
 *
 * The remaining time is what is left of the budget, not what is left of the
 * original timer: a pause holds the clock rather than resetting it, so a run
 * cannot buy itself an unlimited budget by pausing repeatedly.
 */
function pausableDeadline(
  totalMs: number,
  onExpiry: () => void
): { hold: () => void; resume: () => void; clear: () => void } {
  let remaining = totalMs;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    startedAt = Date.now();
    timer = setTimeout(onExpiry, Math.max(1, remaining));
    timer.unref();
  };
  arm();
  return {
    hold: () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(1, remaining - (Date.now() - startedAt));
    },
    resume: () => {
      if (timer) return;
      arm();
    },
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRequest(request: TeamProcessRequest) {
  if (
    !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.operationId) ||
    !/^[a-z][A-Za-z0-9_-]{0,63}$/u.test(request.toolId) ||
    typeof request.transferUrl !== 'string' ||
    typeof request.cloudBaseUrl !== 'string'
  ) {
    throw new Error('INVALID_INPUT');
  }
}

function validateDelegateResult(result: TeamProcessDelegateResult) {
  if (
    !result ||
    typeof result.file !== 'string' ||
    result.file.length < 1 ||
    typeof result.mimeType !== 'string' ||
    !/^[\w.+-]+\/[\w.+-]+$/u.test(result.mimeType) ||
    !Number.isSafeInteger(result.sizeBytes) ||
    result.sizeBytes < 1
  ) {
    throw new Error('INVALID_RESPONSE');
  }
}

function clampProgress(progress: number) {
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
}

function positiveWatchdog(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('INVALID_INPUT');
  return value;
}

function abortCode(signal: AbortSignal) {
  return signal.reason instanceof Error && signal.reason.message === 'PROCESS_TIMEOUT'
    ? 'PROCESS_TIMEOUT'
    : 'PROCESS_CANCELED';
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(message) ? message : 'PROCESS_FAILED';
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
}
