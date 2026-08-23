import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MEDIA_ACTION_LIFECYCLE, type MediaActionStatus } from '@video-compressor/shared';
import { nextConvertedImagePath } from '../files/paths.js';
import { activeGovernorOrNull } from '../power/spawn.js';
import { decideTransition } from '../queue/transitions.js';
import {
  IMAGE_CONVERSION_EXTENSIONS,
  ImageConversionError,
  convertImage,
  sourceAlreadyUsesFormat,
  type ImageConversionFormat
} from './image-converter.js';

export type { MediaActionStatus };

/**
 * The one place a conversion's status changes.
 *
 * Wired late, and the reconciliation is how that showed: every other tool's transitions were
 * being recorded and checked while this one's were invisible, so the lifecycle declared six
 * edges that nothing could be shown to take. A tool the declaration does not reach is a tool
 * the interface cannot gate an action on.
 */
function transitionAction(job: ImageConversionJob, next: MediaActionStatus): boolean {
  if (!decideTransition(MEDIA_ACTION_LIFECYCLE, job.status, next)) return false;
  job.status = next;
  return true;
}

export interface ImageConversionJob {
  id: string;
  kind: 'image-conversion';
  inputPath: string;
  outputPath: string | null;
  targetFormat: ImageConversionFormat;
  status: MediaActionStatus;
  errorCode: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MediaActionState {
  running: boolean;
  jobs: ImageConversionJob[];
}

type Notify = () => void;
type ImageConverter = typeof convertImage;

/**
 * How long a quit waits for the conversions already queued to finish.
 *
 * Long enough that an ordinary Finder selection lands — a single image is a
 * fraction of a second — and short enough that quitting still means quitting.
 * Scaled by the resource limit like every other wall-clock budget covering
 * managed work: at a reduced limit the encoder is duty-cycled and needs
 * proportionally longer to reach the same point.
 */
const SHUTDOWN_DRAIN_MS = 15_000;

/**
 * How long `cancel` waits for a conversion to actually stop before returning.
 *
 * A stop must never be able to block the caller indefinitely. The abort has already been
 * delivered and the managed spawn escalates on its own, so waiting past this buys nothing —
 * and A3 is precisely the case where it costs everything: a Finder-initiated conversion has
 * no window of its own, so a stop that hangs leaves the machine working with nothing on
 * screen to explain why. Scaled like every other wall-clock budget over managed work.
 */
const CANCEL_DEADLINE_MS = 10_000;

/** A wall-clock budget stretched to match the resource limit in force. */
function scaledTimeout(milliseconds: number): number {
  return activeGovernorOrNull()?.scaleTimeout(milliseconds) ?? milliseconds;
}

export class MediaActionQueue {
  private jobs: ImageConversionJob[] = [];
  private pumpPromise: Promise<void> | null = null;
  private stopping = false;
  /** Set once the shutdown drain has run out of time; the pump then stops. */
  private abandoning = false;
  /** Aborts the conversion running right now; null between jobs. */
  private activeConversion: AbortController | null = null;
  /** Which job `activeConversion` belongs to, so a stop cannot abort the wrong one. */
  private activeJobId: string | null = null;
  /**
   * Jobs the user asked to stop.
   *
   * Needed because aborting makes the converter throw, and a throw is otherwise recorded as
   * `failed` — telling the user their conversion broke when in fact they stopped it.
   */
  private readonly cancelling = new Set<string>();
  /** Resolved when a job reaches a terminal state, so `cancel` can wait without polling. */
  private readonly settleWaiters = new Map<string, Array<() => void>>();
  private additionsInFlight = 0;
  private additionsDrained: Array<() => void> = [];

  constructor(
    private readonly notify: Notify = () => {},
    private readonly imageConverter: ImageConverter = convertImage
  ) {}

  state(): MediaActionState {
    return {
      running: this.workActive(),
      jobs: this.jobs.map(job => ({ ...job }))
    };
  }

  workActive() {
    return (
      this.additionsInFlight > 0 ||
      Boolean(this.pumpPromise) ||
      this.jobs.some(job => job.status === 'queued')
    );
  }

