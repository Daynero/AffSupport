import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  clampPowerLimit,
  powerModeFor,
  DEFAULT_POWER_LIMIT,
  POWER_LIMIT_MAX,
  type PowerSample,
  type PowerState
} from '@video-compressor/shared';
import {
  pauseProcess,
  processPauseSupported,
  resumeProcess,
  shutdownProcessPause
} from '../platform/platform.js';

/**
 * The single authority over how much of the machine Soty's local tools may use.
 *
 * Everything heavy the agent spawns is registered here, so the limit is one
 * shared budget rather than a per-tool setting: two tools running at once stay
 * inside the ceiling *together*. A tool added later inherits the budget by
 * going through `spawnManaged`, which is enforced by an ESLint rule rather than
 * by remembering.
 *
 * The governor is also the ONLY thing allowed to suspend a managed child.
 * Before this existed, the compressor queue suspended the active encode itself
 * so prioritized estimates could jump the line; if that stayed, the duty cycler
 * and the queue would each drive the same process's stopped state and fight —
 * the cycler's next on-window would resume a process the queue deliberately
 * stopped. Callers that need a child held now take a `hold()`, and callers that
 * need one running (every cancel/shutdown path, before SIGTERM) call
 * `resumeForTermination()`.
 */

/** How often the duty cycler toggles a limited child. */
const DUTY_PERIOD_MS = 200;

/**
 * Never resume for less than this. An on-window shorter than a scheduling
 * quantum produces a process that is technically running but never actually
 * scheduled, which would make throughput zero at the floor.
 */
const MIN_DUTY_ON_MS = 50;

export interface ManagedChildOptions {
  /** Which tool spawned it. Diagnostics and tests only; never affects the budget. */
  toolId: string;
}

interface ManagedChild {
  child: ChildProcess;
  pid: number;
  toolId: string;
  /** Descendant PIDs, for trees like Playwright's. Filled in by the sampler. */
  descendants: number[];
  suspended: boolean;
  /** Outstanding hold reasons. While non-empty the cycler leaves it suspended. */
  holds: Set<symbol>;
  /** Pinned resumed for termination; the cycler must not touch it again. */
  terminating: boolean;
  live: boolean;
}

/**
 * The budget derived from the current limit.
 *
 * `threadBudget` and `priority` are deliberately `null` when unrestricted: at
 * 100% the agent must spawn a byte-identical command line to the one it shipped
 * before this feature existed. Deriving "equivalent" values instead would push
 * whisper from its usual `max(4, cores - 2)` to a full core count and give
 * FFmpeg a `-threads` flag it has never received.
 */
export interface CpuBudget {
  threadBudget: number | null;
  dutyOnFraction: number;
  priority: number | null;
  timeoutScale: number;
}

export interface PowerGovernorOptions {
  /** Injectable for tests; defaults to the real core count. */
  cpuCount?: number;
  /** Injectable for tests; defaults to the platform capability. */
  pauseSupported?: boolean;
  /** Reports whether any tool is busy, so `activity` is not child-only. */
  busy?: () => boolean;
  onError?: (error: unknown, message: string) => void;
  /** Called whenever the state changes, so routes can broadcast. */
  onChange?: () => void;
  /** Persists a limit before it is applied. Rejecting leaves the limit unchanged. */
  persist?: (limitPercent: number) => Promise<void>;
}

export class PowerGovernor {
  private limit = DEFAULT_POWER_LIMIT;
  private updatedAt = new Date(0).toISOString();
  private readonly children = new Map<number, ManagedChild>();
  private readonly cpuCount: number;
  private readonly pauseSupported: boolean;
  private readonly busy: () => boolean;
  private readonly onError: (error: unknown, message: string) => void;
  private onChange: (() => void) | null;
  private readonly persist: ((limitPercent: number) => Promise<void>) | null;
  private cycleTimer: NodeJS.Timeout | null = null;
  private latestSample: PowerSample | null = null;

  constructor(options: PowerGovernorOptions = {}) {
    this.cpuCount = Math.max(1, options.cpuCount ?? os.cpus().length);
    this.pauseSupported = options.pauseSupported ?? processPauseSupported();
    this.busy = options.busy ?? (() => false);
    this.onError = options.onError ?? (() => {});
    this.onChange = options.onChange ?? null;
    this.persist = options.persist ?? null;
  }

