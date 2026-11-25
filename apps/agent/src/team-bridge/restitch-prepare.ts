/**
 * Looking at a space's videos once, so that no delivery has to.
 *
 * This is the button. It fetches each material, reads its keyframe index and searches it for
 * screens already stitched on, and reports what it found. That is six to fourteen seconds a
 * file, measured, and it depends on nothing but the file's own bytes — which is exactly why it
 * is worth paying once and never again.
 *
 * Three rules it keeps:
 *
 * - **One at a time.** The inspection spawns a media tool per material, and the power governor
 *   already assumes one heavy process. A space of fifty videos run in parallel would be fifty
 *   probes fighting over the same machine.
 * - **It writes nothing to the cloud.** Findings are kept here and read back by the page, which
 *   stores them. The bridge has never talked to Supabase and this is not the reason to start.
 * - **Findings do not go on the event channel.** That channel is broadcast and deliberately
 *   content-free — an operation id, a stage, a number. A finding carries a file's name and
 *   shape, so the channel gets the count and `report()` gets the substance.
 *
 * The shared silence is built first, before any material. It costs eleven to nineteen seconds
 * once per machine, and paying it here rather than inside the first delivery is most of what
 * separates a prepared space from an unprepared one.
 *
 * 071: progress inside a file. Every video is read in full from the drive before it can be
 * looked at, and a long one sat as «1 of 256» for minutes. The report says which step the current
 * file is on (`downloading` → `converting`/`verifying` → `inspecting`) and how many of its bytes
 * have arrived. Numbers only: the event channel still carries a stage and a percentage, and the
 * bytes ride on the report beside the findings.
 */

import {
  RESTITCH_DETECTOR_VERSION,
  hevcRestitchSource,
  stitchUnsupportedReason,
  type MaterialRestitchPrep
} from '@video-compressor/shared';
import { detectStitching } from '../stitcher/plan.js';
import { probeSource } from '../stitcher/probe.js';
import { ensureSilenceBank } from '../stitcher/silence.js';
import type { TeamOperationEvents } from './events.js';
import type { DownloadedTeamSource, TeamSourceDownloadRequest } from './transfer.js';
import type { TeamTransferGrant } from '@video-compressor/shared';
import { HevcCompatibility } from '../stitcher/hevc-normalize.js';

/** How many finished runs stay readable, so a reload can still collect the tail. */
const REMEMBERED_RUNS = 4;
/**
 * The share of a file's progress its download takes. Reading the file from the drive is most of
 * the wait for an ordinary video; a HEVC conversion, when there is one, fills the rest.
 */
const DOWNLOAD_SHARE = 0.5;

export interface RestitchPrepareMaterial {
  materialId: string;
  driveVersion: string;
  fileName: string;
  transferGrant: TeamTransferGrant;
}

export interface RestitchPrepareRequest {
  operationId: string;
  teamId: string;
  transferUrl: string;
  materials: RestitchPrepareMaterial[];
  audio?: { sampleRate: number; channels: number } | null;
}

export type RestitchPrepareState = 'inspecting' | 'prepared' | 'unsupported' | 'failed';

export interface RestitchPrepareFinding {
  materialId: string;
  state: RestitchPrepareState;
  prep: MaterialRestitchPrep | null;
  reason: string | null;
}

export type RestitchPreparePhase = 'downloading' | 'inspecting' | 'converting' | 'verifying';

export interface RestitchPrepareReport {
  operationId: string;
  state: 'running' | 'finished' | 'canceled';
  done: number;
  total: number;
  /** What is being looked at right now, so a row can say so rather than a page-wide spinner. */
  current: string | null;
  phase: RestitchPreparePhase | null;
  currentProgress: number;
  /** 071: how much of the current file has arrived, and of how much (null until the drive says). */
  currentBytes: number;
  currentBytesTotal: number | null;
  findings: RestitchPrepareFinding[];
}

export interface RestitchPrepareTransfer {
  downloadSource(
    request: TeamSourceDownloadRequest,
    signal: AbortSignal
  ): Promise<DownloadedTeamSource>;
}

export interface RestitchPrepareBridgeOptions {
  transfer: RestitchPrepareTransfer;
  /** The same coarse progress every other team operation publishes. */
  events?: Pick<TeamOperationEvents, 'update'>;
  compatibility?: Pick<HevcCompatibility, 'prepare'>;
}

interface PrepareRun {
  controller: AbortController;
  active: boolean;
  completion: Promise<void>;
  total: number;
  done: number;
  current: string | null;
  state: RestitchPrepareReport['state'];
  findings: Map<string, RestitchPrepareFinding>;
  currentProgress: number;
  phase: RestitchPrepareReport['phase'];
  currentBytes: number;
  currentBytesTotal: number | null;
  /** The last percentage and stage put on the event channel, so a chunk does not re-send them. */
  published: string | null;
}

