import { randomUUID } from 'node:crypto';
import { access, mkdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  activeEmbeddingImages,
  clampCrf,
  clampFrameRate,
  clampResolutionLimit,
  clampVideoBitrateKbps,
  draftImageEmbedding,
  encodingFromSettings,
  imageEmbeddingKey,
  jobConfigurationKey,
  COMPRESSION_LIFECYCLE,
  canTransition,
  isSettled,
  type AgentEventType,
  type AgentSettings,
  type CompressionJob,
  type ImageAsset,
  type ImageSlot,
  type JobStatus,
  type MediaActionState,
  type QueueBatch,
  type QueueState,
  type SelectionWarning,
  type SourceKind
} from '@video-compressor/shared';
import { encodeVideo, isAudioCopyFailure, type EncodeEmbeddingOptions } from '../ffmpeg/encoder.js';
import { heldFinalImageSeconds } from '../ffmpeg/presets.js';
import {
  isMediaToolUnavailableError,
  MediaToolUnavailableError,
  probeMedia,
  type MediaInfo,
  type MediaToolName
} from '../ffmpeg/tools.js';
import { fileSize, nextOutputPath } from '../files/paths.js';
import {
  freezeImageEmbedding,
  outputDimensions,
  outputDurationSeconds,
  outputFrameRate,
  refreshEstimateFromBreakdown,
  sourceDurationSeconds
} from '../images/embedding.js';
import { ImageAssetError, ImageAssetStore } from '../images/store.js';
import { detectStaticEdgeTrims } from '../images/static-edges.js';
import type { ManagedSpawnGovernor } from '../power/spawn.js';
/**
 * Suspension is NOT done here any more. The governor owns it, because it also
 * duty-cycles managed children to hold the power limit — two independent
 * suspenders would fight over the same process, and whichever resumed last
 * would silently discard the other's intent.
 */

/**
 * What the queue needs from the shared resource budget. Structural so the queue
 * does not depend on the power module's concrete class — and so a bare test
 * assembly can omit it entirely.
 */
export interface QueuePowerGovernor extends ManagedSpawnGovernor {
  hold(child: ChildProcessWithoutNullStreams, reason: string): () => void;
  /** Whether the child is stopped right now — a hold can fail to land. */
  isSuspended(child: ChildProcessWithoutNullStreams): boolean;
  resumeForTermination(child: ChildProcessWithoutNullStreams): void;
  throttlingSupported(): boolean;
  scaleTimeout(milliseconds: number): number;
}
import { selectionWarning } from './shared.js';
import { decideTransition } from './transitions.js';

/**
 * How often the drain watchdog looks for a stranded batch. Slow on purpose:
 * this is a safety net for a loop that should never be dropped, not the
 * mechanism that drives it.
 */
const DRAIN_WATCHDOG_MS = 2_000;

/**
 * The floor between progress broadcasts.
 *
 * FFmpeg reports several times a second and each report was a full state
 * broadcast. Four a second is smoother than any progress bar needs to look, and
 * an order of magnitude less work than what the encoder emits.
 */
const PROGRESS_BROADCAST_MS = 250;
import { defaultSettings } from './store.js';

type EstimatorHooks = {
  schedule: () => void;
  invalidate: () => void;
  resume: () => void;
  runPrioritized?: () => Promise<boolean>;
  cancelPrioritized?: (id: string) => void;
};

/**
 * What the compressor is doing, as one value.
 *
 * The queue has kept this in five independent booleans and handles — `compressionInFlight`,
 * `prioritizingEstimates`, `compressionPausedForEstimates`, `activeAbort`, `active` — and
 * every wedged-queue defence in this file exists because of that (A4). Five flags describe
 * thirty-two states, of which four are real; the other twenty-eight are the ones the
 * watchdog, the drain check and the in-flight-flag-first ordering all exist to survive.
 *
 * Two things follow from making it one value rather than five. `release` living **only** in
 * `encoding-held` turns "a hold is always released by its taker" into something the compiler
 * checks rather than something a guard remembers, which is A5. And `jobId` gives the
 * shutdown path the identity it needs to remove the partial output it currently leaves
 * behind, which is half of A2.
 *
 * Private, and never on the wire: `QueueState.running` keeps exactly the shape it had.
 */
type CompressorActivity =
  | { kind: 'idle' }
  | { kind: 'estimating' }
  | {
      kind: 'encoding';
      jobId: string;
      abort: AbortController;
      child: ChildProcessWithoutNullStreams | null;
      /**
       * Estimates running **alongside** this encode rather than instead of it.
       *
       * A platform that cannot suspend a process — or a queue with no governor attached —
       * falls through the handoff and runs prioritised estimates next to the encode. That is
       * a second concurrent activity, so a strictly one-at-a-time union cannot describe it,
       * and dropping it would have silently changed behaviour on exactly the platform the
       * handoff was written to accommodate.
       */
      estimating: boolean;
    }
  | {
      kind: 'encoding-held';
      jobId: string;
      abort: AbortController;
      /** Non-null by construction: a hold cannot exist without a child to hold. */
      child: ChildProcessWithoutNullStreams;
      /**
       * Present **only** here, which is what closes A5: the token that releases the hold
       * lives in the same value as the hold itself, so it cannot be overwritten by the next
       * holder without having been called. Not a guard to remember — a shape.
       */
      release: () => void;
    };

type RuntimeRecoveryPhase = 'input-analysis' | 'encoding' | 'output-validation';
export type QueueMediaRuntime = { probeMedia: typeof probeMedia };

const defaultMediaRuntime: QueueMediaRuntime = { probeMedia };
/**
 * Stable codes, not sentences.
 *
 * These reached the interface as English prose and were translated by matching
 * that prose with a regular expression — so rewording a message in the agent
 * silently untranslated it in the browser, and neither side had any way to
 * notice. The disk warnings were worse: they interpolated the output folder, so
 * a user's full directory path travelled in a string that ends up in toasts and
 * screenshots (FR-029/FR-029a).
 */
const RUNTIME_WARNING = 'MEDIA_TOOLS_UNAVAILABLE';
const RUNTIME_JOB_ERROR = 'MEDIA_TOOLS_UNAVAILABLE_JOB';

export interface AddSourceOptions {
  sourceKind?: SourceKind;
  sourceKey?: string | null;
  fileName?: string;
  /** Per-operation settings isolated from the interactive queue defaults. */
  settings?: AgentSettings;
}

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
  '.avi',
  '.mpg',
  '.mpeg',
  '.mts',
  '.m2ts'
]);

