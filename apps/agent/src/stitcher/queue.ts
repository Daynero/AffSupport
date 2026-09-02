/**
 * One stitch at a time, from a plan to a verified file.
 *
 * The queue is deliberately small: the pipeline it drives is six short steps, each of which
 * is a pure argument array run through the shared spawn seam. What it owns is the parts that
 * cannot live in a pure function — the order, the live child a cancellation has to reach,
 * the temp directory that must disappear whatever happens, and the rule that a file is never
 * handed over before it has been checked.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rename, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  STITCH_LIFECYCLE,
  defaultStitchSettings,
  planStitch,
  type DetectedStitching,
  type SourceProfile,
  type StitchDestination,
  type StitchJob,
  type StitchPlan,
  type StitchOperation,
  type StitchScreens,
  type StitchSettings,
  type StitchSettingsPatch,
  type StitchStage,
  type StitchStatus,
  type StitcherState
} from '@video-compressor/shared';
import { nextOutputPath } from '../files/paths.js';
import { decideTransition } from '../queue/transitions.js';
import { PreparedBodyCache } from './body-cache.js';
import { runStitchPipeline, type StitchPipeline } from './pipeline.js';
import { probeSource } from './probe.js';
import { detectStitching } from './plan.js';

/** The historic default, in the compressor's own idiom, when no suffix is given. */
const DEFAULT_SUFFIX = '_stitched';

/**
 * A file waiting in the list.
 *
 * Only what one cheap `ffprobe` of the container answers — enough to show the row and to
 * refuse a file the fast path cannot serve. Where its keyframes are, and what is already
 * stitched onto it, are questions a run asks.
 */
export interface StitchCandidate {
  profile: SourceProfile;
}

/** What starting a row needs, decided at the moment the user presses the button. */
export interface StitchRunRequest {
  profile: SourceProfile;
  /** What a previous run found, when there was one. Otherwise the run looks for itself. */
  detected: DetectedStitching | null;
  screens: StitchScreens;
  operation: StitchOperation;
  destination: StitchDestination;
  outputSuffix: string;
}

/** A run's own view of its source, once the inspecting stage has finished with it. */
interface Inspected {
  profile: SourceProfile;
  detected: DetectedStitching;
  plan: StitchPlan;
}

export interface StitchQueueDeps {
  /** Resolves a stored screen image to a readable path, or null when it is gone. */
  imagePathFor: (id: string) => Promise<string | null>;
  onChange: () => void;
  settings?: StitchSettings;
  jobs?: StitchJob[];
  bodies?: PreparedBodyCache;
  /** The shared CPU budget's current thread count, read live. */
  threads?: () => number | null;
  /**
   * The media half of a run. Injected so the queue's own guarantees — one at a time, a
   * failure that does not stop a batch, a stop that leaves nothing behind — can be proven
   * without a media engine.
   */
  pipeline?: StitchPipeline;
  /**
   * The two reads a run makes of its source before it can plan: the full profile, keyframes
   * included, and the screens already on the file. Injected for the same reason the pipeline
   * is — neither is needed to prove anything the queue itself promises.
   */
  probe?: (
    path: string,
    signal: AbortSignal
  ) => Promise<{ ok: true; value: SourceProfile } | { ok: false; error: string }>;
  detect?: (profile: SourceProfile, signal: AbortSignal) => Promise<DetectedStitching>;
  save?: (state: { settings: StitchSettings; jobs: StitchJob[] }) => void;
}

interface RunningJob {
  controller: AbortController;
  child: ChildProcess | null;
}

export class StitchQueue {
  private readonly deps: StitchQueueDeps;
  private readonly bodies: PreparedBodyCache;
  private settings: StitchSettings;
  private jobs: StitchJob[];
  private readonly pipeline: StitchPipeline;
  private readonly probeSource: NonNullable<StitchQueueDeps['probe']>;
  private readonly detectStitching: NonNullable<StitchQueueDeps['detect']>;
  private readonly running = new Map<string, RunningJob>();
  /** Source profiles for the rows in the list; not persisted, re-probed after a restart. */
  private readonly profiles = new Map<string, SourceProfile>();
  private pump: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(deps: StitchQueueDeps) {
    this.deps = deps;
    this.bodies = deps.bodies ?? new PreparedBodyCache();
    this.pipeline = deps.pipeline ?? runStitchPipeline;
    this.probeSource = deps.probe ?? defaultProbe;
    this.detectStitching = deps.detect ?? defaultDetect;
    this.settings = deps.settings ?? defaultStitchSettings();
    // A run cannot survive a restart — its temp directory is gone — so anything found
    // mid-flight is reported as interrupted work rather than silently resurrected.
    this.jobs = (deps.jobs ?? []).map(job =>
      job.status === 'running' || job.status === 'queued'
        ? { ...job, status: 'failed' as const, error: 'STITCH_INTERRUPTED' }
        : job
    );
  }