export class RestitchPrepareBridge {
  readonly #transfer: RestitchPrepareTransfer;
  readonly #events: RestitchPrepareBridgeOptions['events'];
  readonly #runs = new Map<string, PrepareRun>();
  #closing = false;
  readonly #compatibility: Pick<HevcCompatibility, 'prepare'>;

  constructor(options: RestitchPrepareBridgeOptions) {
    this.#transfer = options.transfer;
    this.#events = options.events;
    this.#compatibility = options.compatibility ?? new HevcCompatibility();
  }

  /**
   * Starts a run and returns at once.
   *
   * The caller reads progress rather than holding a request open: preparing fifty videos
   * outlives any page's patience for a pending fetch, and a reload must not abandon it.
   */
  start(request: RestitchPrepareRequest): void {
    const existing = this.#runs.get(request.operationId);
    if (this.#closing || existing?.active) throw new Error('WRONG_STATE');
    const run: PrepareRun = {
      controller: new AbortController(),
      active: true,
      completion: Promise.resolve(),
      total: request.materials.length,
      done: 0,
      current: null,
      state: 'running',
      findings: new Map(),
      currentProgress: 0,
      phase: null,
      currentBytes: 0,
      currentBytesTotal: null,
      published: null
    };
    this.#remember(request.operationId, run);
    // Own completion before publishing or starting I/O. Abort requests and UI
    // states alone cannot prove that transport, children and cleanup have stopped.
    run.completion = Promise.resolve()
      .then(() => this.#run(request, run))
      .finally(() => {
        if (run.state === 'running') run.state = 'finished';
        run.active = false;
        run.current = null;
        run.phase = null;
        run.currentProgress = 0;
        run.currentBytes = 0;
        run.currentBytesTotal = null;
        this.#publish(request.operationId, run);
        this.#prune();
      });
    this.#publish(request.operationId, run);
  }

  /** What the run has found so far, including after it has finished. */
  report(operationId: string): RestitchPrepareReport | null {
    const run = this.#runs.get(operationId);
    if (!run) return null;
    return {
      operationId,
      state: run.active && run.state !== 'running' ? 'running' : run.state,
      done: run.done,
      total: run.total,
      current: run.current,
      phase: run.phase,
      currentProgress: run.currentProgress,
      currentBytes: run.currentBytes,
      currentBytesTotal: run.currentBytesTotal,
      findings: [...run.findings.values()]
    };
  }

  cancel(operationId: string): boolean {
    const run = this.#runs.get(operationId);
    if (!run || run.state !== 'running') return false;
    run.state = 'canceled';
    run.controller.abort();
    return true;
  }

  busy(): boolean {
    for (const run of this.#runs.values()) {
      if (run.active) return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    const runs = [...this.#runs.values()];
    for (const run of runs) {
      if (run.state === 'running') run.state = 'canceled';
      run.controller.abort();
    }
    await Promise.allSettled(runs.map(run => run.completion));
    this.#runs.clear();
  }

  #remember(operationId: string, run: PrepareRun): void {
    this.#runs.set(operationId, run);
    this.#prune();
  }

  #prune(): void {
    // A finished run stays readable for a while so a reloaded page can still collect its tail,
    // but the map is not a log: the oldest finished one is dropped once there are enough.
    while (this.#runs.size > REMEMBERED_RUNS) {
      const oldest = [...this.#runs.entries()].find(([, value]) => !value.active);
      if (!oldest) break;
      this.#runs.delete(oldest[0]);
    }
  }

  #publish(operationId: string, run: PrepareRun): void {
    // Deliberately only the shape of progress: how far along, and whether it is still going.
    // What was found stays here, where a broadcast cannot reach it.
    const state = run.active ? 'running' : run.state === 'canceled' ? 'canceled' : 'succeeded';
    const stage = run.active
      ? run.phase === 'downloading'
        ? 'downloading'
        : 'processing'
      : state === 'canceled'
        ? 'canceled'
        : 'completed';
    const progress =
      run.total > 0 ? Math.round(((run.done + run.currentProgress) / run.total) * 100) : 100;
    // A file arrives in hundreds of chunks; the channel hears only what changes its numbers.
    const key = `${state}:${stage}:${progress}`;
    if (key === run.published) return;
    run.published = key;
    try {
      this.#events?.update(operationId, { state, stage, progress });
    } catch {
      // A diagnostic sink failure cannot strand work or prevent quiescence.
    }
  }

  async #run(request: RestitchPrepareRequest, run: PrepareRun): Promise<void> {
    const signal = run.controller.signal;
    if (signal.aborted) return;
    // Once, before anything else: every screen this space ever builds needs it, and building
    // it here is the difference between a first delivery of four seconds and one of twenty.
    if (request.audio) {
      await ensureSilenceBank({
        sampleRate: request.audio.sampleRate,
        channels: request.audio.channels,
        bitrateKbps: 96,
        neededSeconds: 0,
        signal
      }).catch(() => undefined);
    }

    for (const material of request.materials) {
      if (signal.aborted) return;
      run.current = material.materialId;
      run.currentProgress = 0;
      run.currentBytes = 0;
      run.currentBytesTotal = null;
      run.phase = 'downloading';
      run.findings.set(material.materialId, {
        materialId: material.materialId,
        state: 'inspecting',
        prep: null,
        reason: null
      });
      this.#publish(request.operationId, run);

      const finding = await this.#inspect(
        request,
        material,
        signal,
        fraction => {
          run.currentProgress = Math.max(run.currentProgress, Math.min(0.95, fraction));
          this.#publish(request.operationId, run);
        },
        phase => {
          run.phase = phase;
          this.#publish(request.operationId, run);
        },
        (bytes, total) => {
          run.currentBytes = bytes;
          run.currentBytesTotal = total;
          if (total && total > 0)
            run.currentProgress = Math.max(run.currentProgress, (bytes / total) * DOWNLOAD_SHARE);
          this.#publish(request.operationId, run);
        }
      );
      run.done += 1;
      run.currentProgress = 0;
      run.currentBytes = 0;
      run.currentBytesTotal = null;
      run.findings.set(material.materialId, finding);
      // Whatever finished stays found: a stop keeps what it has rather than discarding a run's
      // worth of work because the last material was interrupted.
      this.#publish(request.operationId, run);
      if (signal.aborted) return;
    }
  }

