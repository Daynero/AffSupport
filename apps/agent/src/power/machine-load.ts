import os from 'node:os';
import { machineLoadFrom, type MachineLoad } from '@video-compressor/shared';
import { currentPlatform } from '../platform/platform.js';
import { graphicsUtilizationPercent } from './graphics.js';
import { WindowsGraphicsProbe } from './windows-graphics.js';

/**
 * How busy the whole computer is, for the header's power button.
 *
 * Not the throttle's sampler (sampler.ts), which measures Soty's own share by walking its
 * process tree. This is the machine: every core's busy time and the graphics device, the
 * two things that make a laptop's fans spin, whoever is spending them.
 *
 * **Processor.** `os.cpus()` carries each core's cumulative user/nice/sys/irq/idle time.
 * Two reads a second apart give the busy share of all cores together — the figure Activity
 * Monitor and Task Manager show, not a load average, which counts waiting threads and reads
 * 20 on a ten-core machine that is merely busy. No process is spawned for it, on any
 * platform.
 *
 * **Graphics.** macOS: `ioreg`'s accelerator statistics, `Device Utilization %`, readable
 * without elevated privileges. One short process (≈10 ms of CPU), so it runs every other
 * second, not every second. Windows: the `GPU Engine` counters, read by one resident helper
 * (windows-graphics.ts). Anywhere else, or when the read fails, the figure is null and the
 * readout is the processor alone.
 *
 * **Cost.** Refcounted to viewers exactly as the throttle's sampler is: the agent measures
 * only while a page has the channel open, and the page's stream parks when its tab is
 * hidden. Nobody looking means no timers and no helper.
 */

const SAMPLE_INTERVAL_MS = 1_000;
/** The graphics probe spawns a process on macOS; half the rate keeps that negligible. */
const GRAPHICS_INTERVAL_MS = 2_000;
/**
 * How long the Windows helper outlives the last viewer.
 *
 * A tab hidden and shown again, or a page navigating, drops and retakes the channel within
 * seconds. Restarting a PowerShell each time is the one expensive thing here; holding it a
 * little longer is not.
 */
const HELPER_LINGER_MS = 30_000;

/** Cumulative processor time of every core together, in the units `os.cpus()` reports. */
export interface CpuTimes {
  busy: number;
  total: number;
}

export function totalCpuTimes(cpus: readonly os.CpuInfo[] = os.cpus()): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, irq, idle } = cpu.times;
    const working = user + nice + sys + irq;
    busy += working;
    total += working + idle;
  }
  return { busy, total };
}