export function isSupportedVideoPath(filePath: string) {
  return SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** What a finished run produced, kept while a repeat of it is in flight. */
interface PreviousResult {
  outputPath: string;
  finalSize: number;
  finalWidth: number | null;
  finalHeight: number | null;
  finalFrameRate: number | null;
  finalBitrate: number | null;
  finalDurationSeconds: number | null;
  finalCodec: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  estimateStatus: CompressionJob['estimateStatus'];
  estimatedOutputBytes: number | null;
  estimatedSavingPercent: number | null;
  estimateKey: string | null;
}

export class JobQueue {
  // Aborts background media work for the current job (static-edge detection in
  // `preparing-images`) whose ffmpeg children are not the tracked `active`
  // encoder, so cancel/shutdown can actually stop them.
  /**
   * The stored activity. Five fields collapsed into the one value they always described.
   *
   * The five names below survive as read-only views so the rest of the file — and the tests
   * that cross-check them — keep working through the change. They are deleted next; until
   * then, an assignment to one of them is a compile error, which is how every write site was
   * found rather than remembered.
   */
  private current: CompressorActivity = { kind: 'idle' };
  /** Governor holds taken by a user pause, by job id. */
  private readonly pauseHolds = new Map<string, () => void>();
  /**
   * Encoders that have been told to stop and have not finished doing so.
   *
   * Freeing the queue slot the moment a stop is signalled (FR-004) means the next job starts
   * while the stopped one is still unwinding — which is the whole point, and which also
   * means the queue no longer holds a reference to it. Kept here so a quit still waits for
   * them: an agent that exited during that window would leave a child with nothing left to
   * escalate its termination, and a child that ignores SIGTERM would simply carry on.
   */
  private readonly terminating = new Set<ChildProcessWithoutNullStreams>();
  /** Null on an agent whose platform does not offer the file-manager bridge. */
  private readMediaActions: (() => MediaActionState) | null = null;
  /**
   * Serialises `start`, so two requests can never both pass its guard.
   *
   * `start` checks whether the queue is already running and then **awaits** — the disk
   * warning, then one output-path resolution per job. Every one of those is a turn of the
   * event loop in which a second request runs the same check against the same "not running"
   * answer, and both go on to build a batch. The second overwrites `this.batch`, so the
   * first batch's jobs are queued against a batch nothing will ever drain.
   *
   * A double-click produces exactly that, which is why the fix is not "check again after the
   * awaits": the two would still interleave. The gate makes the whole of `start` atomic with
   * respect to itself.
   */
  private startGate: Promise<void> = Promise.resolve();
  private drainWatchdog: NodeJS.Timeout | null = null;
  private nextEstimatePriorityOrder = 1;
  private warning: string | null = null;
  private estimateHooks: EstimatorHooks | null = null;
  private runtimeRecovery: ((error: MediaToolUnavailableError) => void) | null = null;
  private updateState: NonNullable<QueueState['update']> = {
    state: 'none',
    targetBuildId: null
  };
  private imagePool: Record<ImageSlot, string[]> = { start: [], end: [] };
  private knownPoolImages: Record<ImageSlot, Set<string>> = {
    start: new Set(),
    end: new Set()
  };
  private teamJobSettings = new Map<string, AgentSettings>();
  private power: QueuePowerGovernor | null = null;
  /** Releases the estimate-priority hold; null when nothing is held. */

  /**
   * Bumped once per broadcast, by the wrapper below and nowhere else.
   *
   * Wrapping `notify` rather than incrementing at each call site is the whole
   * design: there are thirty-odd of them, a new one is added regularly, and the
   * one somebody forgets would be an event that quietly cannot win against the
   * snapshot it should replace.
   */
  private revision = 0;
  private lastProgressBroadcast = 0;
  private progressTrailing: ReturnType<typeof setTimeout> | null = null;
  /** Every broadcast goes through here, so the revision cannot be missed. */
  private readonly notify: (event?: AgentEventType) => void;

  constructor(
    private tools: QueueState['tools'],
    private notifyRaw: (event?: AgentEventType) => void,
    private jobs: CompressionJob[] = [],
    private settings: AgentSettings = defaultSettings,
    private batch: QueueBatch | null = null,
    private imageStore = new ImageAssetStore(),
    private random = Math.random,
    private mediaRuntime: QueueMediaRuntime = defaultMediaRuntime
  ) {
    this.notify = (event?: AgentEventType) => {
      this.revision += 1;
      this.notifyRaw(event);
    };
    this.nextEstimatePriorityOrder =
      Math.max(0, ...jobs.map(job => job.estimatePriorityOrder ?? 0)) + 1;
    // A batch restored from disk is the case the watchdog exists for: the agent
    // died mid-drain, so nothing is in flight and nothing will call `start()`.
    if (this.batch && !this.batch.finishedAt) this.startDrainWatchdog();
  }

  attachEstimator(hooks: EstimatorHooks) {
    this.estimateHooks = hooks;
  }

  /**
   * Hands the queue the shared resource budget.
   *
   * The queue no longer suspends the active encode itself. Suspension has one
   * owner — the governor — because it also duty-cycles managed children to hold
   * the power limit; two independent suspenders would fight, and the cycler's
   * next on-window would resume a process this queue deliberately stopped.
   * Optional so tests that assemble a bare queue keep working: without a
   * governor the prioritization simply runs alongside the encode, exactly as it
   * does today on a platform that cannot pause.
   */
  attachPowerGovernor(governor: QueuePowerGovernor) {
    this.power = governor;
  }

  /**
   * The five fields, read as the one value they were always describing.
   *
   * **Derived, not stored — for now.** This is the shadow half of the collapse: every
   * consumer moves onto this getter first, tests assert it agrees with the fields at every
   * broadcast, and only then is the representation inverted. Doing it the other way round
   * would put the estimate-priority handoff — the subtlest concurrency in the agent — on an
   * un-cross-checked representation from the first commit.
   *
   * `jobId` and `abort` are nullable here and will not be once the value is stored: a
   * derived view cannot promise more than the fields it derives from, and the point of the
   * inversion is that the three are created together or not at all.
   */
  /** The finished result of a job that is being repeated, restored on cancel. */
  private previousResults = new Map<string, PreviousResult | null>();

  private get activity(): CompressorActivity {
    return this.current;
  }

  /**
   * A progress-only broadcast, rate-limited.
   *
   * FFmpeg reports progress several times a second, and each report was a full
   * state broadcast: the whole queue serialised, pushed over the event stream,
   * parsed by every open tab and reconciled against what it already had — to
   * move one number that the interface renders as a whole percent anyway.
   *
   * Status changes do not come through here. They keep the immediate path,
   * because "this job just failed" arriving a quarter-second late is a
   * different kind of wrong from a progress bar updating four times a second
   * instead of twenty.
   */
  private notifyProgress(): void {
    const at = Date.now();
    if (at - this.lastProgressBroadcast < PROGRESS_BROADCAST_MS) {
      // Coalesced rather than dropped: the last value in a quiet period still
      // has to arrive, or a bar sticks at 97% until something else happens.
      if (!this.progressTrailing) {
        this.progressTrailing = setTimeout(() => {
          this.progressTrailing = null;
          this.lastProgressBroadcast = Date.now();
          this.notify();
        }, PROGRESS_BROADCAST_MS);
        this.progressTrailing.unref?.();
      }
      return;
    }
    this.lastProgressBroadcast = at;
    this.notify();
  }

  /**
   * The one place the activity is set, so the safety net cannot be forgotten.
   *
   * The watchdog used to be armed inside `start()` alone. That is the one path
   * a stuck queue cannot take — the button is disabled by the very state the
   * watchdog exists to clear — so the net was absent exactly when it was
   * needed. Arming it here means becoming busy is what starts the thing that
   * can un-stick it, whichever route made it busy.
   */
  private setActivity(next: CompressorActivity): void {
    const previous = this.current;
    this.current = next;
    /*
     * A pause is a hold on one particular child, so it has to follow the child.
     *
     * Two things end it: the encode being over (done, cancelled, replaced),
     * where a surviving hold would promise to resume a process that no longer
     * exists; and the same job moving to its next child — a held final image is
     * built in three passes, and a pause taken during the first would otherwise
     * lift itself the moment the second started.
     */
    if (previous.kind === 'encoding' && this.pauseHolds.has(previous.jobId)) {
      const sameJob = next.kind === 'encoding' && next.jobId === previous.jobId;
      const nextChild = next.kind === 'encoding' ? next.child : null;
      if (!sameJob) this.releasePauseHold(previous.jobId);
      else if (nextChild !== previous.child) {
        this.releasePauseHold(previous.jobId);
        this.takePauseHold(previous.jobId, nextChild ?? null);
      }
    }
    if (next.kind !== 'idle') this.startDrainWatchdog();
  }

  /** Suspends one encode's child through the governor, remembering the release. */
  private takePauseHold(jobId: string, child: ChildProcessWithoutNullStreams | null): boolean {
    if (!child || child.pid === undefined || !this.power) return false;
    this.pauseHolds.set(jobId, this.power.hold(child, 'compressor:paused'));
    return true;
  }

  private releasePauseHold(jobId: string): void {
    const release = this.pauseHolds.get(jobId);
    if (!release) return;
    this.pauseHolds.delete(jobId);
    release();
  }

  /**
   * Can this job be stopped right now?
   *
   * Asked of the shared table rather than matched against a list of status names. The lists
   * this replaces existed in both processes and had already drifted: the interface decided
   * which rows offered a Stop button from its own copy, and nothing made the two agree.
   */
  private stoppable(job: CompressionJob): boolean {
    return canTransition(COMPRESSION_LIFECYCLE, job.status, 'cancelled');
  }

  /** Has this job finished, whatever the outcome? */
  private finished(job: CompressionJob): boolean {
    return isSettled(COMPRESSION_LIFECYCLE, job.status);
  }

  /**
   * The one place a job's status changes.
   *
   * Fifteen sites wrote `job.status` directly, and between them they were the complete —
   * undeclared, unenumerable — definition of what a compression may do next. The interface
   * then re-derived the same rules from status literals of its own. One method consulting
   * one shared table replaces both.
   *
   * Returns whether the change was applied. A refusal **leaves the job exactly as it was**
   * and answers false — it never throws and never half-applies; routes map false to
   * `409 TRANSITION_NOT_ALLOWED`. The mechanism shipped permissive and was switched to
   * strict only after a full suite run reconciled the tables against the edges the code
   * actually takes; see `apps/agent/src/queue/transitions.ts`.
   */
  private transition(job: CompressionJob, next: JobStatus): boolean {
    if (!decideTransition(COMPRESSION_LIFECYCLE, job.status, next)) return false;
    job.status = next;
    return true;
  }

  /**
   * Asks the governor to hold the encode while prioritized estimates run, and
   * reports whether the encode is actually stopped now.
   *
   * The answer must come from the governor, not from the fact that one is
   * attached: a hold can fail to land — the process is already gone, or the
   * Windows helper could not start — and a caller that assumed success would
   * run estimates alongside a still-running encode while believing it had the
   * machine to itself. The hold is dropped again when it did not take, so
   * nothing is left holding a child down for a handoff that was abandoned.
   */
  private holdForEstimates(child: ChildProcessWithoutNullStreams): boolean {
    if (!this.power) return false;
    const release = this.power.hold(child, 'estimate-priority');
    if (!this.power.isSuspended(child)) {
      release();
      return false;
    }
    // Held *is* the activity now, so taking the hold and recording it are one write. There
    // is no window in which a hold exists with nowhere to record its token — which is A5.
    if (this.current.kind !== 'encoding') {
      release();
      return false;
    }
    this.setActivity({
      kind: 'encoding-held',
      jobId: this.current.jobId,
      abort: this.current.abort,
      child,
      release
    });
    return true;
  }

  private releaseEstimateHold() {
    if (this.current.kind !== 'encoding-held') return;
    const { jobId, abort, child, release } = this.current;
    // Step out of the held variant before calling, so a throwing release cannot leave the
    // queue claiming a hold it no longer owns.
    this.setActivity({ kind: 'encoding', jobId, abort, child, estimating: true });
    release();
  }

  private pauseSupported(): boolean {
    return this.power?.throttlingSupported() ?? false;
  }

  attachRuntimeRecovery(handler: (error: MediaToolUnavailableError) => void) {
    this.runtimeRecovery = handler;
  }

  setToolAvailability(next: QueueState['tools']) {
    const changed = this.tools.ffmpeg !== next.ffmpeg || this.tools.ffprobe !== next.ffprobe;
    const becameAvailable =
      next.ffmpeg && next.ffprobe && (!this.tools.ffmpeg || !this.tools.ffprobe);
    this.tools.ffmpeg = next.ffmpeg;
    this.tools.ffprobe = next.ffprobe;
    if (next.ffmpeg && next.ffprobe && this.warning === RUNTIME_WARNING) this.warning = null;
    if (changed) this.notify();
    // A transient tool outage can make `pump` bail while a batch still has
    // queued jobs; once the tools return, resume draining it so those jobs do
    // not stay wedged as "running" until the agent restarts.
    if (becameAvailable && this.activity.kind === 'idle') queueMicrotask(() => void this.pump());
  }

  /**
   * Where the file-manager conversions are read from, when this agent offers them.
   *
   * Set here rather than composed at the broadcast because every one of the compressor's
   * REST replies is a whole `QueueState` too: a reply that omitted the conversions would
   * blank the list the stream had just filled, every time anything else was clicked.
   */
  setMediaActionSource(read: () => MediaActionState) {
    this.readMediaActions = read;
  }

  state(): QueueState {
    return {
      jobs: this.jobs.filter(job => !this.teamJobSettings.has(job.id)).map(job => cloneJob(job)),
      running: this.running(),
      tools: this.tools,
      settings: cloneSettings(this.settings),
      batch: this.batch ? { ...this.batch, jobIds: [...this.batch.jobIds] } : null,
      warning: this.warning,
      update: this.updateStatus(),
      revision: this.revision,
      ...(this.readMediaActions ? { mediaActions: this.readMediaActions() } : {})
    };
  }

  /**
   * The three cheap reads `state()` is otherwise asked for.
   *
   * `state()` clones every job. The health endpoints want only the update
   * status, the diagnostics endpoint only the last warning, and callers like
   * `workActive()` only a boolean — and `/health` is polled once a second by
   * the launcher, so cloning a two-hundred-file queue to answer any of them is
   * pure waste.
   */
  running(): boolean {
    // An activity naming a job that is gone, or finished, is not activity. It
    // used to be reported as busy anyway, which is how the interface came to
    // show a greyed-out Compress button above a panel of zeroes with no way
    // back. Cleared on read, so the correction reaches every caller at once
    // rather than waiting for the next watchdog tick.
    if (this.clearStrandedActivity()) queueMicrotask(() => this.notify());
    return this.activity.kind !== 'idle' || this.queuedInBatch();
  }

  updateStatus(): NonNullable<QueueState['update']> {
    return { ...this.updateState };
  }

  warningMessage(): string | null {
    return this.warning;
  }

  /**
   * Why the queue thinks it is busy, in a form somebody can read over support.
   *
   * A user reported the Compress button greyed out as "already running" above a
   * panel showing nothing queued, nothing processing and nothing done. Working
   * out how those two could disagree took an hour of reading source, because
   * the diagnostics page carried the version and the FFmpeg status and nothing
   * about the queue at all. Everything needed to answer that question in a
   * glance is here.
   */
  liveness() {
    const byStatus: Record<string, number> = {};
    for (const job of this.jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    const activity = this.activity;
    return {
      running: this.running(),
      activity: activity.kind,
      /** The job the activity claims to be about; null when it names none. */
      activityJobId: 'jobId' in activity ? (activity.jobId ?? null) : null,
      /** Whether that job still exists and is still unfinished. */
      activityJobLive:
        'jobId' in activity && activity.jobId
          ? this.jobs.some(
              job => job.id === activity.jobId && !isSettled(COMPRESSION_LIFECYCLE, job.status)
            )
          : null,
      jobs: this.jobs.length,
      byStatus,
      batchId: this.batch?.id ?? null,
      batchFinished: this.batch ? this.batch.finishedAt !== null : null,
      queuedInBatch: this.queuedInBatch(),
      watchdogArmed: this.drainWatchdog !== null
    };
  }

  compressionActive() {
    // `encoding-held` is deliberately not active: the encode exists but the governor has it
    // stopped so prioritised estimates can have the machine. Held and encoding are now two
    // values rather than two flags, so this is the whole condition — the extra term the
    // five-field version needed existed only to cover the window where they disagreed.
    return this.activity.kind === 'encoding';
  }

  workActive() {
    return this.running();
  }

  acceptingNewTasks() {
    return this.updateState.state === 'none';
  }

  requestUpdateDrain(targetBuildId: string) {
    if (!targetBuildId || targetBuildId === this.updateState.targetBuildId) return;
    this.updateState = {
      state: this.workActive() ? 'draining' : 'pending',
      targetBuildId
    };
    this.notify();
  }

  persisted() {
    const durableJobs = this.jobs.filter(job => !this.teamJobSettings.has(job.id));
    return {
      jobs: durableJobs.map(job => cloneJob(job)),
      settings: cloneSettings(this.settings),
      batch: this.batch
        ? {
            ...this.batch,
            jobIds: this.batch.jobIds.filter(id => !this.teamJobSettings.has(id))
          }
        : null
    };
  }

  teamJob(sourceKey: string): CompressionJob | null {
    const job = this.jobs.find(candidate => candidate.sourceKey === sourceKey);
    return job && this.teamJobSettings.has(job.id) ? cloneJob(job) : null;
  }

  async updateSettings(next: Partial<AgentSettings>) {
    const normalized: Partial<AgentSettings> = { ...next };
    if (next.frameRate !== undefined && next.frameRate !== null) {
      normalized.frameRate = clampFrameRate(next.frameRate);
    }
    if (next.crf !== undefined) normalized.crf = clampCrf(next.crf);
    if (next.videoBitrateKbps !== undefined) {
      normalized.videoBitrateKbps = clampVideoBitrateKbps(next.videoBitrateKbps);
    }
    if (next.resolutionLimit !== undefined && next.resolutionLimit !== null) {
      normalized.resolutionLimit = clampResolutionLimit(next.resolutionLimit);
    }
    if (next.imageEmbedding !== undefined) {
      normalized.imageEmbedding = cloneImageEmbeddingSettings(next.imageEmbedding);
    }

    const encodingChanged = (
      [
        'mode',
        'stripMetadata',
        'frameRate',
        'resolutionLimit',
        'rateControl',
        'crf',
        'videoBitrateKbps'
      ] as const
    ).some(key => normalized[key] !== undefined && normalized[key] !== this.settings[key]);
    const imageSettingsChanged =
      normalized.imageEmbedding !== undefined &&
      imageEmbeddingSettingsKey(normalized.imageEmbedding) !==
        imageEmbeddingSettingsKey(this.settings.imageEmbedding);
    const previousEffectiveEmbedding = imageEmbeddingKey(
      draftImageEmbedding(this.settings.imageEmbedding)
    );
    const outputChanged = (['outputMode', 'outputFolder'] as const).some(
      key => normalized[key] !== undefined && normalized[key] !== this.settings[key]
    );
    this.settings = {
      ...this.settings,
      ...normalized,
      imageEmbedding: normalized.imageEmbedding ?? this.settings.imageEmbedding
    };
    const imageEmbeddingChanged =
      imageSettingsChanged &&
      previousEffectiveEmbedding !==
        imageEmbeddingKey(draftImageEmbedding(this.settings.imageEmbedding));

    if (encodingChanged || imageEmbeddingChanged) {
      const encoding = encodingFromSettings(this.settings);
      const imageEmbedding = draftImageEmbedding(this.settings.imageEmbedding);
      for (const job of this.jobs) {
        if (this.teamJobSettings.has(job.id)) continue;
        // A completed job's encoding describes what was actually produced, so changing the
        // settings must not rewrite it; a job in flight is already using them.
        if (job.status === 'completed' || this.stoppable(job)) continue;
        if (encodingChanged) job.encoding = { ...encoding };
        if (imageEmbeddingChanged) job.imageEmbedding = cloneJobImageEmbedding(imageEmbedding);
        resetEstimate(job);
      }
      this.estimateHooks?.invalidate();
    }

    if (outputChanged || imageEmbeddingChanged) {
      for (const job of this.jobs) {
        if (this.teamJobSettings.has(job.id)) continue;
        if (job.status === 'completed' || this.stoppable(job)) continue;
        job.outputPath = await this.outputPathFor(job.inputPath, job);
      }
    }
    this.notify();
  }

  async setImage(slot: ImageSlot, asset: ImageAsset | null) {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    const key = slot === 'start' ? 'startImages' : 'endImages';
    imageEmbedding[key] = asset ? [{ ...asset }] : [];
    await this.updateSettings({ imageEmbedding });
  }

  async addImage(slot: ImageSlot, asset: ImageAsset) {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    const key = slot === 'start' ? 'startImages' : 'endImages';
    if (!imageEmbedding[key].some(candidate => candidate.id === asset.id)) {
      imageEmbedding[key].push({ ...asset });
    }
    await this.updateSettings({ imageEmbedding });
  }

  async removeImage(slot: ImageSlot, id: string) {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    const key = slot === 'start' ? 'startImages' : 'endImages';
    const previous = imageEmbedding[key].find(asset => asset.id === id) ?? null;
    if (!previous) return null;
    imageEmbedding[key] = imageEmbedding[key].filter(asset => asset.id !== id);
    await this.updateSettings({ imageEmbedding });
    return previous;
  }

  imageAsset(id: string) {
    const settingsAssets = [
      ...this.settings.imageEmbedding.startImages,
      ...this.settings.imageEmbedding.endImages
    ];
    const jobAssets = this.jobs.flatMap(job => [
      job.imageEmbedding?.startImage ?? null,
      job.imageEmbedding?.endImage ?? null
    ]);
    return [...settingsAssets, ...jobAssets].find(asset => asset?.id === id) ?? null;
  }

  async releaseImageIfUnused(asset: ImageAsset | null) {
    if (asset && !this.imageAsset(asset.id)) await this.imageStore.remove(asset);
  }

  async revalidateSettingsImages() {
    const imageEmbedding = cloneImageEmbeddingSettings(this.settings.imageEmbedding);
    let changed = false;
    const invalidAssets: ImageAsset[] = [];
    for (const slot of ['startImages', 'endImages'] as const) {
      const valid: ImageAsset[] = [];
      for (const asset of imageEmbedding[slot]) {
        try {
          await this.imageStore.validate(asset);
          valid.push(asset);
        } catch {
          changed = true;
          invalidAssets.push(asset);
        }
      }
      imageEmbedding[slot] = valid;
    }
    if (changed) {
      await this.updateSettings({ imageEmbedding });
      for (const asset of invalidAssets) void this.releaseImageIfUnused(asset);
    }
    return changed;
  }

  async recoverRuntimeInterruptedJobs() {
    for (const job of this.jobs) {
      const recovery = parseRuntimeRecovery(job.errorDetails);
      if (!recovery) continue;
      try {
        if (recovery.phase === 'input-analysis') {
          const media = await this.mediaRuntime.probeMedia(job.inputPath);
          if (!validSourceMedia(media)) {
            this.transition(job, 'failed');
            job.error = 'This video format is not supported or the file is damaged.';
            job.errorDetails = null;
            job.finishedAt = finishTimestamp(job);
            continue;
          }
          applySourceMedia(job, media);
          this.transition(job, 'ready');
          job.error = null;
          job.errorDetails = null;
          job.finishedAt = null;
          this.estimateHooks?.schedule();
          continue;
        }

        if (recovery.phase === 'output-validation') {
          await access(job.outputPath);
          const media = await this.mediaRuntime.probeMedia(job.outputPath);
          await this.completeJob(job, media);
          continue;
        }

        this.transition(job, 'interrupted');
        job.error = 'Compression was interrupted when the media engine stopped.';
        job.errorDetails = null;
        job.processingStage = null;
        job.finishedAt = finishTimestamp(job);
      } catch (error) {
        if (isMediaToolUnavailableError(error)) {
          await this.pauseForRuntimeFailure(job, error, recovery.phase);
          return false;
        }
        this.transition(job, 'failed');
        job.error = processingError(error);
        job.errorDetails = error instanceof Error ? error.message : null;
        job.processingStage = null;
        job.finishedAt = finishTimestamp(job);
      }
    }
    this.notify();
    return true;
  }

  embeddingConfigurationError() {
    const embedding = this.settings.imageEmbedding;
    if (embedding.enabled && !embedding.startImages.length && !embedding.endImages.length) {
      return 'EMBED_IMAGES_REQUIRED';
    }
    return null;
  }

  async add(paths: string[], allowWarnings = false): Promise<SelectionWarning[]> {
    const warnings: SelectionWarning[] = [];
    for (const inputPath of paths) {
      const result = await this.addOne(inputPath, {}, allowWarnings);
      if (result) warnings.push(result);
    }
    return warnings;
  }

  async addUploaded(
    inputPath: string,
    fileName: string,
    sourceKey: string
  ): Promise<SelectionWarning[]> {
    const warning = await this.addOne(
      inputPath,
      { sourceKind: 'uploaded', fileName, sourceKey },
      false
    );
    return warning ? [warning] : [];
  }

  async addTeamUploaded(
    inputPath: string,
    fileName: string,
    sourceKey: string,
    settings: AgentSettings
  ): Promise<SelectionWarning[]> {
    const warning = await this.addOne(
      inputPath,
      {
        sourceKind: 'uploaded',
        fileName,
        sourceKey,
        settings: cloneSettings(settings)
      },
      false
    );
    return warning ? [warning] : [];
  }

  async start(ids: string[]) {
    // Claimed synchronously, before the first await, so the queue is single-threaded with
    // respect to starting. A caller that arrives while another start is in flight waits for
    // it and then runs the guard below against the state that start actually produced —
    // which is how a hundred simultaneous double-starts become one run and ninety-nine
    // honest refusals (FR-009c).
    const previous = this.startGate;
    let release = () => {};
    this.startGate = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await this.startExclusively(ids);
    } finally {
      release();
    }
  }

  private async startExclusively(ids: string[]) {
    if (
      !this.tools.ffmpeg ||
      !this.tools.ffprobe ||
      !this.acceptingNewTasks() ||
      this.state().running
    )
      return false;
    const requested = new Set(ids);
    const rerunnable = this.jobs.filter(job => requested.has(job.id) && this.finished(job));
    for (const job of rerunnable) await this.resetForRerun(job);
    const jobs = this.jobs.filter(job => requested.has(job.id) && job.status === 'ready');
    if (!jobs.length) return false;
    if (
      jobs.some(job => {
        const embedding = (this.teamJobSettings.get(job.id) ?? this.settings).imageEmbedding;
        return embedding.enabled && !embedding.startImages.length && !embedding.endImages.length;
      })
    ) {
      return false;
    }

    const batch: QueueBatch = {
      id: randomUUID(),
      jobIds: jobs.map(job => job.id),
      startedAt: Date.now(),
      finishedAt: null
    };
    // Resolve every output path (which can throw on an unwritable/missing
    // folder) BEFORE mutating any job or the batch. A throw mid-loop must never
    // leave jobs marked `queued` with no `pump` running, which would wedge
    // `running=true` until the agent restarts.
    const warning = await this.diskWarning(jobs);
    const prepared: {
      job: CompressionJob;
      imageEmbedding: CompressionJob['imageEmbedding'];
      outputPath: string;
    }[] = [];
    for (const job of jobs) {
      const jobSettings = this.teamJobSettings.get(job.id) ?? this.settings;
      const estimatedEmbedding = job.imageEmbedding;
      const selectedImages = jobSettings.imageEmbedding.enabled
        ? {
            startImage: this.drawImage(
              'start',
              activeEmbeddingImages(jobSettings.imageEmbedding, 'start')
            ),
            endImage: this.drawImage('end', activeEmbeddingImages(jobSettings.imageEmbedding, 'end'))
          }
        : { startImage: null, endImage: null };
      const imageEmbedding = freezeImageEmbedding(
        jobSettings.imageEmbedding,
        this.random,
        selectedImages
      );
      if (imageEmbedding?.replaceExisting && estimatedEmbedding?.replaceExisting) {
        imageEmbedding.sourceTrimStartSeconds = estimatedEmbedding.sourceTrimStartSeconds;
        imageEmbedding.sourceTrimEndSeconds = estimatedEmbedding.sourceTrimEndSeconds;
      }
      // Reserve against paths already committed in this loop as well as the
      // other jobs' current paths, so two started jobs never collide.
      const reserved = prepared.map(entry => entry.outputPath);
      const outputPath = await this.outputPathFor(job.inputPath, job, jobSettings, reserved);
      prepared.push({ job, imageEmbedding, outputPath });
    }

    this.batch = batch;
    this.startDrainWatchdog();
    this.warning = warning;
    for (const { job, imageEmbedding, outputPath } of prepared) {
      const draftKey = jobConfigurationKey(job.encoding, job.imageEmbedding);
      job.imageEmbedding = imageEmbedding;
      job.outputPath = outputPath;
      if (
        draftKey !== jobConfigurationKey(job.encoding, job.imageEmbedding) &&
        !refreshEstimateFromBreakdown(job)
      ) {
        resetEstimate(job);
      }
      this.transition(job, 'queued');
      job.batchId = batch.id;
      job.error = null;
      job.errorDetails = null;
      job.progress = outputDurationSeconds(job) ? 0 : null;
      job.processingStage = null;
      job.startedAt = null;
      job.finishedAt = null;
    }
    this.notify();
    void this.pump();
    return true;
  }

  /**
   * The machine slept with an encode in flight, and has woken up (FR-009a).
   *
   * Ordinarily the encode simply carries on — a suspend freezes the child along with
   * everything else, and Node delivers its exit if the system did end it. This is for the
   * case that leaves the interface lying: a handle that still reads as running for a
   * process that is no longer there. Nothing will ever settle that job, so the row would
   * say "compressing" for the rest of the session while the machine did nothing.
   *
   * Presented as interrupted rather than cancelled or failed: the user did not stop it and
   * nothing about it broke. Interrupted is the state that already means exactly this, and
   * the row's re-run affordance follows from it.
   *
   * Returns whether anything was actually interrupted, which is what its test asserts.
   */
  handleWake(): boolean {
    const activity = this.activity;
    if (activity.kind !== 'encoding' && activity.kind !== 'encoding-held') return false;
    const child = activity.child;
    // No child yet means the work is still in this process — image preparation — and a
    // suspend does not interrupt that any more than a busy moment does.
    if (!child || !encoderVanished(child)) return false;
    const job = this.jobs.find(candidate => candidate.id === activity.jobId);
    if (!job || job.status !== 'processing') return false;

    this.transition(job, 'interrupted');
    job.error = 'Compression was interrupted while the computer was asleep.';
    job.errorDetails = null;
    job.processingStage = null;
    job.finishedAt = finishTimestamp(job);
    this.releaseEstimateHold();
    // Whatever untracked work this encode started goes with it.
    activity.abort.abort();
    // The slot is freed here for the same reason a stop frees it (FR-004): there is
    // nothing left to wait for, and the next job should not be held behind a process that
    // no longer exists.
    this.setActivity({ kind: 'idle' });
    queueMicrotask(() => void this.pump());
    this.notify();
    return true;
  }

  /**
   * Pauses or resumes the running encode.
   *
   * FFmpeg has no pause of its own, so the child is suspended with SIGSTOP and
   * woken with SIGCONT: the process keeps its memory, its output file and its
   * position, and simply stops being scheduled. POSIX only — Windows has no
   * equivalent signal, so there the call reports back as unsupported and the
   * interface keeps its pause button hidden.
   */
  setPaused(id: string, paused: boolean): 'ok' | 'not-found' | 'unsupported' {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status !== 'processing') return 'not-found';
    const activity = this.current;
    if (activity.kind !== 'encoding' || activity.jobId !== id) return 'not-found';
    const child = activity.child;
    if (!child || child.pid === undefined) return 'not-found';
    // Through the governor, never by signalling the child here: it is the only
    // thing that may stop a managed process, and its duty cycler would wake, at
    // its next on-window, an encode the person deliberately stopped. It also
    // knows how to suspend on Windows, which has no such signal to send.
    if (!this.pauseSupported()) return 'unsupported';
    if (paused) {
      if (!this.pauseHolds.has(id) && !this.takePauseHold(id, child)) return 'unsupported';
    } else {
      this.releasePauseHold(id);
    }
    if (paused) {
      job.pausedAt = Date.now();
    } else if (job.pausedAt) {
      job.pausedTotalMs = (job.pausedTotalMs ?? 0) + (Date.now() - job.pausedAt);
      job.pausedAt = null;
    }
    job.paused = paused;
    this.notify();
    return 'ok';
  }

  async cancel(id: string) {
    const cancelled = await this.cancelJob(id);
    if (cancelled) this.notify('estimate:queued');
    return cancelled;
  }

  /** Cancels one job without broadcasting; the caller decides when to notify. */
  private async cancelJob(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || (job.status !== 'processing' && job.status !== 'queued')) return false;
    const wasProcessing = job.status === 'processing';
    // A repeat that never produced anything: hand the card its finished state
    // back rather than marking a file that still exists as cancelled.
    const previous = this.previousResults.get(job.id) ?? null;
    // The repeat wrote to its own path, so the finished file is intact unless
    // it was removed from disk behind our back.
    const outputUntouched = previous !== null && (await fileSize(previous.outputPath)) !== null;
    if (job.estimatePriorityOrder !== null) this.estimateHooks?.cancelPrioritized?.(job.id);
    if (previous && outputUntouched) {
      // A queued repeat has not started, so the lifecycle has no direct road
      // back to 'completed'; it goes through the state a stopped job lands in.
      if (job.status === 'queued') this.transition(job, 'processing');
      this.transition(job, 'completed');
      job.outputPath = previous.outputPath;
      job.finalSize = previous.finalSize;
      job.finalWidth = previous.finalWidth;
      job.finalHeight = previous.finalHeight;
      job.finalFrameRate = previous.finalFrameRate;
      job.finalBitrate = previous.finalBitrate;
      job.finalDurationSeconds = previous.finalDurationSeconds;
      job.finalCodec = previous.finalCodec;
      job.startedAt = previous.startedAt;
      job.finishedAt = previous.finishedAt;
      job.estimateStatus = previous.estimateStatus;
      job.estimatedOutputBytes = previous.estimatedOutputBytes;
      job.estimatedSavingPercent = previous.estimatedSavingPercent;
      job.estimateKey = previous.estimateKey;
      job.progress = 100;
      job.error = null;
      job.errorDetails = null;
      job.processingStage = null;
      job.estimatePriorityOrder = null;
      this.previousResults.delete(job.id);
      if (wasProcessing) this.stopActiveEncode();
      this.notify();
      return true;
    }
    this.previousResults.delete(job.id);
    // The status stays 'cancelled' — stop-all and the batch summary need to say
    // what happened — but it no longer carries an error, and the row keeps its
    // estimate, so a stopped file reads as "not compressed yet" rather than as
    // something that went wrong.
    this.transition(job, 'cancelled');
    job.error = null;
    job.finishedAt = finishTimestamp(job);
    job.processingStage = null;
    job.estimatePriorityOrder = null;
    // An estimate describes the current encoding configuration, not a specific
    // compression attempt. Keep a completed, current estimate on cancellation;
    // otherwise mark unfinished estimate work as paused. Resetting everything
    // to `waiting` made a stopped row flash as if estimation had restarted,
    // even though terminal jobs are deliberately ignored by the estimator.
    // Starting a run freezes the embedding (its random final duration is drawn
    // then), which changes the configuration key and makes the existing
    // estimate look stale. Cancelling puts the draft back and recomputes the
    // figure from the breakdown that was already measured — so a start/cancel
    // round trip leaves the estimate exactly where it was.
    if (this.settings.imageEmbedding.enabled || job.imageEmbedding) {
      job.imageEmbedding = draftImageEmbedding(this.settings.imageEmbedding);
    }
    if (job.estimateStatus === 'estimated') {
      refreshEstimateFromBreakdown(job);
    } else {
      // Back to 'waiting', not 'cancelled': the estimate belongs to the current
      // settings, not to the compression attempt that was just stopped. Marking
      // it cancelled left the card animating "estimation paused" forever, since
      // nothing ever moves a cancelled estimate back into the queue.
      job.estimateStatus = 'waiting';
      job.estimateProgress = null;
      job.estimateError = null;
    }
    if (wasProcessing) this.stopActiveEncode();
    return true;
  }

  /** Ends the encode that owns the compressor slot and frees it for the next job. */
  private stopActiveEncode() {
    {
      const activity = this.activity;
      const encoding = activity.kind === 'encoding' || activity.kind === 'encoding-held';
      // Stop untracked background work too (static-edge detection during
      // `preparing-images`), whose ffmpeg children are not the tracked encoder and
      // would otherwise keep loading the CPU after the UI shows "cancelled".
      if (encoding) activity.abort.abort();
      // Captured before the release, which swaps the activity out of its held variant.
      const child = encoding ? activity.child : null;
      // SIGTERM is not delivered to a stopped process until it is resumed, so a
      // suspended encode would ignore the graceful signal and only die to the
      // SIGKILL escalation — losing the chance to finalize its output.
      this.releaseEstimateHold();
      if (child) {
        this.power?.resumeForTermination(child);
        this.terminating.add(child);
        child.once('close', () => this.terminating.delete(child));
        child.kill('SIGTERM');
      }

      // FR-004. The place in the queue is released now, not when the child finally exits.
      // Unwinding a stopped encode takes as long as the child takes to honour a signal — up
      // to the escalation deadline for one that ignores it — and making the user wait that
      // long before the next file starts is the stop appearing not to have worked.
      //
      // Safe because nothing else depends on holding the slot: the child carries its own
      // termination escalation, `terminating` keeps a quit from outrunning it, and this
      // encode's own `finally` checks whether the activity is still its own before touching
      // it.
      if (encoding) {
        this.setActivity({ kind: 'idle' });
        queueMicrotask(() => void this.pump());
      }
    }
  }

  /**
   * Stops the whole visible batch in one action. Queued jobs are cancelled
   * first so the pump cannot pick another one up while the active encode is
   * still being torn down, and team jobs are skipped: they never appear in the
   * compressor UI, so a "stop all" there must not kill Team Workspace work.
   */
  async cancelAll(): Promise<number> {
    const stoppable = (status: JobStatus) =>
      this.jobs
        .filter(job => job.status === status && !this.teamJobSettings.has(job.id))
        .map(job => job.id);
    const ids = [...stoppable('queued'), ...stoppable('processing')];
    let stopped = 0;
    // One broadcast at the end, not one per job: cancelling a hundred-file
    // queue would otherwise push a hundred full `QueueState` frames — each a
    // clone of every job — down every open SSE connection.
    for (const id of ids) if (await this.cancelJob(id)) stopped += 1;
    if (!stopped) return 0;
    // Close the batch out. Nothing else will when only queued jobs were
    // stopped: the drain loop has no work left to finish on, so the batch would
    // keep its null `finishedAt` and the watchdog would tick for the rest of
    // the session looking for a queue that is already empty. When a running
    // encode was cancelled the batch closes on its way out instead.
    this.closeBatchIfDrained();
    this.notify('estimate:queued');
    return stopped;
  }

  prioritizeEstimate(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (
      !this.state().running ||
      !job ||
      job.status !== 'queued' ||
      !['waiting', 'cancelled'].includes(job.estimateStatus) ||
      job.estimatePriorityOrder !== null
    ) {
      return false;
    }
    job.estimatePriorityOrder = this.nextEstimatePriorityOrder++;
    job.estimateStatus = 'waiting';
    job.estimateProgress = null;
    job.estimateError = null;
    this.notify('estimate:queued');
    void this.runPrioritizedEstimates();
    return true;
  }

  cancelPrioritizedEstimate(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.estimatePriorityOrder === null) return false;
    job.estimatePriorityOrder = null;
    if (job.estimateStatus === 'estimating') {
      job.estimateStatus = 'waiting';
      job.estimateProgress = null;
      job.estimateError = null;
    }
    this.estimateHooks?.cancelPrioritized?.(id);
    this.notify('estimate:queued');
    return true;
  }

  remove(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    // Anything that cannot be stopped can be removed — the two are the same question asked
    // from opposite sides.
    if (!job || this.stoppable(job)) return false;
    if (job.estimatePriorityOrder !== null) this.estimateHooks?.cancelPrioritized?.(id);
    const images = jobImages(job);
    this.jobs = this.jobs.filter(candidate => candidate !== job);
    this.teamJobSettings.delete(job.id);
    void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
    return true;
  }

  /**
   * Drops a team job whatever state it is in. Team work is invisible to the
   * compressor UI and is never persisted, so a queued or processing leftover
   * would keep `running` true — greying out the whole tool — with nothing on
   * screen to explain it and no way back short of restarting the agent.
   */
  async discardTeamJob(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) return false;
    if (job.status === 'processing' || job.status === 'queued') await this.cancel(id);
    return this.remove(id);
  }

  removeMany(ids: string[]) {
    const selected = new Set(ids);
    const removable = this.jobs.filter(job => selected.has(job.id) && !this.stoppable(job));
    if (!removable.length) return 0;
    for (const job of removable) {
      if (job.estimatePriorityOrder !== null) this.estimateHooks?.cancelPrioritized?.(job.id);
      this.teamJobSettings.delete(job.id);
    }
    const removed = new Set(removable.map(job => job.id));
    const images = removable.flatMap(jobImages);
    this.jobs = this.jobs.filter(job => !removed.has(job.id));
    for (const job of removable) void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
    return removable.length;
  }

  async retry(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    // Finished, but not finished *well*. Repeating a completed job is its own action, and
    // labelling it "retry" would tell the user something went wrong when nothing did.
    if (!job || !this.finished(job) || job.status === 'completed') return false;
    // A row-level retry is an explicit request to run the compression again,
    // just like repeat on a completed row. `start` owns the complete transition
    // through ready -> queued and prevents a transient ready state from waking
    // the background estimator instead of the compressor.
    return this.start([id]);
  }

  async repeat(id: string) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status !== 'completed') return false;
    return this.start([id]);
  }

  clearCompleted() {
    const removed = this.jobs.filter(job => this.finished(job));
    const images = removed.flatMap(jobImages);
    this.jobs = this.jobs.filter(job => !removed.includes(job));
    for (const job of removed) this.teamJobSettings.delete(job.id);
    for (const job of removed) void cleanupImportedSource(job);
    for (const image of images) void this.releaseImageIfUnused(image);
    this.notify();
  }

  outputFolder(): string | null {
    const completed = this.jobs.find(job => job.status === 'completed');
    return completed ? path.dirname(completed.outputPath) : this.settings.outputFolder;
  }

  async shutdown() {
    const activity = this.activity;
    if (activity.kind !== 'encoding' && activity.kind !== 'encoding-held') {
      // No encode of its own, but a stop may have freed the slot moments ago and left a
      // child still going. Returning here would be the quit outrunning the termination it
      // started — which is the orphan this feature exists to prevent.
      await this.awaitTerminating();
      return;
    }
    // Abort background media work first: static-edge detection runs its own
    // ffmpeg children that are not the tracked encoder, so without this a shutdown
    // during `preparing-images` would leave them running.
    activity.abort.abort();
    // The identity the five-field version did not have, and the reason a quit mid-batch left
    // a truncated file next to the user's source every time (A2(i)). Every *cancel* path
    // unlinks; shutdown could not, because nothing recorded which job the child belonged to.
    const { jobId } = activity;
    const child = activity.child;
    if (!child) {
      await this.unlinkPartialOutput(jobId);
      return;
    }
    this.releaseEstimateHold();
    this.power?.resumeForTermination(child);
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(resolve => child.once('close', () => resolve())),
      new Promise<void>(resolve =>
        setTimeout(
          () => {
            child.kill('SIGKILL');
            resolve();
          },
          // Throttling stretches wall-clock time, so a fixed grace period would
          // shrink in effective terms exactly when the process needs it most.
          this.power?.scaleTimeout(2000) ?? 2000
        )
      )
    ]);
    await this.unlinkPartialOutput(jobId);
    await this.awaitTerminating();

    // Leave the queue saying what is true. The encode's own `finally` clears the activity,
    // but it runs a turn or two later — after the child's close has travelled back through
    // the encoder's promise — so `shutdown()` used to return while `compressionActive()` was
    // still true. In production the process exits before anyone notices; anywhere else it is
    // the same "says stopped, still running" mismatch this whole area exists to remove.
    const settled: CompressorActivity = this.current;
    const stillOurs =
      (settled.kind === 'encoding' || settled.kind === 'encoding-held') &&
      settled.abort === activity.abort;
    if (stillOurs) this.current = { kind: 'idle' };
  }

  /**
   * Waits for encoders that were stopped but have not exited yet.
   *
   * The window FR-004 opens: between signalling a stop and the child actually going, the
   * queue has already moved on. A quit that did not wait here would leave those children
   * with no process left to escalate their termination.
   */
  private async awaitTerminating(): Promise<void> {
    const children = [...this.terminating];
    if (children.length === 0) return;
    await Promise.all(
      children.map(
        child =>
          new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('close', () => resolve());
            // The escalation the spawn seam armed is already running; this is only the
            // deadline for waiting on it, and a quit must never be held open past it.
            const giveUp = setTimeout(
              () => {
                child.kill('SIGKILL');
                resolve();
              },
              this.power?.scaleTimeout(3_000) ?? 3_000
            );
            giveUp.unref();
          })
      )
    );
    this.terminating.clear();
  }

  /**
   * Removes the half-written output of a run that was stopped, if it wrote one.
   *
   * A partial `.mp4` is not a smaller video — it is a file the user's player may open and
   * show as broken, sitting next to the source with a name that says it is the result. The
   * job keeps saying `processing` on purpose, so the next launch can tell a quit apart from
   * a crash; what must not survive is the artefact.
   */
  private async unlinkPartialOutput(jobId: string) {
    const job = this.jobs.find(candidate => candidate.id === jobId);
    if (!job?.outputPath) return;
    await unlink(job.outputPath).catch(() => {});
  }

  updateEstimate(id: string, patch: Partial<CompressionJob>, event: AgentEventType) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status === 'completed') return;
    Object.assign(job, patch);
    this.notify(event);
  }

  estimationJobs() {
    return this.jobs.filter(job => !this.teamJobSettings.has(job.id)).map(job => cloneJob(job));
  }

  private async addOne(
    inputPath: string,
    options: AddSourceOptions,
    allowWarnings: boolean
  ): Promise<SelectionWarning | null> {
    const canonical = path.resolve(inputPath);
    const fileName = options.fileName ?? path.basename(canonical);
    const sourceSettings = options.settings ?? this.settings;
    if (!isSupportedVideoPath(fileName)) {
      return selectionWarning(fileName, 'unsupported-format', 'This file format is not supported.');
    }

    // Re-adding a file that is already in the list is still rejected, but a
    // video that merely looks already-compressed can be re-compressed freely.
    const duplicate = this.jobs.some(job =>
      options.sourceKey
        ? job.sourceKey === options.sourceKey
        : path.resolve(job.inputPath) === canonical
    );
    if (duplicate && !allowWarnings) {
      return selectionWarning(fileName, 'duplicate', 'This video is already in the list.');
    }

    try {
      const size = await fileSize(canonical);
      const sourceKind = options.sourceKind ?? 'local';
      const job: CompressionJob = {
        id: randomUUID(),
        inputPath: canonical,
        outputPath: '',
        fileName,
        sourceKind,
        sourceKey: options.sourceKey ?? null,
        durationSeconds: null,
        originalSize: size,
        sourceWidth: null,
        sourceHeight: null,
        sourceFrameRate: null,
        sourceBitrate: null,
        sourceCodec: null,
        sourceHasAudio: false,
        sourceAudioBitrate: null,
        sourceAudioSampleRate: null,
        sourceAudioChannels: null,
        sourceAudioLayout: null,
        finalSize: null,
        finalWidth: null,
        finalHeight: null,
        finalFrameRate: null,
        finalBitrate: null,
        finalDurationSeconds: null,
        finalCodec: null,
        progress: null,
        processingStage: null,
        status: 'analyzing',
        error: null,
        errorDetails: null,
        encoding: encodingFromSettings(sourceSettings),
        imageEmbedding: draftImageEmbedding(sourceSettings.imageEmbedding),
        batchId: null,
        startedAt: null,
        finishedAt: null,
        estimateStatus: 'waiting',
        estimatedOutputBytes: null,
        estimatedSavingPercent: null,
        estimateRangeMinBytes: null,
        estimateRangeMaxBytes: null,
        estimateProgress: null,
        estimateError: null,
        estimateKey: null,
        estimatePriorityOrder: null,
        estimateBreakdown: null
      };
      job.outputPath = await this.outputPathFor(canonical, job, sourceSettings);
      this.jobs.push(job);
      if (options.settings) this.teamJobSettings.set(job.id, cloneSettings(sourceSettings));
      this.notify();

      if (!this.tools.ffprobe) {
        await this.pauseForRuntimeFailure(
          job,
          new MediaToolUnavailableError('ffprobe'),
          'input-analysis'
        );
        return null;
      }
      let media: MediaInfo;
      try {
        media = await this.mediaRuntime.probeMedia(canonical);
      } catch (error) {
        if (isMediaToolUnavailableError(error)) {
          await this.pauseForRuntimeFailure(job, error, 'input-analysis');
          return null;
        }
        throw error;
      }
      if (!validSourceMedia(media)) {
        this.transition(job, 'failed');
        job.error = 'This video format is not supported or the file is damaged.';
        this.notify();
        return null;
      }
      applySourceMedia(job, media);
      job.progress = 0;
      this.transition(job, 'ready');
      this.notify('estimate:queued');
      this.estimateHooks?.schedule();
      return null;
    } catch {
      return selectionWarning(fileName, 'inaccessible', 'The file is no longer accessible.');
    }
  }

  private async resetForRerun(job: CompressionJob) {
    const jobSettings = this.teamJobSettings.get(job.id) ?? this.settings;
    const previousImages = jobImages(job);
    // Keep what the finished run produced. A repeat that is cancelled before it
    // overwrites anything should leave the card exactly as it was — green, with
    // its result — instead of demoting a good file to "cancelled".
    // While a repeat runs, the finished file stays where it is: the new encode
    // writes beside it and only takes its place when it succeeds. A cancel or
    // a crash then costs nothing.
    this.previousResults.set(
      job.id,
      job.status === 'completed' && job.finalSize !== null
        ? {
            outputPath: job.outputPath,
            finalSize: job.finalSize,
            finalWidth: job.finalWidth,
            finalHeight: job.finalHeight,
            finalFrameRate: job.finalFrameRate,
            finalBitrate: job.finalBitrate,
            finalDurationSeconds: job.finalDurationSeconds,
            finalCodec: job.finalCodec,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            estimateStatus: job.estimateStatus,
            estimatedOutputBytes: job.estimatedOutputBytes,
            estimatedSavingPercent: job.estimatedSavingPercent,
            estimateKey: job.estimateKey
          }
        : null
    );
    this.transition(job, 'ready');
    job.error = null;
    job.errorDetails = null;
    job.progress = job.durationSeconds ? 0 : null;
    job.processingStage = null;
    job.finalSize = null;
    job.finalWidth = null;
    job.finalHeight = null;
    job.finalFrameRate = null;
    job.finalBitrate = null;
    job.finalDurationSeconds = null;
    job.finalCodec = null;
    job.startedAt = null;
    job.finishedAt = null;
    job.batchId = null;
    job.encoding = encodingFromSettings(jobSettings);
    job.imageEmbedding = draftImageEmbedding(jobSettings.imageEmbedding);
    // A repeat must not aim at the file it is repeating: reserve the finished
    // path so the new encode gets its own, and the old result survives a cancel.
    const finished = this.previousResults.get(job.id);
    job.outputPath = await this.outputPathFor(
      job.inputPath,
      job,
      jobSettings,
      finished ? [finished.outputPath] : []
    );
    resetEstimate(job);
    for (const image of previousImages) void this.releaseImageIfUnused(image);
  }

  private drawImage(slot: ImageSlot, assets: ImageAsset[]) {
    if (!assets.length) {
      this.imagePool[slot] = [];
      this.knownPoolImages[slot].clear();
      return null;
    }
    const currentIds = new Set(assets.map(asset => asset.id));
    this.imagePool[slot] = this.imagePool[slot].filter(id => currentIds.has(id));
    for (const asset of assets) {
      if (!this.knownPoolImages[slot].has(asset.id)) this.imagePool[slot].push(asset.id);
    }
    this.knownPoolImages[slot] = currentIds;
    if (!this.imagePool[slot].length) {
      this.imagePool[slot] = assets.map(asset => asset.id);
    }
    const index =
      this.imagePool[slot].length === 1
        ? 0
        : Math.floor(
            Math.min(0.999999999, Math.max(0, this.random())) * this.imagePool[slot].length
          );
    const [id] = this.imagePool[slot].splice(index, 1);
    const selected = assets.find(asset => asset.id === id) ?? assets[0];
    return { ...selected };
  }

  private async outputPathFor(
    inputPath: string,
    current?: CompressionJob,
    settings: AgentSettings = this.settings,
    extraReserved: string[] = []
  ) {
    let folder: string | undefined;
    if (settings.outputMode === 'chosen-folder') {
      folder = settings.outputFolder ?? undefined;
      if (!folder) throw new Error('Choose an output folder first.');
    }
    if (folder) await mkdir(folder, { recursive: true });
    const reserved = this.jobs
      .filter(job => job !== current)
      .map(job => job.outputPath)
      .filter(Boolean)
      .concat(extraReserved.filter(Boolean));
    return nextOutputPath(
      inputPath,
      folder,
      reserved,
      Boolean(draftImageEmbedding(settings.imageEmbedding)),
      settings.outputSuffix
    );
  }

  private async diskWarning(jobs: CompressionJob[]) {
    if (!jobs.length) return null;
    const byFolder = new Map<string, number>();
    for (const job of jobs) {
      const folder = path.dirname(job.outputPath);
      const expected = Math.max(job.originalSize, job.estimatedOutputBytes ?? 0);
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + expected);
    }
    for (const [folder, required] of byFolder) {
      try {
        const info = await statfs(folder);
        const free = info.bavail * info.bsize;
        if (free < required * 1.1) {
          // The folder is deliberately not named: the interface knows which
          // output folder is configured and can say so itself, without the path
          // travelling through a message.
          return 'DISK_SPACE_LOW';
        }
      } catch {
        return 'DISK_SPACE_UNKNOWN';
      }
    }
    return null;
  }

  /** True while the current batch still has work nobody has picked up. */
  private queuedInBatch(): boolean {
    return Boolean(
      this.batch && this.jobs.some(job => job.batchId === this.batch!.id && job.status === 'queued')
    );
  }

  /**
   * Watches for a drain loop that was dropped — by a rejected handoff, a tool
   * outage, or a team job left behind — and re-drives it.
   *
   * A queued job with nothing in flight used to keep `running` (and therefore
   * the whole compressor UI) wedged until the agent restarted. The check lived
   * in `state()` for a while, which read cheaply but meant every SSE broadcast
   * could schedule a pump, and a pump that notified on a bail-out path would
   * have looped `state → pump → notify → state` through microtasks with no turn
   * of the event loop in between. A recovery mechanism should not be able to
   * hang the process it is recovering, so it runs on its own slow timer.
   */
  private startDrainWatchdog() {
    if (this.drainWatchdog) return;
    const timer = setInterval(() => {
      // The stranded-activity case, and the reason this net had a hole in it.
      //
      // A user reported the Compress button greyed out as "already running"
      // over a panel showing nothing queued, processing or done — and no way
      // out short of restarting the application. The activity had been left
      // non-idle while naming a job that was gone, so `running()` stayed true;
      // the watchdog retired on the line below because there was no open batch,
      // which is precisely the state it needed to survive.
      if (this.clearStrandedActivity()) this.notify();

      if (!this.batch || this.batch.finishedAt) {
        // Only retire once there is genuinely nothing to watch. An activity
        // still in flight has to be watched whether or not a batch is open.
        if (this.activity.kind === 'idle') this.stopDrainWatchdog();
        return;
      }
      if (this.activity.kind !== 'idle') return;
      if (this.queuedInBatch()) {
        void this.pump();
        return;
      }
      // A batch with nothing queued and nothing in flight is over, whatever
      // ended it. Closing it here is what lets this timer retire: a safety net
      // that cannot stop looking is itself a leak.
      this.closeBatchIfDrained();
      this.notify();
    }, DRAIN_WATCHDOG_MS);
    // Never hold the process open for a safety net.
    timer.unref();
    this.drainWatchdog = timer;
  }

  /**
   * Clears an activity that cannot be real, and says whether it cleared one.
   *
   * "Encoding job X" is only true while X exists and is unfinished. If it has
   * been removed, or has already reached a terminal status, then whatever the
   * activity is describing ended without the value being reset — and every
   * caller downstream, including the interface's busy flag, is being told the
   * queue is working when it is not.
   *
   * Deliberately conservative: an activity naming no job at all is left alone,
   * because the estimate-priority handoff legitimately has one of those in
   * flight, and clearing it here would end a real encode.
   */
  private clearStrandedActivity(): boolean {
    const activity = this.activity;
    if (activity.kind === 'idle') return false;
    const jobId = 'jobId' in activity ? activity.jobId : null;
    if (!jobId) return false;
    const job = this.jobs.find(candidate => candidate.id === jobId);
    if (job && !isSettled(COMPRESSION_LIFECYCLE, job.status)) return false;
    this.setActivity({ kind: 'idle' });
    return true;
  }

  private stopDrainWatchdog() {
    if (!this.drainWatchdog) return;
    clearInterval(this.drainWatchdog);
    this.drainWatchdog = null;
  }

  /**
   * Marks the batch finished once nothing is left to do.
   *
   * `pump()` does this on its way out of a normal drain, but it also bails
   * early when a media tool is missing — and a batch the user stopped has to
   * close either way, or the queue keeps reporting a batch that will never
   * finish.
   */
  private closeBatchIfDrained() {
    if (!this.batch || this.batch.finishedAt) return;
    if (this.running()) return;
    this.batch.finishedAt = Date.now();
    this.stopDrainWatchdog();
    this.resumeEstimatorWhenIdle();
  }

  /**
   * Compression pauses background size estimates so they cannot compete for
   * FFmpeg or CPU. Do not rely solely on the next queue pump to resume them:
   * a cancelled final job can close the batch before that pass runs.
   */
  private resumeEstimatorWhenIdle() {
    if (this.running()) return;
    this.estimateHooks?.resume();
  }

  private async pump() {
    if (this.activity.kind !== 'idle' || !this.batch || !this.tools.ffmpeg || !this.tools.ffprobe)
      return;
    const job = this.jobs.find(
      candidate => candidate.batchId === this.batch!.id && candidate.status === 'queued'
    );
    if (!job) {
      if (!this.batch.finishedAt) this.batch.finishedAt = Date.now();
      this.stopDrainWatchdog();
      if (this.updateState.state === 'draining') this.updateState.state = 'pending';
      this.notify();
      this.estimateHooks?.resume();
      return;
    }

    // Claim the activity as the very first statement inside the guarded region so a throw
    // from `notify()` (or anywhere below) can never strand it — which would wedge the queue
    // as permanently "running" until the agent restarts. One write now, where it used to be
    // two fields that a throw could land between.
    const abort = new AbortController();
    try {
      this.setActivity({
        kind: 'encoding',
        jobId: job.id,
        abort,
        child: null,
        estimating: this.current.kind === 'estimating'
      });
      this.transition(job, 'processing');
      job.error = null;
      job.errorDetails = null;
      job.estimatePriorityOrder = null;
      job.startedAt = Date.now();
      job.finishedAt = null;
      job.processingStage = job.imageEmbedding ? 'preparing-images' : 'compressing';
      this.notify();
      await access(job.inputPath);
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      const embedding = await this.embeddingOptions(job, abort.signal);
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      job.processingStage = 'compressing';
      this.notify();
      let result = await this.run(job, false, embedding);
      if (result.spawnErrorCode) {
        throw new MediaToolUnavailableError('ffmpeg', result.spawnErrorCode);
      }
      if (
        !embedding &&
        !isCancelled(job) &&
        result.code !== 0 &&
        isAudioCopyFailure(result.stderr)
      ) {
        await unlink(job.outputPath).catch(() => {});
        job.progress = job.durationSeconds ? 0 : null;
        this.notify();
        result = await this.run(job, true, embedding);
        if (result.spawnErrorCode) {
          throw new MediaToolUnavailableError('ffmpeg', result.spawnErrorCode);
        }
      }
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
      } else if (result.code === 0) {
        job.processingStage = 'finalizing';
        this.notify();
        const media = await this.mediaRuntime.probeMedia(job.outputPath);
        await this.completeJob(job, media);
      } else {
        this.transition(job, 'failed');
        job.error = friendlyError(result.stderr);
        job.errorDetails = result.stderr || null;
        job.processingStage = null;
        job.finishedAt = finishTimestamp(job);
        await unlink(job.outputPath).catch(() => {});
      }
    } catch (error) {
      // A cancel during `preparing-images` aborts background media work, which
      // surfaces here as a rejection. The job is already marked `cancelled`, so
      // treat it as a clean cancellation rather than overwriting it with a
      // failure state.
      if (isCancelled(job)) {
        await unlink(job.outputPath).catch(() => {});
        return;
      }
      if (isMediaToolUnavailableError(error)) {
        const phase = job.processingStage === 'finalizing' ? 'output-validation' : 'encoding';
        await this.pauseForRuntimeFailure(job, error, phase);
        return;
      }
      this.transition(job, 'failed');
      job.error = processingError(error);
      job.errorDetails = error instanceof Error ? error.message : null;
      job.processingStage = null;
      job.finishedAt = finishTimestamp(job);
      await unlink(job.outputPath).catch(() => {});
    } finally {
      // Only if this is still *our* encode. A later run claiming the activity while this one
      // unwinds must not be cleared by it.
      //
      // Annotated, and read from the field rather than the getter, on purpose: `pump` opens
      // by narrowing `this.activity` to `idle`, and TypeScript keeps that narrowing across
      // the assignment in the `try` because the assignment goes through a different
      // reference path. Without the annotation this reads as `idle`, every branch below is
      // dead, and the activity is never cleared — a wedged queue. The compiler reported it;
      // the annotation is what keeps it reporting the next one.
      const ending: CompressorActivity = this.current;
      const stillOurs =
        (ending.kind === 'encoding' || ending.kind === 'encoding-held') && ending.abort === abort;
      if (stillOurs) {
        // Estimates that were running alongside keep running: ending the encode is not
        // ending them, and reporting idle here would let the pump start the next job while
        // the estimate loop still believed it had the machine.
        const estimatesStillRunning =
          ending.kind === 'encoding-held' || (ending.kind === 'encoding' && ending.estimating);
        this.setActivity(estimatesStillRunning ? { kind: 'estimating' } : { kind: 'idle' });
      }
      this.resumeEstimatorWhenIdle();
      // Queue the next drain first: a throw from `notify` or from the estimate
      // handoff below must never drop the loop and leave the rest of the batch
      // queued forever. `pump` bails on its own if either takes the queue over.
      queueMicrotask(() => void this.pump());
      this.notify();
      await this.runPrioritizedEstimates();
    }
  }

  private async completeJob(job: CompressionJob, media: MediaInfo) {
    validateCompletedOutput(job, media);
    const producedSize = await fileSize(job.outputPath);

    // No never-larger ceiling.
    //
    // An encode that comes back bigger used to be thrown away and the source
    // kept in its place. That decision belongs to the person, not the tool:
    // they may have changed the settings deliberately, or embedded a still
    // tail, and silently handing back the original hides what actually
    // happened. The result is kept and the card reports the honest numbers.

    this.transition(job, 'completed');
    job.progress = 100;
    job.processingStage = null;
    job.finalSize = producedSize;
    job.finalWidth = media.width;
    job.finalHeight = media.height;
    job.finalFrameRate = media.frameRate;
    job.finalBitrate = media.bitrate;
    job.finalDurationSeconds = media.duration;
    job.finalCodec = media.codec;
    job.error = null;
    job.errorDetails = null;
    job.estimateStatus = 'cancelled';
    job.estimateProgress = null;
    job.finishedAt = finishTimestamp(job);
  }

  private async pauseForRuntimeFailure(
    job: CompressionJob,
    error: MediaToolUnavailableError,
    phase: RuntimeRecoveryPhase
  ) {
    this.tools[error.tool] = false;
    this.warning = RUNTIME_WARNING;
    this.transition(job, phase === 'input-analysis' ? 'analyzing' : 'interrupted');
    job.error = RUNTIME_JOB_ERROR;
    job.errorDetails = runtimeRecoveryDetails(error, phase);
    job.processingStage = null;
    job.finishedAt = phase === 'input-analysis' ? null : finishTimestamp(job);
    if (phase === 'output-validation') {
      job.progress = 100;
      job.finalSize = await fileSize(job.outputPath).catch(() => null);
    } else if (phase === 'encoding') {
      await unlink(job.outputPath).catch(() => {});
    }

    if (this.batch) {
      for (const queued of this.jobs) {
        if (queued.batchId !== this.batch.id || queued.status !== 'queued') continue;
        this.transition(queued, 'ready');
        queued.batchId = null;
        queued.processingStage = null;
        queued.estimatePriorityOrder = null;
      }
      this.batch.finishedAt ??= Date.now();
      this.stopDrainWatchdog();
    }
    this.notify();
    try {
      this.runtimeRecovery?.(error);
    } catch {
      // The persisted recovery marker is sufficient for a later manual launch.
    }
  }

  private async embeddingOptions(job: CompressionJob, signal?: AbortSignal) {
    if (!job.imageEmbedding) return undefined;
    const dimensions = outputDimensions(job);
    if (!dimensions || !job.durationSeconds) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: output dimensions or duration are unavailable.');
    }
    if (job.encoding.frameRate === null && !job.sourceFrameRate) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: original frame rate is unavailable.');
    }
    const frameRate = outputFrameRate(job);
    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: output frame rate is unavailable.');
    }
    if (job.imageEmbedding.replaceExisting) {
      const trims = await detectStaticEdgeTrims(
        job.inputPath,
        job.durationSeconds,
        job.sourceFrameRate ?? frameRate,
        signal
      );
      job.imageEmbedding.sourceTrimStartSeconds = trims.startSeconds;
      job.imageEmbedding.sourceTrimEndSeconds = trims.endSeconds;
      if (!refreshEstimateFromBreakdown(job)) resetEstimate(job);
      this.notify();
    }
    const sourceDuration = sourceDurationSeconds(job);
    if (sourceDuration <= 0) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: no moving source frames remain.');
    }
    const startImagePath = job.imageEmbedding.startImage
      ? await this.imageStore.validate(job.imageEmbedding.startImage)
      : null;
    const endImagePath = job.imageEmbedding.endImage
      ? await this.imageStore.validate(job.imageEmbedding.endImage)
      : null;
    if (job.imageEmbedding.endImage && !job.imageEmbedding.finalDurationSeconds) {
      throw new Error('IMAGE_FILTER_GRAPH_INVALID: final image duration is invalid.');
    }
    return {
      sourceStartSeconds: job.imageEmbedding.sourceTrimStartSeconds,
      sourceDurationSeconds: sourceDuration,
      sourceHasAudio: job.sourceHasAudio,
      width: dimensions.width,
      height: dimensions.height,
      frameRate,
      imageEmbedding: cloneJobImageEmbedding(job.imageEmbedding)!,
      startImagePath,
      endImagePath
    };
  }

  private hasPrioritizedEstimate() {
    return this.jobs.some(
      candidate =>
        candidate.status === 'queued' &&
        candidate.estimateStatus === 'waiting' &&
        candidate.estimatePriorityOrder !== null
    );
  }

  private async runPrioritizedEstimates() {
    const runPrioritized = this.estimateHooks?.runPrioritized;
    const activity = this.activity;
    const alreadyEstimating =
      activity.kind === 'estimating' ||
      activity.kind === 'encoding-held' ||
      (activity.kind === 'encoding' && activity.estimating);
    if (!runPrioritized || alreadyEstimating || !this.batch || !this.hasPrioritizedEstimate())
      return;
    // An encode whose child has not been spawned yet: starting the handoff now would suspend
    // nothing and the estimates would run against a compression that is about to begin.
    if (activity.kind === 'encoding' && !activity.child) return;
    const pausedChild = activity.kind === 'encoding' ? activity.child : null;
    // Claim the activity before any awaited/notifying work so the `finally` below always
    // resets it; a throw here must never strand the queue as running or leave `pausedChild`
    // suspended.
    const wasEncoding = this.current.kind === 'encoding';
    if (this.current.kind === 'encoding') this.current = { ...this.current, estimating: true };
    else if (this.current.kind === 'idle') this.current = { kind: 'estimating' };
    try {
      if (pausedChild) {
        if (this.holdForEstimates(pausedChild)) {
          // `holdForEstimates` moved the activity into `encoding-held` itself — the hold and
          // the record of it are the same write.
        } else if (this.pauseSupported()) {
          // The pause signal could not be delivered (the process is likely
          // already gone); leave the handoff to the next scheduling pass.
          return;
        }
        // A platform that cannot pause, or whose pause mechanism is currently
        // unavailable, falls through: prioritized estimates simply run
        // alongside the active compression. Windows normally pauses through
        // the resident NtSuspendProcess helper.
      }
      this.notify();
      let processed: boolean;
      do {
        processed = await runPrioritized();
      } while (
        processed &&
        this.hasPrioritizedEstimate() &&
        (!this.compressionActive() || !this.pauseSupported())
      );
    } catch {
      // A failed handoff must never leave the compression process suspended.
    } finally {
      // Unconditional, where it used to depend on the child still matching. That condition
      // is A5: if the encode's `finally` had cleared the child while this loop was unwinding,
      // the hold was never released and the token was overwritten by the next holder. The
      // token now lives in the held variant, so releasing it is simply leaving that variant.
      this.releaseEstimateHold();
      if (this.current.kind === 'encoding') this.current = { ...this.current, estimating: false };
      else if (this.current.kind === 'estimating') this.current = { kind: 'idle' };
      if (!wasEncoding && this.current.kind === 'idle') queueMicrotask(() => void this.pump());
      this.notify();
    }
  }

  private run(
    job: CompressionJob,
    fallback: boolean,
    embedding: EncodeEmbeddingOptions | undefined
  ) {
    if (job.startedAt === null) {
      job.startedAt = Date.now();
      // A fresh run is never paused, whatever an earlier one left behind.
      job.paused = false;
      job.pausedAt = null;
      job.pausedTotalMs = 0;
      this.notify();
    }
    const operation = encodeVideo(
      job.inputPath,
      job.outputPath,
      outputDurationSeconds(job),
      job.encoding,
      fallback,
      value => {
        job.progress = value;
        this.notifyProgress();
      },
      embedding,
      this.power,
      // A held final image is built in three passes; a stop has to reach whichever is running.
      child => {
        if (this.current.kind === 'encoding') this.setActivity({ ...this.current, child });
      }
    );
    // Attached to the activity that already exists for this job. Reaching here with anything
    // other than an encode would mean `run()` was called outside the guarded region, and
    // hanging a child off an unrelated activity is how it would be lost.
    if (this.current.kind === 'encoding')
      this.setActivity({ ...this.current, child: operation.child });
    void this.runPrioritizedEstimates();
    return operation.done;
  }
}

