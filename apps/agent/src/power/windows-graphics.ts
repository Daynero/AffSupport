import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Soty's own processor and graphics figures on Windows, from one resident helper.
 *
 * **Graphics.** Windows publishes them as the `GPU Engine` performance counters: one
 * instance per process per engine, each with a `Utilization Percentage`, and the instance
 * name begins with the PID (`pid_<n>_luid_…_eng_<k>_engtype_<kind>`). So, unlike on a Mac's
 * device figure, the work is attributable: the helper sums the instances of the PIDs it is
 * asked about per engine and answers with the busiest engine — Task Manager's per-process
 * "GPU" column, for Soty's tree rather than one process.
 *
 * **Processor.** The same request answers each PID's cumulative processor time
 * (`Process.TotalProcessorTime`), which the agent differences per process exactly as it does
 * `ps`'s on macOS. Asking a resident helper is what makes once a second affordable: the
 * alternative is a fresh PowerShell per reading, a few hundred milliseconds of CPU each.
 *
 * **Why a resident helper.** Reading either from Node needs a native module (nothing to
 * package and sign for two numbers) or a PowerShell, which is far too slow to start every
 * second. The same answer as the suspend helper (platform/windows-suspend.ts): one
 * long-lived PowerShell that answers a line on stdin with a line on stdout. Closing stdin
 * ends it, so it cannot outlive the agent. It is started on the first reading taken while
 * Soty has a process running; an idle Soty never starts it.
 *
 * **Why `PerformanceCounterCategory.ReadCategory` and not `Get-Counter` or `typeperf`.**
 * Those two take counter paths in the system's display language — `\GPU Engine(*)\…` does
 * not exist on a Ukrainian Windows — while .NET resolves the English names everywhere. One
 * call reads every instance's raw sample; the rate is computed against the previous read,
 * so a request returns at once instead of waiting out a sampling interval.
 */

/**
 * The helper program. A compile-time constant; the only thing a request carries into it is
 * a list the agent built from integers, and the script re-checks every token as digits
 * before using it, so nothing from a request ever reaches the shell as code.
 *
 * A request is `c <pid>,<pid>…` (processor only) or `g <pid>,<pid>…` (graphics too). The
 * reply is one line: the graphics figure first — a whole percent, or `-` when there is
 * none (a `c` request, the first `g` with nothing to difference against, a baseline older
 * than five seconds, a machine without the category) — then `<pid>:<seconds>` for every
 * listed PID still running, seconds in the invariant culture so a Ukrainian decimal comma
 * never reaches the parser.
 */
export const GRAPHICS_HELPER_SCRIPT = [
  '$ErrorActionPreference = "Stop";',
  '$category = $null;',
  'try { $category = New-Object System.Diagnostics.PerformanceCounterCategory("GPU Engine") } catch { }',
  '$invariant = [System.Globalization.CultureInfo]::InvariantCulture;',
  '$previous = @{};',
  '$previousAt = [DateTime]::MinValue;',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  "  if (-not ($line -match '^([cg]) ([0-9,]*)$')) { continue }",
  '  $mode = $Matches[1]; $listed = $Matches[2];',
  '  $wanted = @{};',
  "  foreach ($token in ($listed -split ',')) { if ($token -match '^[0-9]{1,10}$') { $wanted[$token] = $true } }",
  '  $graphics = "-";',
  '  if ($mode -eq "g" -and $null -ne $category) {',
  '    try {',
  '      $now = [DateTime]::UtcNow;',
  '      $fresh = ($now - $previousAt).TotalSeconds -le 5;',
  '      $data = $category.ReadCategory()["utilization percentage"];',
  '      $current = @{}; $engines = @{};',
  '      if ($null -ne $data) {',
  '        foreach ($instance in $data.Values) {',
  '          $name = $instance.InstanceName;',
  "          if (-not ($name -match '^pid_([0-9]+)_')) { continue }",
  '          if (-not $wanted.ContainsKey($Matches[1])) { continue }',
  '          $sample = $instance.Sample;',
  '          $current[$name] = $sample;',
  '          if ($fresh -and $previous.ContainsKey($name)) {',
  '            $value = [System.Diagnostics.CounterSample]::Calculate($previous[$name], $sample);',
  "            $engine = $name -replace '^pid_[0-9]+_', '';",
  '            if ($engines.ContainsKey($engine)) { $engines[$engine] += $value } else { $engines[$engine] = $value }',
  '          }',
  '        }',
  '      }',
  '      if ($fresh) {',
  '        $max = 0.0;',
  '        foreach ($v in $engines.Values) { if ($v -gt $max) { $max = $v } }',
  '        $graphics = [string][int][Math]::Round([Math]::Min(100.0, [Math]::Max(0.0, $max)));',
  '      }',
  '      $previous = $current; $previousAt = $now;',
  '    } catch { $graphics = "-" }',
  '  }',
  '  $parts = New-Object System.Collections.Generic.List[string];',
  '  $parts.Add($graphics);',
  '  foreach ($id in $wanted.Keys) {',
  '    try {',
  '      $process = [System.Diagnostics.Process]::GetProcessById([int]$id);',
  '      $parts.Add($id + ":" + $process.TotalProcessorTime.TotalSeconds.ToString("R", $invariant));',
  '      $process.Dispose();',
  '    } catch { }',
  '  }',
  '  [Console]::Out.WriteLine([string]::Join(" ", $parts));',
  '  [Console]::Out.Flush();',
  '}'
].join('\n');

