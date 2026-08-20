import os from 'node:os';
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions
} from 'node:child_process';
import type { CpuBudget } from './governor.js';

/**
 * The single seam every heavy child process passes through.
 *
 * This exists because "one shared budget across all tools" and "a tool added
 * later is covered by default" cannot be delivered by a convention each tool has
 * to remember — there are already twenty-odd spawn sites in this codebase, and
 * the twenty-first would forget. An ESLint rule bans `node:child_process`
 * everywhere else under `apps/agent/src`, so a new tool cannot escape the budget
 * without deliberately editing the lint config.
 *
 * Light spawns (`-version` probes, native dialogs, `mdfind`) stay outside: they
 * finish in milliseconds, so throttling them would be pure overhead.
 */

/**
 * What a spawn site needs from the governor. Structural, so tools depend on the
 * capability rather than the concrete class — and so a bare test assembly can
 * pass `null` and get exactly the unmanaged behaviour it had before.
 */
export interface ManagedSpawnGovernor {
  register(child: ChildProcess, options: { toolId: string }): void;
  release(child: ChildProcess): void;
  budget(): CpuBudget;
  /** Stretches a wall-clock deadline to match the limit in force. */
  scaleTimeout(milliseconds: number): number;
  /** Resumes a child and pins it resumed, so a termination signal reaches it. */
  resumeForTermination(child: ChildProcess): void;
}

export interface ManagedSpawnOptions extends SpawnOptions {
  /** Which tool is spawning. Diagnostics only; the budget is shared regardless. */
  toolId: string;
}

/**
 * Spawns a child, registers it with the governor for the lifetime of the
 * process, and applies the current scheduling priority.
 *
 * Deregistration is guaranteed on BOTH `close` and `error`. A leaked entry
 * would keep the duty cycler signalling a PID the OS may have recycled onto an
 * unrelated process.
 */
export function spawnManaged(
  governor: ManagedSpawnGovernor | null,
  command: string,
  args: readonly string[],
  options: ManagedSpawnOptions & { stdio?: undefined }
): ChildProcessWithoutNullStreams;
export function spawnManaged(
  governor: ManagedSpawnGovernor | null,
  command: string,
  args: readonly string[],
  options: ManagedSpawnOptions
): ChildProcess;
export function spawnManaged(
  governor: ManagedSpawnGovernor | null,
  command: string,
  args: readonly string[],
  options: ManagedSpawnOptions
): ChildProcess {
  const { toolId, ...spawnOptions } = options;
  // `shell: false` is not negotiable: a filename interpolated into a shell
  // string is a command-injection hole.
  const child = spawn(command, args as string[], { ...spawnOptions, shell: false });
  if (!governor) return child;

  governor.register(child, { toolId });
  applyPriority(governor, child);
  guardTermination(governor, child);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    governor.release(child);
  };
  child.once('close', release);
  child.once('error', release);

  return child;
}

/**
 * Lowers a child's scheduling priority so Soty yields to whatever the user is
 * doing in the foreground.
 *
 * Applied at spawn only, and only when a limit is in force. Two reasons it is
 * never adjusted afterwards: at 100% the process must be indistinguishable from
 * one spawned before this feature existed, and on POSIX an unprivileged process
 * cannot lower its own nice value again, so a "restore" would silently fail.
 * The live ceiling is the duty cycler's job; this is only politeness.
 */
function applyPriority(governor: ManagedSpawnGovernor, child: ChildProcess): void {
  const { priority } = governor.budget();
  if (priority === null || typeof child.pid !== 'number') return;
  try {
    os.setPriority(child.pid, priority);
  } catch {
    // Priority is an optimisation, never a requirement: a platform or policy
    // that refuses it must not fail the job.
  }
}

/**
 * Signals the duty cycler must never be allowed to fight over.
 *
 * SIGSTOP/SIGCONT *are* the throttle. Everything else is a caller trying to end
 * the process, and a stopped process does not receive a terminable signal until
 * something resumes it.
 */
const THROTTLE_SIGNALS = new Set<NodeJS.Signals>(['SIGSTOP', 'SIGCONT']);

/**
 * Makes every termination signal reach a throttled child, whoever sends it.
 *
 * SIGTERM is queued, not delivered, while a process is stopped — so a cancel
 * that lands in a duty cycle's off-window is simply ignored until the next
 * on-window, and a caller that escalates to SIGKILL on a fixed grace period can
 * lose the race outright. The tool then never finalizes its output.
 *
 * This is wrapped at the spawn seam rather than fixed at the ~fifteen `kill`
 * sites for the same reason spawning is: "resume before you signal" is a
 * convention every future tool would have to remember, and the one that forgets
 * fails intermittently and only under a reduced limit. Playwright's browser is
 * the one managed child that does not come through here, so
 * `landing-preview/renderer.ts` makes the same call explicitly.
 */
function guardTermination(governor: ManagedSpawnGovernor, child: ChildProcess): void {
  const nativeKill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (typeof signal !== 'string' || !THROTTLE_SIGNALS.has(signal))
      governor.resumeForTermination(child);
    return nativeKill(signal as NodeJS.Signals | number | undefined);
  };
}

/**
 * The governor this process is running under.
 *
 * Spawn sites buried several call frames deep (whisper, the translators, the
 * static-edge detector) would otherwise have to thread a governor through every
 * intermediate signature, touching dozens of call sites and tests for no
 * behavioural gain. There is exactly one machine, so exactly one budget: a
 * process-scoped registry is the honest model.
 *
 * This is NOT module-level *server* state — `buildServer` still receives the
 * governor explicitly through its deps, so a test can assemble a real server
 * around its own instance. Tests that exercise a spawn site directly install a
 * fake here, or install nothing and get exactly the unmanaged behaviour the
 * code had before this feature.
 */
let activeGovernor: ManagedSpawnGovernor | null = null;

export function setActiveGovernor(governor: ManagedSpawnGovernor | null): void {
  activeGovernor = governor;
}

export function activeGovernorOrNull(): ManagedSpawnGovernor | null {
  return activeGovernor;
}

/** Thread budget for the process-wide governor; null when unrestricted or absent. */
export function activeThreadBudget(): number | null {
  return activeGovernor?.budget().threadBudget ?? null;
}

/**
 * `spawnManaged` bound to the process-wide governor, for deep call sites.
 * Behaviour is identical; it simply saves threading the governor through.
 */
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: ManagedSpawnOptions & { stdio?: undefined }
): ChildProcessWithoutNullStreams;
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: ManagedSpawnOptions
): ChildProcess;
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: ManagedSpawnOptions
): ChildProcess {
  return spawnManaged(activeGovernor, command, args, options);
}
