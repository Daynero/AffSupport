import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Suspend and resume on Windows, which has no SIGSTOP.
 *
 * Without this the whole live half of the power throttle would be macOS-only:
 * thread counts and process priority are fixed at spawn, so the only way to
 * reach work that is already running is to stop and start it. It also repays an
 * existing debt — the compressor's "pause the encode while estimates run" path
 * has been a silent no-op on Windows since it was written.
 *
 * The mechanism is `NtSuspendProcess`/`NtResumeProcess` via a long-lived
 * PowerShell helper. PowerShell is already how this codebase does Windows-only
 * work (the native file dialogs in files/picker.ts), so this adds no new class
 * of dependency and nothing extra to package or sign.
 *
 * Long-lived is what makes it viable: PowerShell takes ~200 ms to start, far
 * too slow to pay per suspend at 5 Hz, but a warm runspace round-trips a stdin
 * command in about a millisecond. One helper serves every tracked process.
 */

/**
 * The helper program. A compile-time constant — never assembled from input —
 * and it reads only integers, so nothing user-influenced reaches the shell.
 *
 * The loop variable is `$target`, NOT `$pid`: `$PID` is a read-only automatic
 * variable holding the host's own process id, and `-Command` runs in the global
 * scope where it is defined. Assigning to it throws — and with
 * `$ErrorActionPreference = "Stop"` set, from outside the `try` block, that
 * terminates the helper on its very first command. Every later suspend would
 * then respawn a fresh PowerShell that dies just as fast, turning the duty
 * cycler into a process-spawn storm.
 */
export const HELPER_SCRIPT = [
  '$ErrorActionPreference = "Stop";',
  'Add-Type -Namespace Soty -Name Nt -MemberDefinition @"',
  '[DllImport("ntdll.dll")] public static extern uint NtSuspendProcess(IntPtr handle);',
  '[DllImport("ntdll.dll")] public static extern uint NtResumeProcess(IntPtr handle);',
  '"@;',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  $parts = $line.Split(" ");',
  '  if ($parts.Length -ne 2) { continue }',
  '  $verb = $parts[0]; $target = 0;',
  '  if (-not [int]::TryParse($parts[1], [ref]$target)) { continue }',
  '  try {',
  '    $handle = (Get-Process -Id $target -ErrorAction Stop).Handle;',
  '    if ($verb -eq "s") { [Soty.Nt]::NtSuspendProcess($handle) | Out-Null }',
  '    elseif ($verb -eq "r") { [Soty.Nt]::NtResumeProcess($handle) | Out-Null }',
  '  } catch { }',
  '}'
].join('\n');

const SHUTDOWN_GRACE_MS = 2_000;

/**
 * A helper that dies sooner than this after starting never reached its read
 * loop, so respawning it would fail exactly the same way.
 */
const EARLY_DEATH_MS = 1_000;

/**
 * How many failed starts before the helper is given up on for the session.
 *
 * Without a ceiling, a helper that cannot run turns the duty cycler into a
 * process-spawn storm: every suspend at 5 Hz would launch another PowerShell
 * that dies immediately. Giving up degrades the throttle to spawn-time limits
 * (thread budget and priority), which is the correct failure direction.
 *
 * It caps suspension only. Resume is bounded by the number of processes already
 * stopped, and refusing it would strand them frozen for the rest of the session.
 */
const MAX_FAILED_STARTS = 3;

export interface WindowsSuspendHelperOptions {
  /** Injectable for tests; defaults to spawning the real PowerShell helper. */
  spawnHelper?: () => ChildProcess;
  onError?: (error: unknown, message: string) => void;
  /** Injectable clock, so tests can age a helper without waiting. */
  now?: () => number;
}

export class WindowsSuspendHelper {
  private helper: ChildProcess | null = null;
  private readonly spawnHelper: () => ChildProcess;
  private readonly onError: (error: unknown, message: string) => void;
  private readonly now: () => number;
  private stopped = false;
  private failedStarts = 0;
  /** Last line of the helper's stderr, so a start failure names its cause. */
  private lastStderr = '';

