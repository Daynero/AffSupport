import os from 'node:os';
import { sotyLoadFrom, type PowerActivity, type SotyLoad } from '@video-compressor/shared';
import {
  currentPlatform,
  processCpuSeconds,
  processMetricsSupported
} from '../platform/platform.js';
import { ProcessGraphicsShare } from './graphics.js';
import { consumedPerProcess } from './process-tree.js';
import { WindowsLoadProbe, type WindowsTreeReading } from './windows-graphics.js';

/**
 * How hard Soty itself is working the computer, for the header's power button.
 *
 * Soty is the agent and the processes it started: FFmpeg, whisper, the stitcher, Playwright's
 * Chromium, and whatever those fork. Nothing else. The button used to show the whole
 * machine's load, so a browser or a game lit it up while the panel beneath said "Soty is
 * idle — 0%"; the owner's intent was always the opposite — when Soty is doing nothing, the
 * button is just the bolt.
 *
 * **Which processes.** The governor's answer (`trackedPids`): every managed child the
 * moment it spawns, plus the descendants its last tree walk found. The walk shells out to
 * the process table, so this asks for one at most every ten seconds
 * (`refreshTreeIfOlderThan`), and only while a child exists; a tool's own process is counted
 * from its first second, only grandchildren wait for a walk. The agent's own time comes from
 * `process.cpuUsage()`, which spawns nothing.
 *
 * **Processor.** Cumulative CPU time per PID, differenced per process between two readings a
 * second apart, over elapsed time × cores — the same arithmetic as the throttle's sampler.
 * macOS: one `ps -o pid=,time= -p …` (≈6 ms of CPU). Windows: the resident helper
 * (windows-graphics.ts) answers in the same request as the graphics, so no PowerShell is
 * started per reading.
 *
 * **Graphics.** Attributed per process where the platform allows it, never the device's
 * figure. Apple silicon: the driver's per-client GPU time (`ProcessGraphicsShare`, one
 * `ioreg` ≈14 ms of CPU, every other second). Windows: the `GPU Engine` counters, keyed by
 * PID. Intel Macs and anything else: no per-process figure exists, so the reading is the
 * processor share alone and `gpuPercent` is null.
 *
 * **Cost when idle.** With no child running there is nothing to ask the OS about: one
 * `process.cpuUsage()` a second, no process spawned, no helper started. Measurement is
 * refcounted to the channel's viewers, and the page's stream parks when its tab is hidden,
 * so nobody looking means no timer at all.
 */

const SAMPLE_INTERVAL_MS = 1_000;
/** The graphics read is the costlier probe on both platforms; half the rate is plenty. */
const GRAPHICS_INTERVAL_MS = 2_000;
/** How stale the governor's descendant list may get before this asks for a fresh walk. */
const TREE_MAX_AGE_MS = 10_000;
/**
 * How long the Windows helper outlives the last viewer.
 *
 * A tab hidden and shown again, or a page navigating, drops and retakes the channel within
 * seconds. Restarting a PowerShell each time is the one expensive thing here; holding it a
 * little longer is not.
 */
const HELPER_LINGER_MS = 30_000;
/**
 * Readings in a row the probe may miss before the channel says `error`. One slow `ps` under
 * exactly the load being measured is not a failure, and must not blink the meter off.
 */
const MISSES_BEFORE_ERROR = 3;

/** What the monitor needs from the governor; structural, so tests place a tree directly. */
export interface SotyTree {
  /** Every managed child and the descendants the last walk found. */
  trackedPids(): number[];
  activity(): PowerActivity;
  refreshTreeIfOlderThan(maxAgeMs: number): void;
}

/** One reading of the tree's processes. */
export interface TreeReading {
  /** Cumulative processor seconds per PID still running. */
  cpuSeconds: Map<number, number>;
  /** The tree's graphics share now; null when none could be given, undefined if not read. */
  graphicsPercent?: number | null;
}

export interface SotyLoadProbes {
  /** Whether this host can report per-process CPU time at all. */
  supported: () => boolean;
  /** The agent's own cumulative CPU seconds; never spawns anything. */
  selfCpuSeconds: () => number;
  /** Whether graphics work can be attributed to a process here. */
  graphicsAttributable: () => boolean;
  /** Null when the reading could not be taken this time. */
  read: (pids: readonly number[], withGraphics: boolean) => Promise<TreeReading | null>;
  /** Drops any baseline the probe keeps, so a later read does not span a gap. */
  reset?: () => void;
  /** Ends whatever the probe keeps resident. */
  stop?: () => void;
}