/** Busy share between two reads, 0–100; null when no time passed between them. */
export function cpuPercentBetween(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  if (!(total > 0)) return null;
  const busy = Math.max(0, current.busy - previous.busy);
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

export interface MachineLoadProbes {
  cpuTimes: () => CpuTimes;
  /** The graphics figure; absent where the platform has none. */
  graphicsPercent?: () => Promise<number | null>;
  /** Ends whatever the graphics probe keeps resident. */
  stopGraphics?: () => void;
}

export interface MachineLoadMonitorOptions {
  intervalMs?: number;
  graphicsIntervalMs?: number;
  lingerMs?: number;
  probes?: MachineLoadProbes;
  onError?: (error: unknown, message: string) => void;
  now?: () => number;
}

/** The probes this machine has. */
export function platformMachineLoadProbes(
  onError: (error: unknown, message: string) => void = () => {}
): MachineLoadProbes {
  const platform = currentPlatform();
  if (platform === 'darwin') {
    return { cpuTimes: () => totalCpuTimes(), graphicsPercent: graphicsUtilizationPercent };
  }
  if (platform === 'win32') {
    const probe = new WindowsGraphicsProbe({ onError });
    return {
      cpuTimes: () => totalCpuTimes(),
      graphicsPercent: () => probe.read(),
      stopGraphics: () => probe.stop()
    };
  }
  return { cpuTimes: () => totalCpuTimes() };
}

export class MachineLoadMonitor {
  private readonly intervalMs: number;
  private readonly graphicsIntervalMs: number;
  private readonly lingerMs: number;
  private readonly probes: MachineLoadProbes;
  private readonly onError: (error: unknown, message: string) => void;
  private readonly now: () => number;
  private readonly listeners = new Set<(load: MachineLoad) => void>();
  private watchers = 0;
  private timer: NodeJS.Timeout | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;
  private previousCpu: CpuTimes | null = null;
  private gpu: number | null = null;
  private gpuReadAt = Number.NEGATIVE_INFINITY;
  private gpuInFlight = false;
  private current: MachineLoad;

  constructor(options: MachineLoadMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
    this.graphicsIntervalMs = options.graphicsIntervalMs ?? GRAPHICS_INTERVAL_MS;
    this.lingerMs = options.lingerMs ?? HELPER_LINGER_MS;
    this.onError = options.onError ?? (() => {});
    this.probes = options.probes ?? platformMachineLoadProbes(this.onError);
    this.now = options.now ?? (() => Date.now());
    this.current = this.unavailable('warming-up');
  }

  /** The last reading; what a viewer is handed the moment it subscribes. */
  snapshot(): MachineLoad {
    return this.current;
  }

  /** Called with every reading that differs from the one before it. */
  onChange(listener: (load: MachineLoad) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Registers a viewer; the returned teardown removes it. */
  watch(): () => void {
    this.watchers += 1;
    if (this.watchers === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers = Math.max(0, this.watchers - 1);
      if (this.watchers === 0) this.stop();
    };
  }

  watcherCount(): number {
    return this.watchers;
  }

  /** Stops measuring and ends any resident helper at once. For shutdown and tests. */
  dispose(): void {
    this.stop();
    this.releaseGraphics();
  }

  /** Exposed for tests; the interval calls it. */
  sample(): void {
    let times: CpuTimes;
    try {
      times = this.probes.cpuTimes();
    } catch (error) {
      this.onError(error, 'Could not read the processor times');
      this.publish(this.unavailable('error'));
      return;
    }
    const previous = this.previousCpu;
    this.previousCpu = times;
    this.refreshGraphics();
    // The first read has nothing to difference against; a 0% here would be invented.
    const cpu = previous ? cpuPercentBetween(previous, times) : null;
    if (cpu === null) {
      if (!previous) this.publish(this.unavailable('warming-up'));
      return;
    }
    this.publish(
      machineLoadFrom({
        cpuPercent: cpu,
        gpuPercent: this.gpu,
        sampledAt: new Date(this.now()).toISOString()
      })
    );
  }

  private start(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.timer) return;
    this.previousCpu = null;
    this.gpu = null;
    this.gpuReadAt = Number.NEGATIVE_INFINITY;
    this.current = this.unavailable('warming-up');
    const timer = setInterval(() => this.sample(), this.intervalMs);
    // Never hold the process open for a measurement nobody is reading.
    timer.unref();
    this.timer = timer;
    this.sample();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A later viewer must not difference against a reading from minutes ago.
    this.previousCpu = null;
    if (!this.probes.stopGraphics || this.lingerTimer) return;
    const linger = setTimeout(() => {
      this.lingerTimer = null;
      if (this.watchers === 0) this.releaseGraphics();
    }, this.lingerMs);
    linger.unref();
    this.lingerTimer = linger;
  }

  private releaseGraphics(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.probes.stopGraphics?.();
  }

  /**
   * Starts a graphics read when one is due, without waiting for it.
   *
   * The processor figure is published on its own beat; the graphics one joins the next
   * reading after it arrives. Awaiting it would tie the one-second rhythm to a process that
   * can take far longer on a machine under exactly the load being measured.
   */
  private refreshGraphics(): void {
    const read = this.probes.graphicsPercent;
    if (!read || this.gpuInFlight) return;
    const now = this.now();
    if (now - this.gpuReadAt < this.graphicsIntervalMs) return;
    this.gpuReadAt = now;
    this.gpuInFlight = true;
    read()
      .then(value => {
        if (this.timer) this.gpu = value;
      })
      .catch(() => {
        this.gpu = null;
      })
      .finally(() => {
        this.gpuInFlight = false;
      });
  }

  private unavailable(availability: 'warming-up' | 'unsupported' | 'error'): MachineLoad {
    return { availability, sampledAt: new Date(this.now()).toISOString() };
  }

  private publish(load: MachineLoad): void {
    const unchanged = sameReading(this.current, load);
    this.current = load;
    if (unchanged) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(load);
      } catch (error) {
        this.onError(error, 'A machine load listener failed');
      }
    }
  }
}

/** Equal for every purpose a viewer has; the timestamp alone is not news. */
function sameReading(a: MachineLoad, b: MachineLoad): boolean {
  if (a.availability !== b.availability) return false;
  if (a.availability !== 'ok' || b.availability !== 'ok') return true;
  return a.cpuPercent === b.cpuPercent && a.gpuPercent === b.gpuPercent;
}
