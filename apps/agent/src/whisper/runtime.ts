import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultInferenceThreads, scaled } from '../power/spawn.js';

/**
 * What every whisper/ffmpeg child in this folder shares: the stall watchdog, the thread
 * count, and the scratch directory convention.
 *
 * They live apart from `transcriber.ts` because the language probe needs the same three
 * and nothing else — importing them from the transcriber made the probe collapse in every
 * test that replaces that module wholesale.
 */

// A whisper child that produces no output for this long is considered stuck —
// without a watchdog it would block the single shared inference queue forever.
const WHISPER_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
// FFmpeg reports its position twice a second while it decodes; a decode that
// says nothing for two minutes is reading from a volume that has gone away.
export const EXTRACT_INACTIVITY_TIMEOUT_MS = 2 * 60_000;

/**
 * Inactivity watchdog: re-armed on every stdout/stderr chunk; on expiry the
 * child gets SIGTERM, escalating to SIGKILL when it ignores that too.
 */
export function attachInactivityWatchdog(
  child: ChildProcessWithoutNullStreams,
  isPaused: () => boolean = () => false,
  /** The window, asked for on every arm so a limit changed mid-run is honoured. */
  budget: () => number = () => scaled(WHISPER_INACTIVITY_TIMEOUT_MS)
): {
  reset: () => void;
} {
  let timer: NodeJS.Timeout | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // A suspended child is silent by construction. Killing it for that would
      // turn "pause" into "lose the run after ten minutes", so the window is
      // simply started again and the deadline effectively waits for the resume.
      if (isPaused()) {
        arm();
        return;
      }
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      force.unref();
      child.once('close', () => clearTimeout(force));
      // Read on every arm, not once: whisper is a managed child, so at a
      // reduced limit it is suspended for most of every duty period and the gap
      // between two progress lines stretches with it. A fixed window would end
      // a healthy transcription for obeying the user's own setting — and the
      // job would be reported as a stalled engine, blaming the wrong thing.
    }, budget());
    timer.unref();
  };
  arm();
  child.once('close', () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  return { reset: arm };
}

/** Every run's scratch directory starts with this, so a sweep can tell them from anything else. */
export const TEMP_DIRECTORY_PREFIX = 'wishly-transcribe-';

/**
 * Removes scratch directories a previous process left behind.
 *
 * A run cleans up after itself; a run whose process was killed cannot. Each one holds the
 * decoded audio of its source — for an hour-long recording, over a hundred megabytes — and
 * nothing else would ever look at it again. Directories younger than an hour are left alone
 * in case another agent instance is still writing to them.
 */
export async function sweepAbandonedTempDirectories(
  root = os.tmpdir(),
  olderThanMs = 60 * 60_000
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_DIRECTORY_PREFIX)) continue;
    const directory = path.join(root, entry);
    try {
      const info = await stat(directory);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Somebody else's, or already gone — either way not this sweep's problem.
    }
  }
  return removed;
}

/**
 * How many threads whisper gets when no resource limit is in force.
 *
 * Two cores are left for the interface and the operating system, and the count is capped:
 * whisper.cpp's decoder stops scaling well past eight threads, and on a Windows machine
 * with sixteen logical processors the hyper-threaded half only competes with the physical
 * cores for the same cache. On Apple Silicon the GPU does the work and the count barely
 * matters either way.
 */
export function defaultWhisperThreads(cpuCount = os.cpus().length): number {
  return defaultInferenceThreads(cpuCount);
}
