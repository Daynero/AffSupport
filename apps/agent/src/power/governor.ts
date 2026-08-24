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
  pauseProcessId,
  processPauseSupported,
  processTableSnapshot,
  resumeProcess,
  resumeProcessId,
  shutdownProcessPause,
  type ProcessTableRow
} from '../platform/platform.js';
import { descendantsByRoot } from './process-tree.js';

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

/**
 * The shortest duty period. The cycler stretches it when the limit is low
 * enough that `MIN_DUTY_ON_MS` would not fit inside the on-share — see
 * `dutyWindows`.
 */
const DUTY_PERIOD_MS = 200;

/**
 * Never resume for less than this. An on-window shorter than a scheduling
 * quantum produces a process that is technically running but never actually
 * scheduled, which would make throughput zero at the floor.
 */
const MIN_DUTY_ON_MS = 50;

/**
 * How often the descendant tree is re-walked while it is being tracked.
 *
 * The tree only changes when a tool forks, so this is deliberately far slower
 * than the duty cycle. A walk shells out to the process table — `/bin/ps` on
 * POSIX, a full `Win32_Process` enumeration through PowerShell on Windows —
 * and that is expensive enough that the measurement must not become a
 * meaningful share of the load it reports.
 *
 * It also bounds the PID-recycling window: a descendant PID is only ever
 * signalled if a snapshot no older than this reported it under one of our own
 * children. Three seconds is still far shorter than any realistic recycling of
 * a PID on either platform.
 */
const TREE_REFRESH_MS = 3_000;

/**
 * How many duty periods a child stays pinned resumed once a termination has
 * been requested.
 *
 * Long enough to cover the queue's SIGTERM→SIGKILL escalation (2 s, itself
 * scaled by the limit) plus a tool that needs a moment to finalize its output.
 * After that the pin expires on purpose: a process that survived its own kill —
 * SIGTERM handled, the signal lost, an encode still flushing — would otherwise
 * be exempt from the limit for the rest of the session, and the user would see
 * a lever that had quietly stopped applying.
 */
const TERMINATION_PIN_CYCLES = 50;

/** How often the wake probe checks the wall clock while anything is managed. */
const WAKE_PROBE_MS = 5_000;

/**
 * How much further behind its own period the probe must be for the gap to mean a suspend.
 *
 * Half a minute, because the alternative reading — an event loop this far behind — would
 * mean the agent had bigger problems than the duty cycler, and because a machine held at a
 * low limit is expected to be late, just never by this much.
 */
const WAKE_GAP_MS = 30_000;

/**
 * The on/off split for a duty fraction.
 *
 * The period stretches rather than the on-window shrinking below
 * `MIN_DUTY_ON_MS`. Clamping the on-window inside a fixed period was the
 * obvious approach and it silently lies: at the 20% floor a 50 ms floor inside
 * a 200 ms period delivers 25%, so the lever would promise a quarter less
 * machine than it actually gives back.
 */
export function dutyWindows(fraction: number): { onMs: number; offMs: number } {
  const onMs = Math.max(MIN_DUTY_ON_MS, Math.round(DUTY_PERIOD_MS * fraction));
  const periodMs = Math.max(DUTY_PERIOD_MS, Math.round(onMs / fraction));
  return { onMs, offMs: Math.max(1, periodMs - onMs) };
}

export interface ManagedChildOptions {
  /** Which tool spawned it. Diagnostics and tests only; never affects the budget. */
  toolId: string;
}

