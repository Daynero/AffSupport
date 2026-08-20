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
 */
const HELPER_SCRIPT = [
  '$ErrorActionPreference = "Stop";',
  'Add-Type -Namespace Soty -Name Nt -MemberDefinition @"',
  '[DllImport("ntdll.dll")] public static extern uint NtSuspendProcess(IntPtr handle);',
  '[DllImport("ntdll.dll")] public static extern uint NtResumeProcess(IntPtr handle);',
  '"@;',
  'while ($line = [Console]::In.ReadLine()) {',
  '  $parts = $line.Split(" ");',
  '  if ($parts.Length -ne 2) { continue }',
  '  $verb = $parts[0]; $pid = 0;',
  '  if (-not [int]::TryParse($parts[1], [ref]$pid)) { continue }',
  '  try {',
  '    $handle = (Get-Process -Id $pid -ErrorAction Stop).Handle;',
  '    if ($verb -eq "s") { [Soty.Nt]::NtSuspendProcess($handle) | Out-Null }',
  '    elseif ($verb -eq "r") { [Soty.Nt]::NtResumeProcess($handle) | Out-Null }',
  '  } catch { }',
  '}'
].join('\n');

const SHUTDOWN_GRACE_MS = 2_000;

export interface WindowsSuspendHelperOptions {
  /** Injectable for tests; defaults to spawning the real PowerShell helper. */
  spawnHelper?: () => ChildProcess;
  onError?: (error: unknown, message: string) => void;
}

export class WindowsSuspendHelper {
  private helper: ChildProcess | null = null;
  private readonly spawnHelper: () => ChildProcess;
  private readonly onError: (error: unknown, message: string) => void;
  private stopped = false;

  constructor(options: WindowsSuspendHelperOptions = {}) {
    this.onError = options.onError ?? (() => {});
    this.spawnHelper =
      options.spawnHelper ??
      (() =>
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HELPER_SCRIPT], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'ignore']
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

  async shutdown(): Promise<void> {
    this.stopped = true;
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
    const helper = this.ensureHelper();
    if (!helper?.stdin?.writable) return false;
    try {
      return helper.stdin.write(`${verb} ${pid}\n`);
    } catch (error) {
      this.onError(error, 'Could not reach the Windows suspend helper');
      return false;
    }
  }

  /**
   * Started lazily, so a user who never reduces the limit never pays for a
   * resident PowerShell process. Respawned if it dies, rather than leaving the
   * governor unable to throttle for the rest of the session.
   */
  private ensureHelper(): ChildProcess | null {
    if (this.stopped) return null;
    if (this.helper) return this.helper;
    try {
      const helper = this.spawnHelper();
      helper.once('close', () => {
        if (this.helper === helper) this.helper = null;
      });
      helper.once('error', error => {
        if (this.helper === helper) this.helper = null;
        this.onError(error, 'The Windows suspend helper could not start');
      });
      this.helper = helper;
      return helper;
    } catch (error) {
      this.onError(error, 'The Windows suspend helper could not start');
      return null;
    }
  }
}