function cloneJob(job: CompressionJob): CompressionJob {
  return {
    ...job,
    encoding: { ...job.encoding },
    imageEmbedding: cloneJobImageEmbedding(job.imageEmbedding),
    estimateProgress: job.estimateProgress ? { ...job.estimateProgress } : null,
    estimateBreakdown: job.estimateBreakdown ? { ...job.estimateBreakdown } : null
  };
}

function jobImages(job: CompressionJob) {
  return [job.imageEmbedding?.startImage ?? null, job.imageEmbedding?.endImage ?? null].filter(
    (image): image is ImageAsset => Boolean(image)
  );
}

function resetEstimate(job: CompressionJob) {
  job.estimateStatus = 'waiting';
  job.estimatedOutputBytes = null;
  job.estimatedSavingPercent = null;
  job.estimateRangeMinBytes = null;
  job.estimateRangeMaxBytes = null;
  job.estimateProgress = null;
  job.estimateError = null;
  job.estimateKey = null;
  job.estimatePriorityOrder = null;
  job.estimateBreakdown = null;
}

function friendlyError(stderr: string) {
  if (/no space left on device/i.test(stderr)) return 'There is not enough free disk space.';
  if (/permission denied|read-only file system/i.test(stderr)) {
    return 'The destination folder is not writable.';
  }
  if (/invalid data found|could not find codec parameters/i.test(stderr)) {
    return 'This video format is not supported or the file is damaged.';
  }
  if (
    /concat input.*parameters do not match|failed to configure output pad|pixel format/i.test(
      stderr
    )
  ) {
    return 'The images could not be adapted to this video.';
  }
  if (/error initializing complex filters|invalid argument/i.test(stderr)) {
    return 'The image filter graph could not be created.';
  }
  return 'FFmpeg could not compress this video.';
}