interface ManagedChild {
  child: ChildProcess;
  pid: number;
  toolId: string;
  /** Descendant PIDs, for trees like Playwright's. Filled in by the tree tracker. */
  descendants: number[];
  /** Descendants this governor actually stopped, so resume touches only those. */
  suspendedDescendants: Set<number>;
  /** Descendants already given the below-normal priority, so it is set once. */
  deprioritized: Set<number>;
  suspended: boolean;
  /** Outstanding hold reasons. While non-empty the cycler leaves it suspended. */
  holds: Set<symbol>;
  /** Pinned resumed for a termination in progress; the cycler leaves it alone. */
  terminating: boolean;
  /** Duty periods the pin has survived, so it can age out. */
  terminationPinCycles: number;
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
  /** Injectable for tests, which must never read the real process table. */
  probeProcessTable?: () => Promise<ProcessTableRow[]>;
  /** Injectable for tests; the real signals, keyed by PID, for descendants. */
  descendantSignals?: {
    pause: (pid: number) => boolean;
    resume: (pid: number) => boolean;
    setPriority: (pid: number, priority: number) => void;
  };
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
  private onWake: (() => void) | null = null;
  private readonly persist: ((limitPercent: number) => Promise<void>) | null;
  private cycleTimer: NodeJS.Timeout | null = null;
  private wakeProbe: NodeJS.Timeout | null = null;
  /** When the wake probe last ran; a much larger gap than its period means a suspend. */
  private lastProbeAt = 0;
  private latestSample: PowerSample | null = null;
  private readonly probeProcessTable: () => Promise<ProcessTableRow[]>;
  private readonly descendantSignals: NonNullable<PowerGovernorOptions['descendantSignals']>;
  private treeTimer: NodeJS.Timeout | null = null;
  private treeInFlight = false;
  /** Consumers that need the tree walked for measurement rather than control. */
  private treeWatchers = 0;

  constructor(options: PowerGovernorOptions = {}) {
    this.cpuCount = Math.max(1, options.cpuCount ?? os.cpus().length);
    this.pauseSupported = options.pauseSupported ?? processPauseSupported();
    this.busy = options.busy ?? (() => false);
    this.onError = options.onError ?? (() => {});
    this.onChange = options.onChange ?? null;
    this.persist = options.persist ?? null;
    this.probeProcessTable = options.probeProcessTable ?? processTableSnapshot;
    this.descendantSignals = options.descendantSignals ?? {
      pause: pauseProcessId,
      resume: resumeProcessId,
      setPriority: (pid, priority) => os.setPriority(pid, priority)
    };
  }