/** What one request answers. */
export interface WindowsTreeReading {
  /** Cumulative processor seconds per PID still running. */
  cpuSeconds: Map<number, number>;
  /** The tree's graphics share, null when there is none; undefined when not asked for. */
  graphicsPercent?: number | null;
}

/** A reply slower than this is a wedged helper; the reading is reported as unknown. */
const REPLY_TIMEOUT_MS = 1_500;
/** A helper that dies sooner than this after starting never reached its read loop. */
const EARLY_DEATH_MS = 1_000;
/** Starts that did not take before the helper is given up on for the session. */
const MAX_FAILED_STARTS = 3;

export interface WindowsLoadProbeOptions {
  /** Injectable for tests; defaults to spawning the real PowerShell helper. */
  spawnHelper?: () => ChildProcess;
  onError?: (error: unknown, message: string) => void;
  now?: () => number;
}

export class WindowsLoadProbe {
  private helper: ChildProcess | null = null;
  private readonly spawnHelper: () => ChildProcess;
  private readonly onError: (error: unknown, message: string) => void;
  private readonly now: () => number;
  private failedStarts = 0;
  private buffered = '';
  /** The one outstanding request; requests are never stacked. */
  private waiting: ((line: string | null) => void) | null = null;

  constructor(options: WindowsLoadProbeOptions = {}) {
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

  /**
   * The processor times of `pids`, and their graphics share when `withGraphics`; null when
   * the helper is busy, slow, gone or disabled, which the caller counts as a missed reading.
   */
  async read(pids: readonly number[], withGraphics: boolean): Promise<WindowsTreeReading | null> {
    if (this.waiting) return null;
    const helper = this.ensureHelper();
    if (!helper?.stdin?.writable) return null;
    const reply = new Promise<string | null>(resolve => {
      const timer = setTimeout(() => {
        if (this.waiting === settle) this.waiting = null;
        resolve(null);
        // A reply that arrives after this would answer the NEXT request, and every reading
        // from then on would be one behind. A wedged helper is ended; the next read starts
        // a fresh one.
        if (this.helper === helper) this.stop();
      }, REPLY_TIMEOUT_MS);
      timer.unref();
      const settle = (line: string | null) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiting = settle;
    });
    try {
      helper.stdin.write(helperRequest(pids, withGraphics));
    } catch (error) {
      this.settle(null);
      this.onError(error, 'Could not reach the Windows load helper');
      return null;
    }
    const reading = parseHelperReply(await reply);
    if (reading && !withGraphics) delete reading.graphicsPercent;
    return reading;
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
        error ?? new Error('The Windows load helper exited on start'),
        'The Windows load helper could not start; the header shows the plain bolt'
      );
    }
  }
}

/** The request line. Only positive integers ever reach it; anything else is dropped here. */
export function helperRequest(pids: readonly number[], withGraphics: boolean): string {
  const listed = pids.filter(pid => Number.isInteger(pid) && pid > 0 && pid < 1e10);
  return `${withGraphics ? 'g' : 'c'} ${listed.join(',')}\n`;
}

/**
 * One reply line to a reading; null for anything that is not one.
 *
 * The graphics figure must be a whole percent in range or `-`; a malformed one makes the
 * whole line suspect. A malformed `<pid>:<seconds>` pair is only that PID's loss.
 */
export function parseHelperReply(line: string | null): WindowsTreeReading | null {
  if (line === null) return null;
  const [head, ...pairs] = line.trim().split(/\s+/u);
  if (head === undefined) return null;
  let graphicsPercent: number | null;
  if (head === '-') graphicsPercent = null;
  else if (/^\d{1,3}$/u.test(head) && Number(head) <= 100) graphicsPercent = Number(head);
  else return null;
  const cpuSeconds = new Map<number, number>();
  for (const pair of pairs) {
    const matched = /^(\d{1,10}):(\d+(?:\.\d+)?(?:E[+-]?\d+)?)$/iu.exec(pair);
    if (!matched) continue;
    const pid = Number(matched[1]);
    const seconds = Number(matched[2]);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(seconds) && seconds >= 0)
      cpuSeconds.set(pid, seconds);
  }
  return { cpuSeconds, graphicsPercent };
}
