import os from 'node:os';
import { processCpuSeconds, processMetricsSupported } from '../platform/platform.js';
import type { PowerSample } from '@video-compressor/shared';
import type { PowerGovernor } from './governor.js';

/**
 * Measures what Soty is actually consuming, as a share of the whole machine.
 *
 * The figure is a delta of cumulative CPU time, not an instantaneous reading
 * from the OS: consecutive samples are differenced and divided by elapsed wall
 * time times the core count. That is the only way to get a rate that responds
 * to the lever within a second or two.
 *
 * Sampling is refcounted to viewers. Nobody watching means no probing at all —
 * the measurement must never be a meaningful contributor to the load it
 * reports.
 *
 * Which PIDs to measure is the governor's answer, not this class's. The
 * governor has to walk the descendant tree anyway — it suspends those PIDs to
 * hold the limit — and two independent walks would shell out to the process
 * table twice a second to build the same list. `retainTree()` keeps that walk
 * running for as long as someone is watching.
 */

const SAMPLE_INTERVAL_MS = 1_000;

interface Reading {
  /** Cumulative CPU seconds per tracked PID at the moment of the reading. */
  byPid: Map<number, number>;
  /** The agent's own cumulative CPU time, which is always present. */
  selfSeconds: number;
  atMs: number;
}

export interface PowerSamplerOptions {
  governor: PowerGovernor;
  intervalMs?: number;
  cpuCount?: number;
  onError?: (error: unknown, message: string) => void;
  /** Injectable probes, so tests never touch the real process table. */
  probes?: {
    supported: () => boolean;
    cpuSeconds: (pids: readonly number[]) => Promise<Map<number, number>>;
    selfCpuSeconds: () => number;
  };
}

export class PowerSampler {
  private readonly governor: PowerGovernor;
  private readonly intervalMs: number;
  private readonly cpuCount: number;
  private readonly onError: (error: unknown, message: string) => void;
  private readonly probes: NonNullable<PowerSamplerOptions['probes']>;
  private watchers = 0;
  private timer: NodeJS.Timeout | null = null;
  private previous: Reading | null = null;
  private inFlight = false;
  /** Releases the governor's tree walk; null while nobody is watching. */
  private releaseTree: (() => void) | null = null;

  constructor(options: PowerSamplerOptions) {
    this.governor = options.governor;
    this.intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
    this.cpuCount = Math.max(1, options.cpuCount ?? os.cpus().length);
    this.onError = options.onError ?? (() => {});
    this.probes = options.probes ?? {
      supported: processMetricsSupported,
      cpuSeconds: processCpuSeconds,
      selfCpuSeconds: () => {
        const usage = process.cpuUsage();
        return (usage.user + usage.system) / 1_000_000;
      }
    };
  }

  /** Registers a viewer; the returned teardown removes it. */
  watch(): () => void {
    this.watchers += 1;
    if (this.watchers === 1) this.start();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.watchers = Math.max(0, this.watchers - 1);
      if (this.watchers === 0) this.stop();
    };
  }

  watcherCount(): number {
    return this.watchers;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.releaseTree?.();
    this.releaseTree = null;
    // Drop the baseline so a later viewer does not difference against a reading
    // from minutes ago and report a nonsense average.
    this.previous = null;
  }

  private start(): void {
    if (this.timer) return;
    this.previous = null;
    this.releaseTree ??= this.governor.retainTree();
    this.publish({
      availability: this.probes.supported() ? 'warming-up' : 'unsupported',
      activity: 'idle',
      cpuCount: this.cpuCount,
      sampledAt: new Date().toISOString()
    });
    const timer = setInterval(() => void this.sample(), this.intervalMs);
    // Never hold the process open for a measurement nobody is reading.
    timer.unref();
    this.timer = timer;
    void this.sample();
  }

  /** Exposed for tests; the interval calls it. */
  async sample(): Promise<void> {
    // A slow probe must not stack ticks on top of each other.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      if (!this.probes.supported()) {
        this.publish(this.unavailable('unsupported'));
        return;
      }
      const pids = this.governor.trackedPids();
      const byPid = await this.probes.cpuSeconds(pids);
      const selfSeconds = this.probes.selfCpuSeconds();

      const now = Date.now();
      const previous = this.previous;
      this.previous = { byPid, selfSeconds, atMs: now };

      // The first tick has nothing to difference against. Reporting 0% here
      // would be a fabricated number, which is exactly what the readout must
      // never show.
      if (!previous || now <= previous.atMs) {
        this.publish(this.unavailable('warming-up'));
        return;
      }

      const elapsedSeconds = (now - previous.atMs) / 1_000;
      const capacity = elapsedSeconds * this.cpuCount;
      const rawShare = (this.consumedSince(previous, byPid, selfSeconds) / capacity) * 100;
      // Still clamped: a PID recycled between ticks, or a clock that moved, can
      // produce a figure no machine could have delivered.
      const share = Math.min(100, Math.max(0, rawShare));

      this.publish({
        availability: 'ok',
        systemSharePercent: Math.round(share * 10) / 10,
        activity: 'idle',
        cpuCount: this.cpuCount,
        sampledAt: new Date(now).toISOString()
      });
    } catch (error) {
      this.onError(error, 'Could not sample local resource usage');
      this.publish(this.unavailable('error'));
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * CPU seconds consumed since the previous reading, differenced PER PROCESS.
   *
   * Summing first and differencing the totals looks equivalent and is not: the
   * set of tracked PIDs changes between ticks, so the difference of two sums
   * silently includes processes that only exist in one of them.
   *
   * Both directions were wrong and visibly so. A descendant discovered by the
   * tree walk seconds after it started arrives carrying all the CPU time it has
   * ever used — Chromium's renderers do exactly this — and the whole lifetime
   * landed in one tick as a spike toward 100%. A child that exited made the sum
   * drop, and the clamp turned that tick into a flat 0% while the machine was
   * still busy.
   *
   * A PID present in only one reading therefore contributes nothing: a new one
   * starts counting from its next tick, and a departed one is simply gone. The
   * agent's own time is always in both.
   */
  private consumedSince(
    previous: Reading,
    byPid: Map<number, number>,
    selfSeconds: number
  ): number {
    let consumed = Math.max(0, selfSeconds - previous.selfSeconds);
    for (const [pid, seconds] of byPid) {
      const before = previous.byPid.get(pid);
      if (before === undefined) continue;
      // A PID the OS recycled onto something else can report less time than it
      // did a second ago; that is not negative consumption.
      consumed += Math.max(0, seconds - before);
    }
    return consumed;
  }

  private unavailable(availability: 'warming-up' | 'unsupported' | 'error'): PowerSample {
    return {
      availability,
      activity: 'idle',
      cpuCount: this.cpuCount,
      sampledAt: new Date().toISOString()
    };
  }

  /**
   * Hands the reading to the governor, which owns `activity` (a job preparing
   * images has no child process yet but is certainly not idle) and broadcasts.
   */
  private publish(sample: PowerSample): void {
    this.governor.publishSample(sample);
  }
}
