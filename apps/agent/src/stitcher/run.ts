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

/** Enough stderr to diagnose a failure, never enough to grow without bound. */
const STDERR_TAIL_BYTES = 4_000;

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary could not be started at all (ENOENT and friends). */
  spawnErrorCode: string | null;
  cancelled: boolean;
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
    let spawnErrorCode: string | null = null;

    const child = spawnTracked(command, args, {
      toolId: 'stitcher',
      ...(options.cwd ? { cwd: options.cwd } : {})
    });

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      cleanUp();
      resolve(result);
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

    const cleanUp = () => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', stop);
    };

    let pending = '';
    child.stdout?.on('data', chunk => {
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