function validSourceMedia(media: MediaInfo) {
  return Boolean(media.width && media.height && media.duration);
}

/**
 * Codecs that already compress better than the H.264 target.
 *
 * Re-encoding one of these to H.264 needs roughly twice the bitrate for the
 * same picture. That is a property of the formats, not a defect — but it is
 * invisible to someone who sees a button marked "compress" and reasonably
 * expects the number to go down.
 */
const MORE_EFFICIENT_THAN_TARGET = new Set(['hevc', 'h265', 'av1', 'vp9']);

/**
 * Whether this job is likely to grow, judged from the probe alone.
 *
 * Deliberately cheap and deliberately early. The estimate answers this properly
 * and takes long enough on a large file that people start the run before it
 * lands — which is exactly what happened to the user who reported a 227 MB
 * video coming back at 500 MB.
 */
function growthRiskFor(job: CompressionJob): CompressionJob['growthRisk'] {
  const codec = job.sourceCodec?.toLowerCase() ?? '';
  if (MORE_EFFICIENT_THAN_TARGET.has(codec)) return 'codec';
  const target = job.encoding.rateControl === 'bitrate' ? job.encoding.videoBitrateKbps : null;
  const source = job.sourceBitrate ? Math.round(job.sourceBitrate / 1000) : null;
  if (target && source && target >= source) return 'bitrate';
  return undefined;
}

