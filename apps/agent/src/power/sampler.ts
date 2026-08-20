import os from 'node:os';
import {
  processCpuSeconds,
  processMetricsSupported,
  processTableSnapshot,
  type ProcessTableRow
} from '../platform/platform.js';
import type { PowerSample } from '@video-compressor/shared';
import { descendantsOf } from './process-tree.js';
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
 */

const SAMPLE_INTERVAL_MS = 1_000;
/** The process tree changes rarely; rebuilding it every tick would be waste. */
const TREE_REFRESH_TICKS = 5;

interface Reading {
  cpuSeconds: number;
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
    processTable: () => Promise<ProcessTableRow[]>;
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
  private tick = 0;
  private inFlight = false;

  constructor(options: PowerSamplerOptions) {
    this.governor = options.governor;
    this.intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
    this.cpuCount = Math.max(1, options.cpuCount ?? os.cpus().length);
    this.onError = options.onError ?? (() => {});
    this.probes = options.probes ?? {
      supported: processMetricsSupported,
      cpuSeconds: processCpuSeconds,
      processTable: processTableSnapshot,
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
    // Drop the baseline so a later viewer does not difference against a reading
    // from minutes ago and report a nonsense average.
    this.previous = null;
    this.tick = 0;
  }

  private start(): void {
    if (this.timer) return;
    this.previous = null;
    this.tick = 0;
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
      await this.refreshTree();
      const pids = this.governor.trackedPids();
      const childTimes = await this.probes.cpuSeconds(pids);
      let cpuSeconds = this.probes.selfCpuSeconds();
      for (const seconds of childTimes.values()) cpuSeconds += seconds;

      const now = Date.now();
      const previous = this.previous;
      this.previous = { cpuSeconds, atMs: now };

      // The first tick has nothing to difference against. Reporting 0% here
      // would be a fabricated number, which is exactly what the readout must
      // never show.
      if (!previous || now <= previous.atMs) {
        this.publish(this.unavailable('warming-up'));
        return;
      }

      const elapsedSeconds = (now - previous.atMs) / 1_000;
      const capacity = elapsedSeconds * this.cpuCount;
      const rawShare = ((cpuSeconds - previous.cpuSeconds) / capacity) * 100;
      // A process that exits between ticks makes the sum drop, which would read
      // as a negative share; clamp rather than surface an impossible figure.
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

  private async refreshTree(): Promise<void> {
    const roots = this.governor.childPids();
    if (roots.length === 0) return;
    if (this.tick % TREE_REFRESH_TICKS !== 0) {
      this.tick += 1;
      return;
    }
    this.tick += 1;
    const rows = await this.probes.processTable();
    for (const root of roots) this.governor.setDescendants(root, descendantsOf(rows, [root]));
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