  /** Wired after construction, once the SSE channel exists. */
  /** Called once each time the machine is found to have slept and woken (FR-009a). */
  setWakeListener(listener: (() => void) | null) {
    this.onWake = listener;
  }

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
      suspendedDescendants: new Set(),
      deprioritized: new Set(),
      suspended: false,
      holds: new Set(),
      terminating: false,
      terminationPinCycles: 0,
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
    if (this.isStopped(entry)) this.resume(entry);
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
    entry.terminationPinCycles = 0;
    entry.holds.clear();
    if (this.isStopped(entry)) this.resume(entry);
  }

  /**
   * True when this child is stopped on our account right now.
   *
   * Callers that ask a child to be held need to know whether the request
   * actually landed: the signal can fail (the process is already gone, the
   * Windows helper could not start), and a caller that assumes success would
   * carry on as if the machine had been freed up when it has not.
   */
  isSuspended(child: ChildProcess): boolean {
    const pid = child.pid;
    const entry = typeof pid === 'number' ? this.children.get(pid) : undefined;
    return entry ? this.isStopped(entry) : false;
  }

  /**
   * True when any part of this child's tree is stopped on our account. The root
   * and its descendants can disagree: `suspend` still stops the descendants when
   * the root's own signal did not land, so asking only about the root would
   * strand them.
   */
  private isStopped(entry: ManagedChild): boolean {
    return entry.suspended || entry.suspendedDescendants.size > 0;
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

  /**
   * Replaces a child's descendant list. The tree tracker calls this on every
   * walk; it is also the seam a test uses to place a tree without a real
   * process table. Newly listed descendants immediately inherit whatever is
   * already in force for their root.
   */
  setDescendants(pid: number, descendants: number[]): void {
    const entry = this.children.get(pid);
    if (!entry) return;
    entry.descendants = descendants;
    // Forget PIDs that have left the tree. `suspendedDescendants` must NOT be
    // pruned the same way — a descendant that was reparented away is still
    // stopped on our account and we are the only thing that knows it — but
    // `deprioritized` is only a "already done" marker, and keeping every PID a
    // long-lived Chromium ever spawned would grow without bound.
    const current = new Set(descendants);
    for (const known of entry.deprioritized) {
      if (!current.has(known)) entry.deprioritized.delete(known);
    }
    this.adoptDescendants(entry);
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
    // Counted once. `state()` is rebuilt on every child starting or finishing,
    // which during a batch is several times a second.
    const activeChildren = this.activeChildren();
    const activity = activeChildren > 0 || this.busy() ? 'active' : 'idle';
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
      activeChildren,
      updatedAt: this.updatedAt
    };
  }

  /**
   * The last thing that runs before the agent exits, and the only guarantee
   * that nothing it started outlives it.
   *
   * Every tool has already had its own graceful shutdown by the time this is
   * reached — the module list is drained first, on purpose. So a child still
   * registered here is one that ignored a SIGTERM, or one whose owner never
   * signalled it at all, and there is nothing left to wait for: once this
   * process exits, nothing reaps its children, nothing can find them, and a
   * full-speed whisper or FFmpeg would keep the machine hot behind an app that
   * is no longer running. That is the failure this exists to make impossible,
   * and it is the same failure at the other end of an update handoff, where the
   * replacement agent reports itself idle over a machine the old one is still
   * pinning.
   *
   * Killed outright rather than asked politely: a graceful signal would need a
   * grace period to mean anything, and holding an exiting process open on the
   * chance that an already-unresponsive child changes its mind trades a certain
   * fix for a possible hang.
   */
  async shutdown(): Promise<void> {
    this.stopCycle();
    this.stopTreeTracking();
    this.treeWatchers = 0;
    for (const entry of this.children.values()) {
      // Resume first: SIGKILL reaches a stopped process, but its descendants
      // are signalled by bare PID and a tree left half-stopped behind a killed
      // root is exactly what nothing else can clean up.
      if (this.isStopped(entry)) this.resume(entry);
      if (!entry.live) continue;
      try {
        // Through the ChildProcess handle, never the raw PID: Node drops the
        // handle once the child is reaped, so this can never signal a PID the
        // OS has since recycled onto something unrelated.
        entry.child.kill('SIGKILL');
      } catch (error) {
        this.onError(error, 'Could not stop a managed child process during shutdown');
      }
    }
    this.children.clear();
    // Only after everything is resumed: on Windows the helper IS the resume
    // mechanism, so tearing it down first would strand suspended processes.
    await shutdownProcessPause();
  }

  /* ── duty cycling ─────────────────────────────────────────────────────── */

  private retune(): void {
    // Only while something is managed. An agent with nothing running has nothing to be
    // woken up for, and holding a timer at idle would be at odds with the whole point of
    // a governor.
    if (this.children.size > 0) this.startWakeProbe();
    else this.stopWakeProbe();
    const { dutyOnFraction } = this.budget();
    const shouldCycle = dutyOnFraction < 1 && this.pauseSupported && this.children.size > 0;
    if (!shouldCycle) {
      this.stopCycle();
      // Leaving the limit means nothing stays stopped on our account, but a
      // caller's hold still stands.
      for (const entry of this.children.values()) {
        if (this.isStopped(entry) && entry.holds.size === 0) this.resume(entry);
      }
      this.updateTreeTracking();
      return;
    }
    this.updateTreeTracking();
    if (!this.cycleTimer) this.startCycle();
  }

  private startCycle(): void {
    const tick = () => {
      const { dutyOnFraction } = this.budget();
      if (dutyOnFraction >= 1) {
        this.stopCycle();
        return;
      }
      const { onMs, offMs } = dutyWindows(dutyOnFraction);
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

  /* ── sleep and wake ───────────────────────────────────────────────────── */

  /**
   * Notices that the machine stopped running and started again (FR-009a).
   *
   * There is no portable notification for this, so it is read off the wall clock: a probe
   * that finds far more time gone than it slept for was not late, it was suspended along
   * with everything else.
   *
   * Worth detecting because the duty cycler is built out of wall-clock timers, and a
   * suspend lands in the middle of one of its windows — with a child stopped, waiting for
   * a timer whose relationship to the cycle it belongs to no longer holds. Rather than
   * reason about which window it was, the cycle is torn down and rebuilt from a known
   * point, and anything stopped only on the cycler's account is resumed first.
   */
  private startWakeProbe(): void {
    if (this.wakeProbe) return;
    this.lastProbeAt = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastProbeAt;
      this.lastProbeAt = now;
      // Generously past the probe's own period, so ordinary event-loop lateness under a
      // machine at its limit — which is the normal state here — is never read as a sleep.
      if (elapsed < WAKE_PROBE_MS + WAKE_GAP_MS) return;
      this.wake();
    }, WAKE_PROBE_MS);
    // Never hold the process open to watch for a wake.
    timer.unref();
    this.wakeProbe = timer;
  }

  private stopWakeProbe(): void {
    if (!this.wakeProbe) return;
    clearInterval(this.wakeProbe);
    this.wakeProbe = null;
  }

  private wake(): void {
    this.stopCycle();
    for (const entry of this.children.values()) {
      if (this.isStopped(entry) && entry.holds.size === 0) this.resume(entry);
    }
    this.retune();
    // Told, not inferred: the governor knows the machine slept, and the queue knows
    // whether what it had running is still there.
    this.onWake?.();
    this.onChange?.();
  }

  private resumeAll(): void {
    for (const entry of this.children.values()) {
      if (entry.holds.size > 0 || entry.terminating) continue;
      if (this.isStopped(entry)) this.resume(entry);
    }
  }

  private suspendAll(): void {
    for (const entry of this.children.values()) {
      if (this.holdsTerminationPin(entry)) continue;
      // Re-entering `suspend` on an already-stopped root is what catches
      // descendants that appeared during the on-window; it is a no-op for the
      // ones already held.
      this.suspend(entry);
    }
  }

  /**
   * True while a child is still pinned resumed for a termination in flight.
   *
   * The pin ages out here, on the cycler's own tick, so no clock is involved:
   * a child that outlives `TERMINATION_PIN_CYCLES` periods clearly survived the
   * signal that was meant to end it, and must come back under the limit.
   */
  private holdsTerminationPin(entry: ManagedChild): boolean {
    if (!entry.terminating) return false;
    entry.terminationPinCycles += 1;
    if (entry.terminationPinCycles <= TERMINATION_PIN_CYCLES) return true;
    entry.terminating = false;
    return false;
  }

  /**
   * Stops a managed child AND the descendants it has fanned out to.
   *
   * The root alone is not enough. Playwright's Chromium is a broker that does
   * almost no work itself: stopping it leaves every renderer running at full
   * speed, so the limit would be honoured on paper while the machine stayed
   * pinned — and the readout, which *does* count descendants, would show it.
   *
   * The root goes first so it cannot fork more children into the gap; anything
   * it manages to start anyway is caught by the next tree refresh.
   */
  private suspend(entry: ManagedChild): void {
    // Never signal a PID whose process has already gone: the OS may have
    // recycled it onto something unrelated.
    if (!entry.live) return;
    if (entry.terminating) return;
    try {
      if (!entry.suspended && pauseProcess(entry.child)) entry.suspended = true;
    } catch (error) {
      this.onError(error, 'Could not suspend a managed child process');
    }
    this.suspendDescendants(entry, entry.descendants);
  }

  /**
   * Stops `pids` on `entry`'s behalf. Only ever called with PIDs a snapshot no
   * older than `TREE_REFRESH_MS` reported beneath this child — there is no
   * reaped-child guard on a bare PID, so recency is the whole protection
   * against signalling a recycled one.
   */
  private suspendDescendants(entry: ManagedChild, pids: readonly number[]): void {
    for (const pid of pids) {
      if (entry.suspendedDescendants.has(pid)) continue;
      try {
        if (this.descendantSignals.pause(pid)) entry.suspendedDescendants.add(pid);
      } catch (error) {
        this.onError(error, 'Could not suspend a descendant of a managed child process');
      }
    }
  }

  /**
   * Resumes the tree, descendants first so none of them is left stopped behind
   * a root that has already been let go.
   *
   * Every PID we ever stopped is resumed, not just the ones still in the tree:
   * a descendant that has been reparented away is still stopped, and we are the
   * only thing that knows it. SIGCONT to a PID that has since been recycled is
   * harmless — it is a no-op against a process that is not stopped.
   */
  private resume(entry: ManagedChild): void {
    for (const pid of entry.suspendedDescendants) {
      try {
        this.descendantSignals.resume(pid);
      } catch (error) {
        this.onError(error, 'Could not resume a descendant of a managed child process');
      }
    }
    entry.suspendedDescendants.clear();
    try {
      resumeProcess(entry.child);
    } catch (error) {
      this.onError(error, 'Could not resume a managed child process');
    }
    entry.suspended = false;
  }

  /* ── descendant tracking ──────────────────────────────────────────────── */

  /**
   * Keeps the descendant tree fresh for a consumer that needs it for
   * measurement rather than control; the returned teardown releases it.
   *
   * Control-side tracking turns itself on and off with the duty cycler, so this
   * exists only for the sampler: at 100% nothing is being suspended, but the
   * readout must still count Chromium's renderers when someone is watching.
   */
  retainTree(): () => void {
    this.treeWatchers += 1;
    this.updateTreeTracking();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.treeWatchers = Math.max(0, this.treeWatchers - 1);
      this.updateTreeTracking();
    };
  }

  /**
   * Runs the tree walk exactly when someone needs it: while the cycler has
   * children to hold down, or while a viewer is measuring. A walk shells out to
   * the process table, so leaving it running for an agent nobody is watching
   * would be a cost with no reader.
   */
  private updateTreeTracking(): void {
    if (!this.treeTrackingNeeded()) return;
    if (this.treeTimer) return;
    const timer = setInterval(() => {
      // Whether tracking is still wanted is decided HERE rather than at every
      // register/release. Short-lived tools — the estimator fires off
      // sub-second `ffprobe` calls one after another — would otherwise tear the
      // timer down between spawns and rebuild it on the next one, and every
      // rebuild walks the process table immediately. Letting the timer outlive
      // one interval collapses a walk-per-spawn back to a walk-per-period.
      if (!this.treeTrackingNeeded()) {
        this.stopTreeTracking();
        return;
      }
      void this.refreshTree();
    }, TREE_REFRESH_MS);
    // Never hold the process open on the tree tracker's account.
    timer.unref();
    this.treeTimer = timer;
    void this.refreshTree();
  }

  private treeTrackingNeeded(): boolean {
    return (
      this.children.size > 0 &&
      (this.treeWatchers > 0 || (this.pauseSupported && this.budget().dutyOnFraction < 1))
    );
  }

  private stopTreeTracking(): void {
    if (!this.treeTimer) return;
    clearInterval(this.treeTimer);
    this.treeTimer = null;
  }

  /** Exposed for tests; the interval calls it. */
  async refreshTree(): Promise<void> {
    // A slow process table must not stack walks on top of each other.
    if (this.treeInFlight) return;
    const roots = this.childPids();
    if (roots.length === 0) return;
    this.treeInFlight = true;
    try {
      const rows = await this.probeProcessTable();
      // One index over the whole table, then one walk per root. Calling
      // `descendantsOf` per child would rebuild that index — hundreds of rows —
      // once for every managed process on every refresh.
      const byRoot = descendantsByRoot(rows, roots);
      for (const root of roots) this.setDescendants(root, byRoot.get(root) ?? []);
    } catch (error) {
      this.onError(error, 'Could not walk the process tree of a managed child');
    } finally {
      this.treeInFlight = false;
    }
  }

  /**
   * Brings newly discovered descendants under the rules already in force for
   * their root: stopped if the root is currently stopped, and de-prioritised if
   * a limit is set. Without this a tool that forks during an off-window would
   * run unthrottled until the root's next full suspend.
   */
  private adoptDescendants(entry: ManagedChild): void {
    const { priority } = this.budget();
    if (priority !== null) {
      for (const pid of entry.descendants) {
        if (entry.deprioritized.has(pid)) continue;
        entry.deprioritized.add(pid);
        try {
          this.descendantSignals.setPriority(pid, priority);
        } catch {
          // Priority is politeness, never a requirement.
        }
      }
    }
    if (entry.suspended && !entry.terminating) this.suspendDescendants(entry, entry.descendants);
  }
}