function applySourceMedia(job: CompressionJob, media: MediaInfo) {
  job.durationSeconds = media.duration;
  job.sourceWidth = media.width;
  job.sourceHeight = media.height;
  job.sourceFrameRate = media.frameRate;
  job.sourceBitrate = media.bitrate;
  job.sourceCodec = media.codec;
  job.sourceHasAudio = media.hasAudio;
  job.sourceAudioBitrate = media.audioBitrate;
  job.sourceAudioSampleRate = media.audioSampleRate;
  job.sourceAudioChannels = media.audioChannels;
  job.sourceAudioLayout = media.audioLayout;
  // Known now, from the probe — not in several minutes, from the estimate.
  job.growthRisk = growthRiskFor(job);
  job.progress = 0;
}

function runtimeRecoveryDetails(error: MediaToolUnavailableError, phase: RuntimeRecoveryPhase) {
  return JSON.stringify({
    code: error.code,
    phase,
    tool: error.tool,
    causeCode: error.causeCode
  });
}

function parseRuntimeRecovery(value: string | null): {
  phase: RuntimeRecoveryPhase;
  tool: MediaToolName;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const phase = parsed.phase;
    const tool = parsed.tool;
    if (
      parsed.code === 'MEDIA_TOOL_UNAVAILABLE' &&
      (phase === 'input-analysis' || phase === 'encoding' || phase === 'output-validation') &&
      (tool === 'ffmpeg' || tool === 'ffprobe')
    ) {
      return { phase, tool };
    }
  } catch {
    // Older free-text errors are not automatic recovery markers.
  }
  return null;
}