  state(): StitcherState {
    return { settings: this.settings, jobs: this.jobs, busy: this.running.size > 0 };
  }

  workActive(): boolean {
    return this.running.size > 0;
  }

  currentSettings(): StitchSettings {
    return this.settings;
  }

  updateSettings(patch: StitchSettingsPatch): StitchSettings {
    this.settings = { ...this.settings, ...patch };
    this.changed();
    return this.settings;
  }

  /**
   * Puts files in the list, ready and waiting — the compressor's `add`.
   *
   * Nothing runs. A row exists so it can be seen, selected and started, and so the same file
   * added twice is one row rather than two.
   */
  add(candidates: readonly StitchCandidate[]): StitchJob[] {
    const added: StitchJob[] = [];
    for (const candidate of candidates) {
      const existing = this.jobs.find(
        job => job.sourcePath === candidate.profile.path && job.status === 'ready'
      );
      if (existing) continue;
      const job: StitchJob = {
        id: randomUUID(),
        sourcePath: candidate.profile.path,
        sourceName: path.basename(candidate.profile.path),
        source: {
          sizeBytes: candidate.profile.sizeBytes,
          durationSeconds: candidate.profile.durationSeconds,
          width: candidate.profile.width,
          height: candidate.profile.height,
          frameRate: candidate.profile.frameRate,
          codec: candidate.profile.videoCodec
        },
        result: null,
        detected: null,
        plan: null,
        operation: 'restitch',
        destination: this.settings.destination,
        outputSuffix: this.settings.outputSuffix,
        status: 'ready',
        stage: null,
        outputPath: null,
        elapsedMs: null,
        error: null,
        verification: null,
        createdAt: new Date().toISOString()
      };
      this.profiles.set(job.id, candidate.profile);
      this.jobs = [...this.jobs, job];
      added.push(job);
    }
    if (added.length) this.changed();
    return added;
  }

  /** The profile a row was added with, so starting it needs no second probe. */
  profileOf(id: string): SourceProfile | null {
    return this.profiles.get(id) ?? null;
  }

