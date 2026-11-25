import { spawn, type ChildProcess } from 'node:child_process';

/**
 * The graphics processor's utilisation on Windows, as Task Manager shows it.
 *
 * Windows publishes it as the `GPU Engine` performance counters: one instance per process
 * per engine, each with a `Utilization Percentage`. Task Manager's figure is the busiest
 * engine with every process's share of it added up, and that is what this computes.
 *
 * **Why a resident helper.** Reading the counters from Node needs either a native module
 * (nothing to package and sign for one number) or a PowerShell, which takes a few hundred
 * milliseconds to start — far too slow to pay every two seconds. The same answer as the
 * suspend helper (platform/windows-suspend.ts): one long-lived PowerShell that answers a
 * line on stdin with a line on stdout. Closing stdin ends it, so it cannot outlive the agent.
 *
 * **Why `PerformanceCounterCategory.ReadCategory` and not `Get-Counter` or `typeperf`.**
 * Those two take counter paths in the system's display language — `\GPU Engine(*)\…` does
 * not exist on a Ukrainian Windows — while .NET resolves the English names everywhere. One
 * call reads every instance's raw sample; the rate is computed against the previous read,
 * so a request returns at once instead of waiting out a sampling interval.
 */

/**
 * The helper program. A compile-time constant; it reads one fixed word and nothing from the
 * request ever reaches the shell.
 *
 * Answers `g` with a whole percent, or `-` when it has no figure: the first read has nothing
 * to difference against, and a machine without the category (no WDDM 2 driver) never will.
 * The instance name is `pid_<n>_luid_…_eng_<k>_engtype_<kind>`; dropping the `pid_<n>_`
 * prefix leaves the engine, so the sum per key is that engine's load from every process.
 */
export const GRAPHICS_HELPER_SCRIPT = [
  '$ErrorActionPreference = "Stop";',
  '$category = $null;',
  'try { $category = New-Object System.Diagnostics.PerformanceCounterCategory("GPU Engine") } catch { }',
  '$previous = @{};',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  if ($line -ne "g") { continue }',
  '  $answer = "-";',
  '  try {',
  '    if ($null -ne $category) {',
  '      $data = $category.ReadCategory()["utilization percentage"];',
  '      $current = @{}; $engines = @{};',
  '      if ($null -ne $data) {',
  '        foreach ($instance in $data.Values) {',
  '          $name = $instance.InstanceName; $sample = $instance.Sample;',
  '          $current[$name] = $sample;',
  '          if ($previous.ContainsKey($name)) {',
  '            $value = [System.Diagnostics.CounterSample]::Calculate($previous[$name], $sample);',
  "            $engine = $name -replace '^pid_[0-9]+_', '';",
  '            if ($engines.ContainsKey($engine)) { $engines[$engine] += $value } else { $engines[$engine] = $value }',
  '          }',
  '        }',
  '      }',
  '      if ($previous.Count -gt 0) {',
  '        $max = 0.0;',
  '        foreach ($v in $engines.Values) { if ($v -gt $max) { $max = $v } }',
  '        $answer = [string][int][Math]::Round([Math]::Min(100.0, [Math]::Max(0.0, $max)));',
  '      }',
  '      $previous = $current;',
  '    }',
  '  } catch { $answer = "-" }',
  '  [Console]::Out.WriteLine($answer);',
  '  [Console]::Out.Flush();',
  '}'
].join('\n');

/** A reply slower than this is a wedged helper; the reading is reported as unknown. */
const REPLY_TIMEOUT_MS = 1_500;
/** A helper that dies sooner than this after starting never reached its read loop. */
const EARLY_DEATH_MS = 1_000;
/** Starts that did not take before the helper is given up on for the session. */
const MAX_FAILED_STARTS = 3;

export interface WindowsGraphicsProbeOptions {
  /** Injectable for tests; defaults to spawning the real PowerShell helper. */
  spawnHelper?: () => ChildProcess;
  onError?: (error: unknown, message: string) => void;
  now?: () => number;
}

export class WindowsGraphicsProbe {
  private helper: ChildProcess | null = null;
  private readonly spawnHelper: () => ChildProcess;
  private readonly onError: (error: unknown, message: string) => void;
  private readonly now: () => number;
  private failedStarts = 0;
  private buffered = '';
  /** The one outstanding request; requests are never stacked. */
  private waiting: ((line: string | null) => void) | null = null;

  constructor(options: WindowsGraphicsProbeOptions = {}) {
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.spawnHelper =
      options.spawnHelper ??
      (() =>
        spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', GRAPHICS_HELPER_SCRIPT],
          { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
        ));
  }

  /** True once the helper has failed to start often enough to stop trying. */
  disabled(): boolean {
    return this.failedStarts >= MAX_FAILED_STARTS;
  }

  running(): boolean {
    return this.helper !== null;
  }

  /** The current utilisation, or null when there is no figure to give. */
  async read(): Promise<number | null> {
    if (this.waiting) return null;
    const helper = this.ensureHelper();
    if (!helper?.stdin?.writable) return null;
    const reply = new Promise<string | null>(resolve => {
      const timer = setTimeout(() => {
        if (this.waiting === settle) this.waiting = null;
        resolve(null);
      }, REPLY_TIMEOUT_MS);
      timer.unref();
      const settle = (line: string | null) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiting = settle;
    });
    try {
      helper.stdin.write('g\n');
    } catch (error) {
      this.settle(null);
      this.onError(error, 'Could not reach the Windows graphics helper');
      return null;
    }
    return parseGraphicsReply(await reply);
  }

  /** Ends the helper. Closing stdin ends its loop; a later `read` starts a fresh one. */
  stop(): void {
    const helper = this.helper;
    this.helper = null;
    this.buffered = '';
    this.settle(null);
    if (!helper) return;
    try {
      helper.stdin?.end();
    } catch {
      helper.kill();
    }
  }

  private settle(line: string | null): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.(line);
  }

  private ensureHelper(): ChildProcess | null {
    if (this.disabled()) return null;
    if (this.helper) return this.helper;
    try {
      const startedAt = this.now();
      const helper = this.spawnHelper();
      helper.stdout?.setEncoding?.('utf8');
      helper.stdout?.on('data', (chunk: string | Buffer) => {
        this.buffered += String(chunk);
        let newline = this.buffered.indexOf('\n');
        while (newline >= 0) {
          const line = this.buffered.slice(0, newline).trim();
          this.buffered = this.buffered.slice(newline + 1);
          this.settle(line);
          newline = this.buffered.indexOf('\n');
        }
      });
      helper.once('close', () => {
        if (this.helper !== helper) return;
        this.helper = null;
        this.settle(null);
        if (this.now() - startedAt < EARLY_DEATH_MS) this.noteFailedStart();
      });
      helper.once('error', error => {
        if (this.helper === helper) this.helper = null;
        this.settle(null);
        this.noteFailedStart(error);
      });
      this.helper = helper;
      return helper;
    } catch (error) {
      this.noteFailedStart(error);
      return null;
    }
  }

  private noteFailedStart(error?: unknown): void {
    this.failedStarts += 1;
    if (this.failedStarts === MAX_FAILED_STARTS) {
      this.onError(
        error ?? new Error('The Windows graphics helper exited on start'),
        'The Windows graphics helper could not start; the load readout will show the processor only'
      );
    }
  }
}

/** One reply line to a percent; anything but a whole number in range is "unknown". */
export function parseGraphicsReply(line: string | null): number | null {
  if (line === null || !/^\d{1,3}$/u.test(line)) return null;
  const value = Number(line);
  return value >= 0 && value <= 100 ? value : null;
}