function processingError(error: unknown) {
  if (error instanceof ImageAssetError) {
    return error.code === 'IMAGE_DAMAGED'
      ? 'An image is damaged or could not be decoded.'
      : 'An image is no longer available to the local agent.';
  }
  if (error instanceof OutputValidationError) {
    return 'The completed file did not pass FFprobe validation.';
  }
  if (error instanceof Error && /IMAGE_FILTER_GRAPH_INVALID/.test(error.message)) {
    return 'The image filter graph could not be created.';
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return 'The source file is no longer available.';
  }
  return 'The file could not be processed.';
}

class OutputValidationError extends Error {}

/** Whether this job's final image is held long enough to be built as its own segment. */
function heldFinalImage(job: CompressionJob): boolean {
  const embedding = job.imageEmbedding;
  if (!embedding) return false;
  return heldFinalImageSeconds(embedding, outputFrameRate(job)) !== null;
}

function validateCompletedOutput(job: CompressionJob, media: MediaInfo) {
  const errors: string[] = [];
  if (!media.formatName || !/(?:^|,)mp4(?:,|$)|(?:^|,)mov(?:,|$)/.test(media.formatName)) {
    errors.push(`format=${media.formatName ?? 'missing'}`);
  }
  if (!media.width || !media.height) errors.push('dimensions=missing');
  if (!media.duration) errors.push('duration=missing');
  if (!media.codec) errors.push('codec=missing');
  if (errors.length) throw new OutputValidationError(errors.join('; '));
  if (job.imageEmbedding) validateEmbeddedOutput(job, media);
}