export interface SotyLoadMonitorOptions {
  tree: SotyTree;
  intervalMs?: number;
  graphicsIntervalMs?: number;
  lingerMs?: number;
  cpuCount?: number;
  probes?: SotyLoadProbes;
  onError?: (error: unknown, message: string) => void;
  now?: () => number;
}

function selfCpuSeconds(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1_000_000;
}

/**
 * `ps -p` exits 1 when none of the listed PIDs exists any more — the last child finished
 * between the governor's answer and the read. That is an empty tree, not a broken probe.
 */
async function psCpuSeconds(pids: readonly number[]): Promise<Map<number, number>> {
  try {
    return await processCpuSeconds(pids);
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown };
    if (failed.code === 1 && !String(failed.stdout ?? '').trim()) return new Map();
    throw error;
  }
}

/** The probes this machine has. */
export function platformSotyLoadProbes(
  onError: (error: unknown, message: string) => void = () => {}
): SotyLoadProbes {
  if (currentPlatform() === 'win32') {
    const helper = new WindowsLoadProbe({ onError });
    return {
      supported: () => !helper.disabled(),
      selfCpuSeconds,
      graphicsAttributable: () => !helper.disabled(),
      read: (pids, withGraphics): Promise<WindowsTreeReading | null> =>
        helper.read(pids, withGraphics),
      stop: () => helper.stop()
    };
  }
  if (currentPlatform() === 'darwin') {
    const graphics = new ProcessGraphicsShare();
    return {
      supported: processMetricsSupported,
      selfCpuSeconds,
      graphicsAttributable: () => !graphics.disabled(),
      read: async (pids, withGraphics) => {
        // Side by side, so both figures describe the same moment.
        const [cpuSeconds, graphicsPercent] = await Promise.all([
          psCpuSeconds(pids),
          withGraphics ? graphics.percent(pids) : Promise.resolve(undefined)
        ]);
        return withGraphics ? { cpuSeconds, graphicsPercent } : { cpuSeconds };
      },
      reset: () => graphics.reset()
    };
  }
  return {
    supported: processMetricsSupported,
    selfCpuSeconds,
    graphicsAttributable: () => false,
    read: async pids => ({ cpuSeconds: await psCpuSeconds(pids) })
  };
}

interface Baseline {
  selfSeconds: number;
  byPid: Map<number, number>;
  atMs: number;
}

export class SotyLoadMonitor {
  private readonly tree: SotyTree;
  private readonly intervalMs: number;
  private readonly graphicsIntervalMs: number;
  private readonly lingerMs: number;
  private readonly cpuCount: number;
  private readonly probes: SotyLoadProbes;
  private readonly onError: (error: unknown, message: string) => void;
  private readonly now: () => number;
  private readonly listeners = new Set<(load: SotyLoad) => void>();
  private watchers = 0;
  private timer: NodeJS.Timeout | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;
  private previous: Baseline | null = null;
  private gpu: number | null = null;
  private gpuReadAt = Number.NEGATIVE_INFINITY;
  private inFlight = false;
  private misses = 0;
  private current: SotyLoad;

  constructor(options: SotyLoadMonitorOptions) {
    this.tree = options.tree;
    this.intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
    this.graphicsIntervalMs = options.graphicsIntervalMs ?? GRAPHICS_INTERVAL_MS;
    this.lingerMs = options.lingerMs ?? HELPER_LINGER_MS;
    this.cpuCount = Math.max(1, options.cpuCount ?? os.cpus().length);
    this.onError = options.onError ?? (() => {});
    this.probes = options.probes ?? platformSotyLoadProbes(this.onError);
    this.now = options.now ?? (() => Date.now());
    this.current = this.unavailable('warming-up');
  }

  /** The last reading; what a viewer is handed the moment it subscribes. */
  snapshot(): SotyLoad {
    return this.current;
  }

  /** Called with every reading that differs from the one before it. */
  onChange(listener: (load: SotyLoad) => void): () => void {
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
    this.releaseHelper();
  }