  constructor(options: WindowsSuspendHelperOptions = {}) {
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.spawnHelper =
      options.spawnHelper ??
      (() =>
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HELPER_SCRIPT], {
          shell: false,
          windowsHide: true,
          // stderr is a pipe, not `ignore`: a helper that cannot start is
          // otherwise completely silent, and the only symptom is a power limit
          // that quietly does nothing.
          stdio: ['pipe', 'ignore', 'pipe']
        }));
  }

  suspend(pid: number): boolean {
    return this.send('s', pid);
  }

  resume(pid: number): boolean {
    return this.send('r', pid);
  }

  /** True once a helper has been started; used by tests and diagnostics. */
  running(): boolean {
    return this.helper !== null;
  }

  /**
   * True once the helper has failed to start often enough to be given up on.
   * Only suspension is refused past this point — see `send`, which always lets
   * a resume try again.
   */
  disabled(): boolean {
    return this.failedStarts >= MAX_FAILED_STARTS;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.failedStarts = 0;
    const helper = this.helper;
    this.helper = null;
    if (!helper) return;
    // Closing stdin ends the read loop cleanly; the escalation is only for a
    // helper that has wedged.
    helper.stdin?.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        helper.kill('SIGKILL');
        resolve();
      }, SHUTDOWN_GRACE_MS);
      timer.unref();
      helper.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private send(verb: 's' | 'r', pid: number): boolean {
    // Validated before it can reach the helper at all. The helper parses
    // integers too, but a PID is the only thing that ever crosses this boundary
    // and it is checked on the side that has the type system.
    if (!Number.isInteger(pid) || pid <= 0) return false;
    // A resume is never refused, whatever the helper's history. Suspension
    // outlives the process that requested it — NtSuspendProcess is not a
    // signal — so a helper that has been given up on may still have left work
    // frozen, and starting one again is the only way back.
    const helper = this.ensureHelper({ force: verb === 'r' });
    if (!helper?.stdin?.writable) return false;
    try {
      // The return value of `write` is deliberately ignored: false means the
      // stream buffered the line rather than flushing it, NOT that the command
      // was lost. Reporting that as a failure would leave the governor
      // believing a process it did stop is still running — and nothing would
      // ever resume it.
      helper.stdin.write(`${verb} ${pid}\n`);
      return true;
    } catch (error) {
      this.onError(error, 'Could not reach the Windows suspend helper');
      return false;
    }
  }

  /**
   * Started lazily, so a user who never reduces the limit never pays for a
   * resident PowerShell process. Respawned if it dies mid-session — but only
   * while it is actually surviving long enough to serve commands. A helper that
   * dies on start is given up on after `MAX_FAILED_STARTS`, because retrying it
   * once per suspend would spawn PowerShell several times a second forever.
   */
  private ensureHelper(options: { force?: boolean } = {}): ChildProcess | null {
    if (this.stopped) return null;
    if (this.disabled() && !options.force) return null;
    if (this.helper) return this.helper;
    try {
      const startedAt = this.now();
      const helper = this.spawnHelper();
      helper.stderr?.on('data', chunk => {
        const text = String(chunk).trim();
        if (text) this.lastStderr = text.split('\n').pop() ?? text;
      });
      helper.once('close', () => {
        if (this.helper !== helper) return;
        this.helper = null;
        if (this.stopped) return;
        // A long-lived helper that exits has simply been lost; only a start
        // that never took counts against the budget.
        if (this.now() - startedAt >= EARLY_DEATH_MS) return;
        this.noteFailedStart();
      });
      helper.once('error', error => {
        if (this.helper === helper) this.helper = null;
        this.noteFailedStart(error);
      });
      this.helper = helper;
      return helper;
    } catch (error) {
      this.noteFailedStart(error);
      return null;
    }
  }

  /**
   * Records a start that did not take, and reports it.
   *
   * Every failure is reported, not just the last: the ceiling on retries caps
   * this at three messages per session, and a limit that quietly does nothing
   * is the exact symptom that would otherwise take a support round-trip to
   * explain. Only the final message says the throttle is degraded for good.
   */
  private noteFailedStart(error?: unknown): void {
    this.failedStarts += 1;
    const detail = this.lastStderr ? `: ${this.lastStderr}` : '';
    this.onError(
      error ?? new Error(`The Windows suspend helper exited on start${detail}`),
      this.disabled()
        ? 'The Windows suspend helper could not start; the power limit will apply at spawn time only'
        : 'The Windows suspend helper could not start; it will be retried'
    );
  }
}
