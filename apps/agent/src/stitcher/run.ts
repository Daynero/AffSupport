/**
 * The one place the stitcher starts a child process.
 *
 * Every rule the constitution puts on child processes is applied here once rather than at
 * each of the dozen call sites: an argument array with no shell, a result object instead of
 * a rejection, bounded stderr, and a live reference the queue can escalate SIGTERM → SIGKILL
 * against. A tool failure is data, not an exception.
 */

import type { ChildProcess } from 'node:child_process';
import { activeGovernorOrNull, spawnTracked } from '../power/spawn.js';
import { processCpuSeconds, processMetricsSupported } from '../platform/platform.js';

/** Enough stderr to diagnose a failure, never enough to grow without bound. */
const STDERR_TAIL_BYTES = 4_000;

/**
 * 072: how long a child may go without writing anything and without using any CPU before it is
 * taken for stuck rather than slow. A stuck FFmpeg used to be stopped only by the six-hour
 * watchdog of the whole run, while its heartbeat kept the round looking alive. Scaled by the
 * power limit like every other wall-clock budget. Real work always moves one of the two: a
 * progress line, a log line, or CPU time.
 */
export const TOOL_STALL_MS = 10 * 60_000;
const STALL_CHECK_MS = 60_000;

/** CPU seconds the child has used so far; null when this host cannot say (never "stuck"). */
async function childCpuSeconds(pid: number): Promise<number | null> {
  if (!processMetricsSupported()) return null;
  try {
    return (await processCpuSeconds([pid])).get(pid) ?? null;
  } catch {
    return null;
  }
}

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary could not be started at all (ENOENT and friends). */
  spawnErrorCode: string | null;
  cancelled: boolean;
  /** 072: stopped because it wrote nothing and used no CPU for `TOOL_STALL_MS`. */
  stalled?: boolean;
}

export interface RunOptions {
  /** Operation-owned working directory; fixed relative filter assets need no path quoting. */
  cwd?: string;
  /** Progress-only tools do not need an ever-growing copy of their stdout. */
  captureStdout?: boolean;
  /** Called with the live child so a caller can stop it. */
  onChild?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  /** Already-scaled milliseconds before SIGKILL follows SIGTERM. */
  killAfterMs?: number;
  /**
   * Each complete line of stdout as it arrives.
   *
   * For `-progress pipe:1`, which reports a running job in `key=value` lines. The whole of
   * stdout is still collected and returned, so a caller that parses the finished output is
   * unaffected by anyone watching it live.
   */
  onLine?: (line: string) => void;
  /** 072: already-scaled stall budget; `null` turns the check off. Test seam. */
  stallMs?: number | null;
  /** Test seams for the stall check: how often it looks, and how it reads CPU time. */
  stallCheckMs?: number;
  cpuSeconds?: (pid: number) => Promise<number | null>;
}

export function runTool(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<ToolResult> {
  options = { ...options };
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let terminationRequested = false;
    let stalled = false;
    let spawnErrorCode: string | null = null;
    let lastActivity = Date.now();

    const child = spawnTracked(command, args, {
      toolId: 'stitcher',
      ...(options.cwd ? { cwd: options.cwd } : {})
    });

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      cleanUp();
      resolve(stalled ? { ...result, stalled: true } : result);
    };

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      child.kill('SIGTERM');
      if (settled) return;
      killTimer = setTimeout(
        () => child.kill('SIGKILL'),
        options.killAfterMs ?? activeGovernorOrNull()?.scaleTimeout(4_000) ?? 4_000
      );
      killTimer.unref();
    };
    const stop = () => {
      if (settled || cancelled) return;
      cancelled = true;
      terminate();
    };

    const stallMs =
      options.stallMs === undefined
        ? (activeGovernorOrNull()?.scaleTimeout(TOOL_STALL_MS) ?? TOOL_STALL_MS)
        : options.stallMs;
    const cpuSeconds = options.cpuSeconds ?? childCpuSeconds;
    let lastCpu: number | null = null;
    let sampling = false;
    const watch =
      stallMs === null
        ? null
        : setInterval(() => {
            if (settled || terminationRequested || sampling) return;
            const checkMs = options.stallCheckMs ?? STALL_CHECK_MS;
            if (Date.now() - lastActivity < checkMs) return;
            // A child the power limit or a person's pause holds is not stuck.
            const governor = activeGovernorOrNull() as {
              isSuspended?: (child: ChildProcess) => boolean;
            } | null;
            if (governor?.isSuspended?.(child)) {
              lastActivity = Date.now();
              return;
            }
            const pid = child.pid;
            if (typeof pid !== 'number' || pid < 1) return;
            sampling = true;
            void cpuSeconds(pid)
              .catch(() => null)
              .then(cpu => {
                sampling = false;
                if (settled || terminationRequested) return;
                if (cpu === null || lastCpu === null || cpu > lastCpu) lastActivity = Date.now();
                if (cpu !== null) lastCpu = cpu;
                if (Date.now() - lastActivity >= stallMs) {
                  stalled = true;
                  terminate();
                }
              });
          }, options.stallCheckMs ?? STALL_CHECK_MS);
    watch?.unref();

    const cleanUp = () => {
      if (killTimer) clearTimeout(killTimer);
      if (watch) clearInterval(watch);
      options.signal?.removeEventListener('abort', stop);
    };

    let pending = '';
    child.stdout?.on('data', chunk => {
      lastActivity = Date.now();
      if (options.captureStdout !== false) stdout += chunk;
      if (!options.onLine) return;
      pending += chunk;
      const lines = pending.split('\n');
      // The last piece may be half a line; it waits for the rest of it.
      pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          options.onLine(line.trim());
        } catch {
          /* Progress observers cannot abandon the owned process. */
        }
      }
    });
    child.stderr?.on('data', chunk => {
      lastActivity = Date.now();
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      spawnErrorCode ??= error.code ?? 'SPAWN_FAILED';
      if (typeof child.pid !== 'number' || child.pid < 1) {
        finish({ code: null, stdout, stderr, spawnErrorCode, cancelled });
      } else {
        // A failed signal or pipe is not proof that an existing child exited.
        // Preserve the original failure and join close, including repeated errors.
        terminate();
      }
    });
    child.once('close', code => {
      finish({ code, stdout, stderr, spawnErrorCode, cancelled });
    });
    // Install ownership/exit listeners before calling any external observer.
    try {
      options.onChild?.(child);
    } catch {
      /* The returned promise still owns the actual child lifetime. */
    }
    if (!settled && options.signal) {
      if (options.signal.aborted) stop();
      else options.signal.addEventListener('abort', stop, { once: true });
    }
  });
}

export function toolSucceeded(result: ToolResult): boolean {
  return result.code === 0 && !result.spawnErrorCode && !result.cancelled;
}