  /**
   * Starts rows, one at a time.
   *
   * A finished row is returned to `ready` first — the compressor's rule, and the point at
   * which the previous result is cleared rather than lingering beside a new one.
   */
  start(id: string, request: StitchRunRequest): boolean {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status === 'queued' || job.status === 'running') return false;
    if (job.status !== 'ready') {
      if (
        !this.transition(id, 'ready', {
          outputPath: null,
          result: null,
          error: null,
          verification: null,
          elapsedMs: null
        })
      )
        return false;
    }
    if (!this.transition(id, 'queued', { plan: null, operation: request.operation })) return false;
    this.patch(id, {
      destination: request.destination,
      outputSuffix: request.outputSuffix
    });
    // Serialised on purpose: one heavy child at a time is the guarantee the whole power
    // budget rests on, and a batch of twenty photos must not become twenty encoders.
    this.pump = this.pump.then(() => this.run(id, request)).catch(() => {});
    return true;
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) return false;
    const live = this.running.get(id);
    if (live) {
      live.controller.abort();
      return true;
    }
    /* A queued row that never started is marked stopped, not returned to the list — the
       compressor's rule, and the reason stop-all and the batch counters can say what
       happened to it. It carries no error: it reads as "not stitched yet". */
    if (job.status !== 'queued') return false;
    this.transition(id, 'cancelled', { stage: null, error: null });
    return true;
  }

  /** Forgets one settled row. A run in flight is never removed from under itself. */
  remove(id: string): boolean {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status === 'queued' || job.status === 'running') return false;
    this.jobs = this.jobs.filter(candidate => candidate.id !== id);
    this.profiles.delete(id);
    this.changed();
    return true;
  }

  /** Forgets every settled row, leaving whatever is still queued or running. */
  clearSettled(): void {
    const kept = this.jobs.filter(
      job => job.status === 'queued' || job.status === 'running' || job.status === 'ready'
    );
    for (const job of this.jobs) if (!kept.includes(job)) this.profiles.delete(job.id);
    this.jobs = kept;
    this.changed();
  }

  async cancelAll(): Promise<number> {
    const stoppable = this.jobs.filter(job => job.status === 'queued' || job.status === 'running');
    let stopped = 0;
    for (const job of stoppable) if (await this.cancel(job.id)) stopped += 1;
    return stopped;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.cancelAll();
    await this.pump.catch(() => {});
  }

  private changed(): void {
    this.deps.save?.({ settings: this.settings, jobs: this.jobs });
    this.deps.onChange();
  }

  private patch(id: string, changes: Partial<StitchJob>): void {
    this.jobs = this.jobs.map(job => (job.id === id ? { ...job, ...changes } : job));
    this.changed();
  }

  /**
   * The one place a status changes, so the declared lifecycle is what actually happens.
   * A refused move leaves the job exactly as it was.
   */
  private transition(id: string, next: StitchStatus, changes: Partial<StitchJob> = {}): boolean {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) return false;
    if (!decideTransition(STITCH_LIFECYCLE, job.status, next)) return false;
    this.patch(id, { ...changes, status: next });
    return true;
  }

  private stage(id: string, stage: StitchStage): void {
    this.patch(id, { stage });
  }

  private async run(id: string, request: StitchRunRequest): Promise<void> {
    const queued = this.jobs.find(job => job.id === id);
    if (!queued || queued.status !== 'queued' || this.shuttingDown) return;

    const controller = new AbortController();
    const live: RunningJob = { controller, child: null };
    this.running.set(id, live);
    if (!this.transition(id, 'running', { stage: 'inspecting' })) {
      this.running.delete(id);
      return;
    }

    const startedAt = Date.now();
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'soty-stitch-'));
    const onChild = (child: ChildProcess) => {
      live.child = child;
    };
    const run = { signal: controller.signal, onChild };

    try {
      const outcome = await this.produce(id, request, workDir, run);
      const elapsedMs = Date.now() - startedAt;
      if (outcome.ok) {
        this.transition(id, 'done', {
          stage: null,
          outputPath: outcome.outputPath,
          verification: outcome.verification,
          result: await measureResult(
            outcome.outputPath,
            outcome.verification,
            outcome.plan,
            outcome.profile
          ),
          elapsedMs,
          error: null
        });
      } else if (controller.signal.aborted || outcome.error === 'STITCH_CANCELLED') {
        this.transition(id, 'cancelled', { stage: null, elapsedMs, error: null });
      } else {
        this.transition(id, 'failed', {
          stage: null,
          elapsedMs,
          error: outcome.error,
          verification: outcome.verification ?? null
        });
      }
    } catch {
      this.transition(id, 'failed', {
        stage: null,
        elapsedMs: Date.now() - startedAt,
        error: 'STITCH_TOOL_FAILED'
      });
    } finally {
      this.running.delete(id);
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async produce(
    id: string,
    request: StitchRunRequest,
    workDir: string,
    run: { signal: AbortSignal; onChild: (child: ChildProcess) => void }
  ): Promise<
    | {
        ok: true;
        outputPath: string;
        verification: StitchJob['verification'];
        plan: StitchPlan;
        profile: SourceProfile;
      }
    | { ok: false; error: string; verification?: StitchJob['verification'] }
  > {
    // A stop can arrive between the job being marked running and the first child being
    // spawned. Starting work that is already cancelled would leave a run to notice the
    // abort somewhere further in, which is exactly where a hang would be hardest to see.
    if (run.signal.aborted) return { ok: false, error: 'STITCH_CANCELLED' };

    const looked = await this.inspect(request, run.signal);
    if (!looked.ok) return looked;
    this.patch(id, { detected: looked.value.detected, plan: looked.value.plan });

    const produced = await this.pipeline({
      request: {
        profile: looked.value.profile,
        plan: looked.value.plan,
        screens: request.screens,
        destination: request.destination,
        outputSuffix: request.outputSuffix
      },
      workDir,
      threads: this.deps.threads?.() ?? null,
      signal: run.signal,
      onChild: run.onChild,
      onStage: stage => this.stage(id, stage),
      imagePathFor: this.deps.imagePathFor,
      bodies: this.bodies
    });
    if (!produced.ok) return produced;

    const installed = await this.install(produced.stagedPath, request);
    if (!installed.ok)
      return { ok: false, error: installed.error, verification: produced.verification };
    return {
      ok: true,
      outputPath: installed.path,
      verification: produced.verification,
      plan: looked.value.plan,
      profile: looked.value.profile
    };
  }

  /**
   * The inspecting stage: complete the source, find what is already on it, and plan.
   *
   * All three used to happen before the row existed, which is why adding a file made the user
   * wait several seconds for a list entry. The profile a row carries comes from one cheap
   * probe of the container; the keyframes and the existing screens are read here, once, by
   * the run that needs them. A repeat brings its own findings and skips the search.
   */
  private async inspect(
    request: StitchRunRequest,
    signal: AbortSignal
  ): Promise<{ ok: true; value: Inspected } | { ok: false; error: string }> {
    let profile = request.profile;
    if (!profile.keyframeTimes.length) {
      const probed = await this.probeSource(profile.path, signal);
      if (!probed.ok) return { ok: false, error: 'STITCH_PATH_INVALID' };
      profile = probed.value;
    }
    if (signal.aborted) return { ok: false, error: 'STITCH_CANCELLED' };
    const detected = request.detected ?? (await this.detectStitching(profile, signal));
    if (signal.aborted) return { ok: false, error: 'STITCH_CANCELLED' };

    const planned = planStitch(profile, detected, request.screens, request.operation);
    // The planner's refusals are the user's own words on the card, not tool failures.
    if (!planned.ok) return { ok: false, error: `STITCH_PLAN_${planned.error.toUpperCase()}` };
    return { ok: true, value: { profile, detected, plan: planned.value } };
  }

  /**
   * Moving the finished file into place.
   *
   * The overwrite path replaces the source only here — after the run succeeded and the probe
   * agreed — so a failure at any earlier point leaves the original exactly as it was.
   */
  private async install(
    staged: string,
    request: StitchRunRequest
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const source = request.profile.path;
    const suffix = request.outputSuffix.trim();
    try {
      if (request.destination.kind === 'overwrite') {
        const parsed = path.parse(source);
        const target = suffix ? path.join(parsed.dir, `${parsed.name}${suffix}.mp4`) : source;
        await moveInto(staged, target);
        if (target !== source) await unlink(source).catch(() => {});
        return { ok: true, path: target };
      }
      const folder = request.destination.kind === 'folder' ? request.destination.path : undefined;
      const target = await nextOutputPath(source, folder, [], false, suffix || DEFAULT_SUFFIX);
      await moveInto(staged, target);
      return { ok: true, path: target };
    } catch {
      return { ok: false, error: 'STITCH_OUTPUT_UNWRITABLE' };
    }
  }
}