  /** Wired after construction, once the SSE channel exists. */
  setChangeListener(listener: (() => void) | null) {
    this.onChange = listener;
  }

  limitPercent(): number {
    return this.limit;
  }

  /**
   * Adopts a limit loaded from disk without re-persisting it. Used once at
   * startup; a corrupt or absent store simply leaves the default in place.
   */
  adoptPersistedLimit(limitPercent: number, updatedAt: string) {
    this.limit = clampPowerLimit(limitPercent);
    this.updatedAt = updatedAt;
    this.retune();
  }

  /**
   * Applies a new limit. Persistence happens FIRST: a value that cannot be
   * written must not take effect, or the lever would show a limit that will not
   * survive a restart.
   */
  async setLimit(requested: number): Promise<number> {
    const next = clampPowerLimit(requested);
    if (this.persist) await this.persist(next);
    this.limit = next;
    this.updatedAt = new Date().toISOString();
    this.retune();
    this.onChange?.();
    return this.limit;
  }

  budget(): CpuBudget {
    if (this.limit >= POWER_LIMIT_MAX) {
      return { threadBudget: null, dutyOnFraction: 1, priority: null, timeoutScale: 1 };
    }
    const fraction = this.limit / 100;
    return {
      // At least one thread, always: a budget that rounds to zero would mean a
      // job that can never finish.
      threadBudget: Math.max(1, Math.round(fraction * this.cpuCount)),
      dutyOnFraction: fraction,
      priority: os.constants.priority.PRIORITY_BELOW_NORMAL,
      timeoutScale: 1 / fraction
    };
  }

  /**
   * Scales a wall-clock deadline that covers managed work. Throttling stretches
   * real time by roughly 1/dutyOnFraction, so an unscaled deadline turns a
   * slowdown into a failure — a 90 s render budget cannot be met by a render
   * that is deliberately being given 20% of the machine.
   */
  scaleTimeout(milliseconds: number): number {
    const { timeoutScale } = this.budget();
    return timeoutScale === 1 ? milliseconds : Math.round(milliseconds * timeoutScale);
  }

  /** True while the host can throttle work that is already running. */
  throttlingSupported(): boolean {
    return this.pauseSupported;
  }

  register(child: ChildProcess, options: ManagedChildOptions): void {
    const pid = child.pid;
    if (typeof pid !== 'number') return;
    this.children.set(pid, {
      child,
      pid,
      toolId: options.toolId,
      descendants: [],
      suspended: false,
      holds: new Set(),
      terminating: false,
      live: true
    });
    this.retune();
    this.onChange?.();
  }

  /**
   * Removes a child. Always resumes first: a process deregistered while stopped
   * stays stopped forever, and its PID may later be recycled onto something
   * unrelated that we would then signal.
   */
  release(child: ChildProcess): void {
    const pid = child.pid;
    if (typeof pid !== 'number') return;
    const entry = this.children.get(pid);
    if (!entry) return;
    entry.live = false;
    if (entry.suspended) this.resume(entry);
    this.children.delete(pid);
    this.retune();
    this.onChange?.();
  }

  /**
   * Holds a child suspended for a caller's own reason (the compressor queue
   * does this so prioritized estimates get the machine). While any hold is
   * outstanding the duty cycler will not resume it.
   */
  hold(child: ChildProcess, _reason: string): () => void {
    const pid = child.pid;
    const entry = typeof pid === 'number' ? this.children.get(pid) : undefined;
    if (!entry) return () => {};
    const token = Symbol(_reason);
    entry.holds.add(token);
    if (!entry.terminating && !entry.suspended) this.suspend(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holds.delete(token);
      // Only resume outright when nothing else wants it held and the cycler is
      // not in charge; otherwise the next cycle tick decides.
      if (entry.holds.size === 0 && entry.suspended && this.budget().dutyOnFraction === 1)
        this.resume(entry);
    };
  }

  /**
   * Resumes a child and pins it resumed, for callers about to terminate it.
   * SIGTERM is not delivered to a stopped process until it is resumed, so
   * without this a cancel would fall through to the SIGKILL escalation and the
   * tool would never finalize its output.
   */
  resumeForTermination(child: ChildProcess): void {
    const pid = child.pid;
    const entry = typeof pid === 'number' ? this.children.get(pid) : undefined;
    if (!entry) return;
    entry.terminating = true;
    entry.holds.clear();
    if (entry.suspended) this.resume(entry);
  }