  async #inspect(
    request: RestitchPrepareRequest,
    material: RestitchPrepareMaterial,
    signal: AbortSignal,
    progress: (fraction: number) => void,
    phase: (value: RestitchPrepareReport['phase']) => void,
    bytes: (written: number, total: number | null) => void
  ): Promise<RestitchPrepareFinding> {
    let source: DownloadedTeamSource | null = null;
    try {
      source = await this.#transfer.downloadSource(
        {
          operationId: `${request.operationId}:${material.materialId}`,
          transferUrl: request.transferUrl,
          grant: material.transferGrant,
          onProgress: (written, total) => {
            try {
              bytes(written, total);
            } catch {
              // Progress is a courtesy; it never stops the transfer.
            }
          }
        },
        signal
      );
      phase('inspecting');
      const probed = await probeSource(source.file, { signal });
      if (!probed.ok) return unsupported(material, 'unreadable');
      const hevc = hevcRestitchSource(probed.value);
      const refusal = hevc ? null : stitchUnsupportedReason(probed.value);
      // A refusal is recorded rather than dropped: knowing a file cannot be served is worth as
      // much as knowing where its screens are, and it stops the answer being recomputed.
      if (refusal) return unsupported(material, refusal);

      const normalized = hevc
        ? await this.#compatibility.prepare({
            sourceFile: source.file,
            workspace: source.workspace,
            sourceIdentity: source.sourceChecksum
              ? `md5:${source.sourceChecksum}:${source.sizeBytes}`
              : null,
            signal,
            runId: request.operationId,
            onProgress: fraction => progress(DOWNLOAD_SHARE + fraction * (0.95 - DOWNLOAD_SHARE)),
            onStage: phase
          })
        : null;
      phase('inspecting');
      const detected = await detectStitching(normalized?.profile ?? probed.value, signal);
      return {
        materialId: material.materialId,
        state: 'prepared',
        reason: null,
        prep: {
          materialId: material.materialId,
          driveVersion: material.driveVersion,
          // Stamped by whoever did the reading. The agent ships separately from the web, so a
          // member running an older one must not have its findings passed off as this build's.
          detectorVersion: RESTITCH_DETECTOR_VERSION,
          detectedStartSeconds: detected.startSeconds,
          detectedEndSeconds: detected.endSeconds,
          // The path belongs to this machine's copy and is replaced by whoever uses the
          // record; everything else in the profile travels.
          profile: probed.value,
          unsupportedReason: null,
          preparedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      return {
        materialId: material.materialId,
        state: 'failed',
        prep: null,
        reason: error instanceof Error ? error.message : 'PREPARE_FAILED'
      };
    } finally {
      // The copy exists only to be read. Nothing here writes to it, and it never outlives the
      // material it describes.
      await source?.cleanup().catch(() => undefined);
    }
  }
}

function unsupported(material: RestitchPrepareMaterial, reason: string): RestitchPrepareFinding {
  return {
    materialId: material.materialId,
    state: 'unsupported',
    reason,
    // Recorded with no profile: there is nothing to cut, and the record exists only so the
    // same refusal is not re-derived on every download of the same file.
    prep: {
      materialId: material.materialId,
      driveVersion: material.driveVersion,
      detectorVersion: RESTITCH_DETECTOR_VERSION,
      detectedStartSeconds: 0,
      detectedEndSeconds: 0,
      profile: null,
      unsupportedReason: reason,
      preparedAt: new Date().toISOString()
    }
  };
}