function validateEmbeddedOutput(job: CompressionJob, media: MediaInfo) {
  const dimensions = outputDimensions(job);
  const frameRate = outputFrameRate(job);
  const duration = outputDurationSeconds(job);
  const errors: string[] = [];
  if (!media.formatName || !/(?:^|,)mp4(?:,|$)|(?:^|,)mov(?:,|$)/.test(media.formatName)) {
    errors.push(`format=${media.formatName ?? 'missing'}`);
  }
  if (!dimensions || media.width !== dimensions.width || media.height !== dimensions.height) {
    errors.push(
      `dimensions=${media.width ?? 'missing'}x${media.height ?? 'missing'}, expected=${dimensions?.width ?? 'missing'}x${dimensions?.height ?? 'missing'}`
    );
  }
  /*
   * The frame rate is judged on the moving part, not on the average.
   *
   * A final image held for half an hour is a few hundred pictures spread across it — that is
   * the whole reason such a file encodes in a minute instead of twelve. Averaged over the
   * finished file that reads as two frames a second, and this check called a correct output
   * broken. `nominalFrameRate` is what the container declares the stream to be, which is the
   * body's rate and the number this was ever meant to test.
   */
  const measured = heldFinalImage(job)
    ? (media.nominalFrameRate ?? media.frameRate)
    : media.frameRate;
  if (!measured || Math.abs(measured - frameRate) > Math.max(0.03, frameRate * 0.001)) {
    errors.push(`fps=${measured ?? 'missing'}, expected=${frameRate}`);
  }
  const durationTolerance = Math.max(0.2, 2 / frameRate);
  if (!media.duration || Math.abs(media.duration - duration) > durationTolerance) {
    errors.push(`duration=${media.duration ?? 'missing'}, expected=${duration}`);
  }
  if (!media.hasAudio) errors.push('audio=missing');
  if (
    media.audioDuration &&
    media.videoDuration &&
    Math.abs(media.audioDuration - media.videoDuration) > durationTolerance
  ) {
    errors.push(`audio/video duration mismatch=${media.audioDuration}/${media.videoDuration}`);
  }
  if (errors.length) throw new OutputValidationError(errors.join('; '));
}