  /** PIDs the sampler should measure: every managed child plus its descendants. */
  trackedPids(): number[] {
    const pids: number[] = [];
    for (const entry of this.children.values()) {
      if (!entry.live) continue;
      pids.push(entry.pid, ...entry.descendants);
    }
    return pids;
  }

  setDescendants(pid: number, descendants: number[]): void {
    const entry = this.children.get(pid);
    if (entry) entry.descendants = descendants;
  }

  /** Registered child PIDs, without descendants. */
  childPids(): number[] {
    return [...this.children.values()].filter(entry => entry.live).map(entry => entry.pid);
  }

  activeChildren(): number {
    return this.childPids().length;
  }

  publishSample(sample: PowerSample): void {
    this.latestSample = sample;
    this.onChange?.();
  }

  state(): PowerState {
    const activity = this.activeChildren() > 0 || this.busy() ? 'active' : 'idle';
    const sample: PowerSample = this.latestSample
      ? { ...this.latestSample, activity }
      : {
          availability: 'warming-up',
          activity,
          cpuCount: this.cpuCount,
          sampledAt: new Date().toISOString()
        };
    return {
      limitPercent: this.limit,
      mode: powerModeFor(this.limit),
      sample,
      throttlingSupported: this.pauseSupported,
      activeChildren: this.activeChildren(),
      updatedAt: this.updatedAt
    };
  }

  async shutdown(): Promise<void> {
    this.stopCycle();
    // Resume everything before the process exits. A child left stopped here
    // would survive the agent and never make progress again.
    for (const entry of this.children.values()) {
      if (entry.suspended) this.resume(entry);
    }
    this.children.clear();
    // Only after everything is resumed: on Windows the helper IS the resume
    // mechanism, so tearing it down first would strand suspended processes.
    await shutdownProcessPause();
  }

  /* ── duty cycling ─────────────────────────────────────────────────────── */

  private retune(): void {
    const { dutyOnFraction } = this.budget();
    const shouldCycle = dutyOnFraction < 1 && this.pauseSupported && this.children.size > 0;
    if (!shouldCycle) {
      this.stopCycle();
      // Leaving the limit means nothing stays stopped on our account, but a
      // caller's hold still stands.
      for (const entry of this.children.values()) {
        if (entry.suspended && entry.holds.size === 0) this.resume(entry);
      }
      return;
    }
    if (!this.cycleTimer) this.startCycle();
  }

  private startCycle(): void {
    const tick = () => {
      const { dutyOnFraction } = this.budget();
      if (dutyOnFraction >= 1) {
        this.stopCycle();
        return;
      }
      const onMs = Math.max(MIN_DUTY_ON_MS, Math.round(DUTY_PERIOD_MS * dutyOnFraction));
      const offMs = Math.max(0, DUTY_PERIOD_MS - onMs);
      if (offMs === 0) {
        this.schedule(tick, DUTY_PERIOD_MS);
        return;
      }
      this.resumeAll();
      this.schedule(() => {
        this.suspendAll();
        this.schedule(tick, offMs);
      }, onMs);
    };
    tick();
  }

  private schedule(run: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.cycleTimer = null;
      run();
    }, delayMs);
    // Never hold the process open on the duty cycler's account.
    timer.unref();
    this.cycleTimer = timer;
  }

  private stopCycle(): void {
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  private resumeAll(): void {
    for (const entry of this.children.values()) {
      if (entry.holds.size > 0 || entry.terminating) continue;
      if (entry.suspended) this.resume(entry);
    }
  }

  private suspendAll(): void {
    for (const entry of this.children.values()) {
      if (entry.terminating) continue;
      if (!entry.suspended) this.suspend(entry);
    }
  }

  private suspend(entry: ManagedChild): void {
    // Never signal a PID whose process has already gone: the OS may have
    // recycled it onto something unrelated.
    if (!entry.live) return;
    try {
      if (pauseProcess(entry.child)) entry.suspended = true;
    } catch (error) {
      this.onError(error, 'Could not suspend a managed child process');
    }
  }

  private resume(entry: ManagedChild): void {
    try {
      resumeProcess(entry.child);
    } catch (error) {
      this.onError(error, 'Could not resume a managed child process');
    }
    entry.suspended = false;
  }
}
