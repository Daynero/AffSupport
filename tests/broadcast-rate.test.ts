import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob } from './helpers.js';
import type { CompressionJob } from '@video-compressor/shared';

/**
 * FFmpeg reports progress several times a second, and each report used to be a
 * full state broadcast: the whole queue serialised, pushed over the event
 * stream, parsed by every open tab and reconciled against what it already had —
 * to move one number the interface renders as a whole percent anyway.
 *
 * Two properties matter and they pull against each other. Fewer broadcasts, and
 * the last one still arrives: a bar that stops at 97% because the final tick
 * was inside a quiet window is worse than a bar that updates too often.
 */

afterEach(() => {
  vi.useRealTimers();
});

/** Drives the private progress path the encoder callback uses. */
function reportProgress(queue: JobQueue, times: number) {
  const notifyProgress = (queue as unknown as { notifyProgress(): void }).notifyProgress.bind(
    queue
  );
  for (let index = 0; index < times; index += 1) notifyProgress();
}

function queueWithJob(): { queue: JobQueue; broadcasts: () => number; job: CompressionJob } {
  let count = 0;
  const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {
    count += 1;
  });
  const job = makeJob('job', 'processing');
  (queue as unknown as { jobs: CompressionJob[] }).jobs = [job];
  return { queue, broadcasts: () => count, job };
}

describe('progress broadcasts', () => {
  it('coalesces a burst into far fewer sends', () => {
    vi.useFakeTimers();
    const { queue, broadcasts } = queueWithJob();

    // Twenty reports inside one window, which is roughly what an encode
    // produces in a second.
    reportProgress(queue, 20);
    expect(broadcasts()).toBeLessThanOrEqual(2);
  });

  it('still delivers the last value of a burst', () => {
    vi.useFakeTimers();
    const { queue, broadcasts } = queueWithJob();

    reportProgress(queue, 20);
    const duringBurst = broadcasts();
    // The trailing send: without it a bar sticks wherever the last suppressed
    // tick left it until something unrelated happens.
    vi.advanceTimersByTime(500);
    expect(broadcasts()).toBeGreaterThan(duringBurst);
  });

  it('sends promptly again once the burst is over', () => {
    vi.useFakeTimers();
    const { queue, broadcasts } = queueWithJob();

    reportProgress(queue, 1);
    const first = broadcasts();
    vi.advanceTimersByTime(500);
    reportProgress(queue, 1);
    // Rate limiting must not turn into latency for an idle queue that starts
    // moving again.
    expect(broadcasts()).toBeGreaterThan(first);
  });

  it('does not rate-limit a state change', () => {
    vi.useFakeTimers();
    const { queue, broadcasts } = queueWithJob();

    reportProgress(queue, 5);
    const afterProgress = broadcasts();
    // "This job just failed" arriving a quarter-second late is a different kind
    // of wrong from a progress bar updating four times a second instead of
    // twenty, so status changes keep the immediate path.
    (queue as unknown as { notify(): void }).notify();
    expect(broadcasts()).toBe(afterProgress + 1);
  });
});