  async addImageConversions(paths: string[], targetFormat: ImageConversionFormat) {
    if (this.stopping) {
      throw new ImageConversionError('QUEUE_STOPPING', 'Soty is shutting down.');
    }
    this.additionsInFlight += 1;
    try {
      const accepted: ImageConversionJob[] = [];
      for (const input of paths) {
        const inputPath = path.resolve(input);
        const now = Date.now();
        const job: ImageConversionJob = {
          id: randomUUID(),
          kind: 'image-conversion',
          inputPath,
          outputPath: null,
          targetFormat,
          status: 'queued',
          errorCode: null,
          error: null,
          createdAt: now,
          startedAt: null,
          finishedAt: null
        };
        if (sourceAlreadyUsesFormat(inputPath, targetFormat)) {
          transitionAction(job, 'skipped');
          job.errorCode = 'ALREADY_TARGET_FORMAT';
          job.error = 'The image already uses the selected format.';
          job.finishedAt = now;
        } else {
          job.outputPath = await this.nextPath(job);
        }
        this.jobs.push(job);
        accepted.push({ ...job });
      }
      this.trimHistory();
      this.notify();
      this.schedule();
      return accepted;
    } finally {
      this.additionsInFlight -= 1;
      if (this.additionsInFlight === 0) {
        for (const resolve of this.additionsDrained.splice(0)) resolve();
      }
    }
  }