  /** Exposed for tests; the interval calls it. */
  async sample(): Promise<void> {
    // A slow probe must not stack ticks on top of each other.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.takeReading();
    } finally {
      this.inFlight = false;
    }
  }

  private async takeReading(): Promise<void> {
    if (!this.probes.supported()) {
      this.publish(this.unavailable('unsupported'));
      return;
    }
    const attributable = this.probes.graphicsAttributable();
    this.tree.refreshTreeIfOlderThan(TREE_MAX_AGE_MS);
    const pids = this.tree.trackedPids();

    let byPid = new Map<number, number>();
    if (pids.length > 0) {
      const withGraphics = attributable && this.now() - this.gpuReadAt >= this.graphicsIntervalMs;
      let reading: TreeReading | null;
      try {
        reading = await this.probes.read(pids, withGraphics);
      } catch (error) {
        this.miss(error);
        return;
      }
      if (!reading) {
        this.miss(null);
        return;
      }
      byPid = reading.cpuSeconds;
      if (withGraphics) {
        this.gpuReadAt = this.now();
        if (reading.graphicsPercent !== undefined) this.gpu = reading.graphicsPercent;
      }
    } else {
      // Nothing of Soty's is running that could draw: the agent itself does no graphics
      // work. Where graphics are attributable that is a measured zero, not an unknown; and
      // the next child starts from a fresh baseline rather than one from its predecessor.
      this.gpu = attributable ? 0 : null;
      this.gpuReadAt = Number.NEGATIVE_INFINITY;
      this.probes.reset?.();
    }
    if (!attributable) this.gpu = null;

    // Read after the tree, so both halves describe the same moment.
    const atMs = this.now();
    const selfSeconds = this.probes.selfCpuSeconds();
    const activity = this.tree.activity();
    this.misses = 0;

    const previous = this.previous;
    this.previous = { selfSeconds, byPid, atMs };
    // The first reading has nothing to difference against; a 0% here would be invented.
    if (!previous || atMs <= previous.atMs) {
      if (this.current.availability !== 'ok') this.publish(this.unavailable('warming-up'));
      return;
    }
    const capacitySeconds = ((atMs - previous.atMs) / 1_000) * this.cpuCount;
    const consumed =
      Math.max(0, selfSeconds - previous.selfSeconds) + consumedPerProcess(previous.byPid, byPid);
    this.publish(
      sotyLoadFrom({
        cpuPercent: (consumed / capacitySeconds) * 100,
        gpuPercent: this.gpu,
        activity,
        sampledAt: new Date(atMs).toISOString()
      })
    );
  }

  private miss(error: unknown): void {
    this.misses += 1;
    if (this.misses < MISSES_BEFORE_ERROR) return;
    if (this.misses === MISSES_BEFORE_ERROR)
      this.onError(error ?? new Error('No reading'), "Could not read Soty's own load");
    // The baseline is from before the gap; a later reading must not average across it.
    this.previous = null;
    this.publish(this.unavailable('error'));
  }

  private start(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.timer) return;
    this.reset();
    this.current = this.unavailable('warming-up');
    const timer = setInterval(() => void this.sample(), this.intervalMs);
    // Never hold the process open for a measurement nobody is reading.
    timer.unref();
    this.timer = timer;
    void this.sample();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A later viewer must not difference against a reading from minutes ago.
    this.reset();
    if (!this.probes.stop || this.lingerTimer) return;
    const linger = setTimeout(() => {
      this.lingerTimer = null;
      if (this.watchers === 0) this.releaseHelper();
    }, this.lingerMs);
    linger.unref();
    this.lingerTimer = linger;
  }

  private reset(): void {
    this.previous = null;
    this.gpu = null;
    this.gpuReadAt = Number.NEGATIVE_INFINITY;
    this.misses = 0;
    this.probes.reset?.();
  }

  private releaseHelper(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.probes.stop?.();
  }

  private unavailable(availability: 'warming-up' | 'unsupported' | 'error'): SotyLoad {
    return { availability, sampledAt: new Date(this.now()).toISOString() };
  }

  private publish(load: SotyLoad): void {
    const unchanged = sameReading(this.current, load);
    this.current = load;
    if (unchanged) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(load);
      } catch (error) {
        this.onError(error, 'A Soty load listener failed');
      }
    }
  }
}

/** Equal for every purpose a viewer has; the timestamp alone is not news. */
function sameReading(a: SotyLoad, b: SotyLoad): boolean {
  if (a.availability !== b.availability) return false;
  if (a.availability !== 'ok' || b.availability !== 'ok') return true;
  return (
    a.cpuPercent === b.cpuPercent && a.gpuPercent === b.gpuPercent && a.activity === b.activity
  );
}
