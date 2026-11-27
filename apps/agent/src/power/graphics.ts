/**
 * How busy the machine's graphics processor is.
 *
 * The consumption readout used to measure only the CPU, and for years that was the whole
 * story. It stopped being so the moment speech recognition started running on the GPU: a
 * transcription that had the machine on its knees reported **0.4%**, because the process
 * genuinely was not using the CPU. A lever labelled "power" that reads nearly zero while the
 * fans are at full is worse than no reading at all — it tells the owner their setting is
 * working when it is measuring the wrong thing entirely.
 *
 * **`graphicsUtilizationPercent` is the machine's figure, not Soty's**: the whole device's
 * utilisation, which the throttle panel pairs with "is Soty running anything" and labels as
 * the computer's. Soty's own share — what the header's meter shows — comes from the
 * per-client figures further down (`ProcessGraphicsShare`), which Apple silicon keeps.
 *
 * Only Apple Silicon and Intel Macs answer. Elsewhere the reading is absent — and absent is
 * reported as absent, never as zero.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentPlatform } from '../platform/platform.js';
import { consumedPerProcess } from './process-tree.js';

const run = promisify(execFile);

/** The driver publishes this in its performance statistics; the accelerator class holds it. */
const UTILIZATION = /"Device Utilization %"\s*=\s*(\d+)/u;
/** A stuck `ioreg` must not stall a reading that is taken once a second. */
const PROBE_TIMEOUT_MS = 2_000;

export function graphicsProbeSupported(): boolean {
  return currentPlatform() === 'darwin';
}

/**
 * The device's graphics utilisation, 0–100, or null when it cannot be read.
 *
 * Null covers every reason at once — the wrong platform, a driver that publishes no such
 * key, a probe that timed out — because they lead to the same honest answer: we do not know.
 */
export async function graphicsUtilizationPercent(): Promise<number | null> {
  if (!graphicsProbeSupported()) return null;
  try {
    const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], {
      timeout: PROBE_TIMEOUT_MS,
      // The listing carries the whole accelerator tree; the figure is near the top of it.
      maxBuffer: 4 * 1024 * 1024
    });
    return parseGraphicsUtilization(stdout);
  } catch {
    return null;
  }
}

/** Split out so the parsing is testable without a machine that has a GPU. */
export function parseGraphicsUtilization(listing: string): number | null {
  const matched = UTILIZATION.exec(listing);
  if (!matched) return null;
  const value = Number(matched[1]);
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/* ── Soty's own share of the graphics processor (macOS, Apple silicon) ─────

   The device figure above is everybody's. Apple silicon's graphics driver also keeps, on
   each client that opened the GPU (`AGXDeviceUserClient`), the PID that opened it and the
   GPU time its command queues have used so far (`AppUsage` → `accumulatedGPUTime`, in
   nanoseconds). That is readable without privileges, by the same `ioreg`, and it is what
   attributes the work to a process: two reads differenced per PID, divided by the time
   between them, is that process's share of the GPU. Summed over every client it matches the
   device's `Device Utilization %` within a point or two.

   Intel Macs' drivers publish no such key; there the listing is empty and the figure is
   null — Soty's load is its processor share alone, and says so by leaving the GPU out. */

const CLIENT_CREATOR = /"IOUserClientCreator"\s*=\s*"pid (\d+),/u;
const CLIENT_USAGE = /"AppUsage"\s*=/u;
const CLIENT_GPU_TIME = /"accumulatedGPUTime"\s*=\s*(\d+)/gu;
/** A baseline older than this describes a different moment; the next read starts afresh. */
const GRAPHICS_BASELINE_MAX_AGE_MS = 5_000;
/** Empty listings in a row before this machine is taken to have no per-client figures. */
const EMPTY_LISTINGS_BEFORE_GIVING_UP = 3;

/**
 * GPU time so far per PID, in nanoseconds, from one `ioreg` listing of the clients.
 *
 * Null when no client in the listing carries usage at all: a driver that does not keep it.
 * A PID with several clients — one per Metal device a process opened — is their sum.
 */
export function parseGraphicsClients(listing: string): Map<number, number> | null {
  const byPid = new Map<number, number>();
  let attributable = false;
  for (const entry of listing.split('+-o ')) {
    const creator = CLIENT_CREATOR.exec(entry);
    if (!creator || !CLIENT_USAGE.test(entry)) continue;
    attributable = true;
    const pid = Number(creator[1]);
    let total = byPid.get(pid) ?? 0;
    for (const matched of entry.matchAll(CLIENT_GPU_TIME)) {
      const value = Number(matched[1]);
      if (Number.isFinite(value)) total += value;
    }
    byPid.set(pid, total);
  }
  return attributable ? byPid : null;
}

/** The clients' listing; null when the probe could not run. */
export async function graphicsClientListing(): Promise<string | null> {
  if (!graphicsProbeSupported()) return null;
  try {
    const { stdout } = await run(
      'ioreg',
      ['-r', '-d', '1', '-w', '0', '-c', 'AGXDeviceUserClient'],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout;
  } catch {
    return null;
  }
}

export interface ProcessGraphicsShareOptions {
  /** Injectable for tests; defaults to the real `ioreg` listing. */
  listing?: () => Promise<string | null>;
  now?: () => number;
}

/**
 * A set of processes' share of the GPU between this read and the previous one, 0–100.
 *
 * Keeps its own baseline, as the Windows helper keeps its counter samples, so the caller
 * asks the same question on both platforms: "how much of the graphics processor are these
 * PIDs using".
 */
export class ProcessGraphicsShare {
  private readonly listing: () => Promise<string | null>;
  private readonly now: () => number;
  private previous: { byPid: Map<number, number>; atMs: number } | null = null;
  private emptyListings = 0;

  constructor(options: ProcessGraphicsShareOptions = {}) {
    this.listing = options.listing ?? graphicsClientListing;
    this.now = options.now ?? (() => Date.now());
  }

  /** True once this machine has shown it keeps no per-client figures (an Intel Mac). */
  disabled(): boolean {
    return this.emptyListings >= EMPTY_LISTINGS_BEFORE_GIVING_UP;
  }

  /** Drops the baseline, so a later read does not average over a gap nobody watched. */
  reset(): void {
    this.previous = null;
  }

  /**
   * The share, or null when there is none to give: the first read (nothing to difference
   * against), a baseline gone stale, or a listing that could not be read or attributed.
   */
  async percent(pids: readonly number[]): Promise<number | null> {
    if (this.disabled()) return null;
    const listing = await this.listing();
    const atMs = this.now();
    const all = listing === null ? null : parseGraphicsClients(listing);
    if (listing !== null) {
      // Only a listing that ran and came back without a single attributable client counts
      // against the machine; a probe that timed out says nothing about the driver.
      this.emptyListings = all === null ? this.emptyListings + 1 : 0;
    }
    if (all === null) {
      this.previous = null;
      return null;
    }
    const wanted = new Set(pids);
    const ours = new Map<number, number>();
    for (const [pid, nanoseconds] of all) if (wanted.has(pid)) ours.set(pid, nanoseconds);
    const previous = this.previous;
    this.previous = { byPid: ours, atMs };
    if (!previous) return null;
    const elapsedMs = atMs - previous.atMs;
    if (elapsedMs <= 0 || elapsedMs > GRAPHICS_BASELINE_MAX_AGE_MS) return null;
    const usedNs = consumedPerProcess(previous.byPid, ours);
    return Math.min(100, Math.max(0, (usedNs / (elapsedMs * 1_000_000)) * 100));
  }
}
