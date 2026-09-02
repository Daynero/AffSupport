/**
 * The one place the stitcher starts a child process.
 *
 * Every rule the constitution puts on child processes is applied here once rather than at
 * each of the dozen call sites: an argument array with no shell, a result object instead of
 * a rejection, bounded stderr, and a live reference the queue can escalate SIGTERM → SIGKILL
 * against. A tool failure is data, not an exception.
 */

import type { ChildProcess } from 'node:child_process';
import { spawnTracked } from '../power/spawn.js';

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
  /** Called with the live child so a caller can stop it. */
  onChild?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  /** Milliseconds before SIGKILL follows SIGTERM. */
  killAfterMs?: number;
}

export function runTool(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<ToolResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;

    const child = spawnTracked(command, args, { toolId: 'stitcher' });
    options.onChild?.(child);

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      cleanUp();
      resolve(result);
    };

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (settled || cancelled) return;
      cancelled = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), options.killAfterMs ?? 4_000);
      killTimer.unref();
    };

    const cleanUp = () => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', stop);
    };

    if (options.signal) {
      if (options.signal.aborted) stop();
      else options.signal.addEventListener('abort', stop, { once: true });
    }

    child.stdout?.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr?.on('data', chunk => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr,
        spawnErrorCode: error.code ?? 'SPAWN_FAILED',
        cancelled
      });
    });
    child.once('close', code => {
      finish({ code, stdout, stderr, spawnErrorCode: null, cancelled });
    });
  });
}

export function toolSucceeded(result: ToolResult): boolean {
  return result.code === 0 && !result.spawnErrorCode && !result.cancelled;
}