function isCancelled(job: CompressionJob) {
  return job.status === 'cancelled';
}

/**
 * Whether the encoder is gone without Node having noticed.
 *
 * `exitCode` or `signalCode` being set means Node reaped it and the encode's own teardown
 * is already running — that path settles the job correctly and nothing here should touch
 * it. What this is looking for is the other case: a handle that still reads as live for a
 * process the operating system no longer has.
 */
function encoderVanished(child: ChildProcessWithoutNullStreams): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (typeof child.pid !== 'number') return true;
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(child.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function finishTimestamp(job: CompressionJob) {
  return Math.max(Date.now(), job.startedAt ?? 0);
}

async function cleanupImportedSource(job: CompressionJob) {
  if (job.sourceKind !== 'uploaded') return;
  await unlink(job.inputPath).catch(() => {});
}

export function jobEstimateIsCurrent(job: CompressionJob) {
  return (
    job.estimateStatus === 'estimated' &&
    job.estimateKey === jobConfigurationKey(job.encoding, job.imageEmbedding)
  );
}

function cloneSettings(settings: AgentSettings): AgentSettings {
  return { ...settings, imageEmbedding: cloneImageEmbeddingSettings(settings.imageEmbedding) };
}

function cloneImageEmbeddingSettings(settings: AgentSettings['imageEmbedding']) {
  return {
    ...settings,
    startImages: settings.startImages.map(asset => ({ ...asset })),
    endImages: settings.endImages.map(asset => ({ ...asset }))
  };
}

function cloneJobImageEmbedding(settings: CompressionJob['imageEmbedding']) {
  return settings
    ? {
        ...settings,
        startImage: settings.startImage ? { ...settings.startImage } : null,
        endImage: settings.endImage ? { ...settings.endImage } : null
      }
    : null;
}

function imageEmbeddingSettingsKey(settings: AgentSettings['imageEmbedding']) {
  return JSON.stringify([
    settings.enabled,
    settings.startImages.map(asset => asset.id),
    settings.endImages.map(asset => asset.id),
    settings.replaceExisting,
    settings.finalDurationMode,
    settings.customFinalDurationSeconds,
    settings.startDurationMode,
    settings.customStartDurationMs,
    settings.fitMode
  ]);
}