/** What the finished file turned out to be, for the card's "after" side. */
async function measureResult(
  outputPath: string,
  verification: StitchJob['verification'],
  plan: StitchPlan,
  profile: SourceProfile
): Promise<StitchJob['result']> {
  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(outputPath)).size;
  } catch {
    // A size we cannot read is reported as unknown rather than as zero bytes of video.
  }
  return {
    sizeBytes,
    durationSeconds: verification?.durationSeconds ?? plan.promisedDurationSeconds,
    width: verification?.width ?? profile.width,
    height: verification?.height ?? profile.height,
    // The body is copied, so the result keeps the source's frame rate and codec by
    // construction; the verification confirms the codec rather than guessing it.
    frameRate: profile.frameRate,
    codec: verification?.videoCodec ?? profile.videoCodec
  };
}

/**
 * A rename where possible, a copy where not.
 *
 * The staging directory is the system temp directory, which on some machines is a different
 * volume from the user's files; `rename` answers EXDEV there, and a tool that failed at the
 * last step because of where the operating system puts temp files would be indefensible.
 */
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(from, to);
    await unlink(from).catch(() => {});
  }
}

/** The real reads, used unless a caller injects its own. */
const defaultProbe: NonNullable<StitchQueueDeps['probe']> = async (input, signal) => {
  const probed = await probeSource(input, { signal });
  return probed.ok ? probed : { ok: false, error: probed.error };
};

const defaultDetect: NonNullable<StitchQueueDeps['detect']> = (profile, signal) =>
  detectStitching(profile, signal);