  /**
   * Finishes the Finder action already in hand, then leaves — but never waits
   * forever to do it.
   *
   * Draining is deliberate: a conversion is started from the Finder context
   * menu, often with no Soty window on screen at all, so dropping the queue on
   * quit would discard work the user asked for and give them nowhere to see
   * that it had happened. Each image is bounded work and the queue is one
   * selection deep.
   *
   * What was missing is the other half. Nothing signalled the running encoder,
   * so a single FFmpeg wedged on a malformed image held the agent open for as
   * long as it lasted; the launcher's own patience runs out first, and a
   * SIGKILLed agent leaves that encoder orphaned — still converting, no longer
   * attached to anything that could report or stop it. Which is precisely the
   * failure the user sees as a machine that stays hot after the app is gone.
   *
   * So the drain gets a deadline. Past it the encoder is signalled, the pump
   * stops taking new jobs, and the agent exits on its own terms.
   */
  async shutdown() {
    this.stopping = true;
    if (this.additionsInFlight > 0) {
      await new Promise<void>(resolve => this.additionsDrained.push(resolve));
    }
    this.schedule(true);
    const pump = this.pumpPromise;
    if (!pump) return;
    const deadline = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, scaledTimeout(SHUTDOWN_DRAIN_MS));
      // A shutdown must never be held open by its own deadline.
      timer.unref();
    });
    await Promise.race([pump, deadline]);
    if (!this.pumpPromise) return;
    // Out of time: stop the queue where it stands. `abandoning` keeps the pump
    // from picking up the next job, and the abort reaches the encoder itself —
    // the part that is actually holding the machine.
    this.abandoning = true;
    this.activeConversion?.abort();
    await this.pumpPromise;
  }

  /**
   * Stop one conversion (FR-005).
   *
   * Resolves true only when the job really ended up cancelled. A conversion that finished
   * in the moment between the ask and the abort is reported as what it is — completed —
   * rather than as a stop that did not happen.
   */
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) return false;

    if (job.status === 'queued') {
      transitionAction(job, 'cancelled');
      job.finishedAt = Date.now();
      this.notify();
      return true;
    }
    if (job.status !== 'processing') return false;

    this.cancelling.add(id);
    // Only if it is still this job's conversion. Between reading the status and getting
    // here the pump may have moved on, and aborting the next job would stop work the user
    // never asked to stop.
    if (this.activeJobId === id) this.activeConversion?.abort();
    await this.awaitSettled(id);
    this.cancelling.delete(id);
    // Re-read rather than reusing the reference above: the pump mutates the status while
    // this waits, and the narrowing from the guard is stale by the time it resolves.
    return this.jobs.find(candidate => candidate.id === id)?.status === 'cancelled';
  }

  /** Stop everything, and report how many runs that was (FR-007). */
  async cancelAll(): Promise<number> {
    const stoppable = this.jobs
      .filter(job => job.status === 'queued' || job.status === 'processing')
      .map(job => job.id);
    // Sequential, not concurrent: only one conversion runs at a time, so the queued ones
    // resolve immediately and the single running one is the only thing anybody waits for.
    let stopped = 0;
    for (const id of stoppable) if (await this.cancel(id)) stopped += 1;
    return stopped;
  }

  /** Waits for a job to reach a terminal state, or for the deadline — whichever is first. */
  private awaitSettled(id: string): Promise<void> {
    return new Promise<void>(resolve => {
      const waiters = this.settleWaiters.get(id) ?? [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, scaledTimeout(CANCEL_DEADLINE_MS));
      // A stop must never hold the process open on its own deadline.
      timer.unref();
      waiters.push(finish);
      this.settleWaiters.set(id, waiters);
    });
  }

  private releaseSettled(id: string) {
    for (const waiter of this.settleWaiters.get(id) ?? []) waiter();
    this.settleWaiters.delete(id);
  }

  private schedule(allowWhileStopping = false) {
    if (
      this.pumpPromise ||
      (this.stopping && !allowWhileStopping) ||
      this.abandoning ||
      !this.jobs.some(job => job.status === 'queued')
    )
      return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      this.notify();
      if (!this.stopping) this.schedule();
    });
  }

  private async pump() {
    while (true) {
      // Checked at the top of every iteration, not only at the start: the
      // deadline expires while a conversion is already running, and the whole
      // point is that the queue behind it never gets picked up.
      if (this.abandoning) return;
      const job = this.jobs.find(candidate => candidate.status === 'queued');
      if (!job) return;
      // Asked to stop while it was still waiting its turn. Starting it anyway would be the
      // same bug as spawning after a cancel between two stages.
      if (this.cancelling.has(job.id)) {
        transitionAction(job, 'cancelled');
        job.finishedAt = Date.now();
        this.releaseSettled(job.id);
        this.notify();
        continue;
      }
      transitionAction(job, 'processing');
      job.startedAt = Date.now();
      this.notify();
      try {
        await this.process(job);
        transitionAction(job, 'completed');
      } catch (error) {
        // A cancel reaches the converter as an abort, and an abort surfaces as a throw. Read
        // as failure it would tell the user their conversion broke, when what happened is
        // that they stopped it.
        if (this.cancelling.has(job.id)) {
          transitionAction(job, 'cancelled');
        } else {
          transitionAction(job, 'failed');
          job.errorCode =
            error instanceof ImageConversionError ? error.code : 'IMAGE_CONVERSION_FAILED';
          job.error = error instanceof Error ? error.message : 'The image could not be converted.';
        }
      } finally {
        job.finishedAt = Date.now();
        this.releaseSettled(job.id);
        this.notify();
      }
    }
  }

  private async process(job: ImageConversionJob) {
    const conversion = new AbortController();
    this.activeConversion = conversion;
    this.activeJobId = job.id;
    // An abandon that arrived while this job was being picked up must not be
    // outrun by it.
    if (this.abandoning) conversion.abort();
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        job.outputPath ??= await this.nextPath(job);
        try {
          await this.imageConverter(
            job.inputPath,
            job.outputPath,
            job.targetFormat,
            conversion.signal
          );
          return;
        } catch (error) {
          if (!(error instanceof ImageConversionError) || error.code !== 'OUTPUT_EXISTS') {
            throw error;
          }
          job.outputPath = await this.nextPath(job);
        }
      }
    } finally {
      if (this.activeConversion === conversion) {
        this.activeConversion = null;
        this.activeJobId = null;
      }
    }
    throw new ImageConversionError(
      'OUTPUT_COLLISION',
      'Soty could not reserve a unique output name.'
    );
  }

  private nextPath(current: ImageConversionJob) {
    const reserved = this.jobs
      .filter(job => job !== current && job.outputPath)
      .map(job => job.outputPath as string);
    return nextConvertedImagePath(
      current.inputPath,
      IMAGE_CONVERSION_EXTENSIONS[current.targetFormat],
      reserved
    );
  }

  private trimHistory() {
    const active = this.jobs.filter(job => job.status === 'queued' || job.status === 'processing');
    const terminal = this.jobs
      .filter(job => job.status !== 'queued' && job.status !== 'processing')
      .slice(-100);
    this.jobs = [...terminal, ...active];
  }
}
