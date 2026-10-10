import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import {
  SleepWakeDetector,
  classifyProbeInterval,
  type WakeEvent
} from '../apps/agent/src/power/sleep-wake.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { makeJob, optimalSettings } from './helpers.js';

/**
 * The machine sleeping with work in flight (FR-009a, SC-022).
 *
 * A suspend is not something a test can ask the operating system for, so it is played back
 * the way the agent itself perceives one: the wall clock moved much further than the time
 * that was actually spent. That is the only signal there is — there is no portable
 * notification — and it is what the detector reads.
 */

function fakeChild(pid = 9001) {
  const signals: string[] = [];
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: string) => {
      signals.push(signal);
      return true;
    }),
    once: vi.fn()
  } as unknown as ChildProcessWithoutNullStreams;
  return { child, signals };
}

/** Puts the queue in the state a real encode leaves it in, without running one. */
function encodingQueue(child: ChildProcessWithoutNullStreams | null) {
  const notifications: string[] = [];
  const jobs = [makeJob('encoding-job', 'processing', { startedAt: Date.now() })];
  const queue = new JobQueue(
    { ffmpeg: true, ffprobe: true },
    event => notifications.push(event ?? 'state'),
    jobs,
    optimalSettings
  );
  const abort = new AbortController();
  (queue as unknown as { current: unknown }).current = {
    kind: 'encoding',
    jobId: 'encoding-job',
    abort,
    child
  };
  return { queue, abort, notifications };
}

/** Moves the wall clock without spending the time, which is what a suspend looks like. */
function sleepFor(milliseconds: number) {
  vi.setSystemTime(Date.now() + milliseconds);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('noticing that the machine slept', () => {
  it('tells its listener once, and only for a gap no lateness explains', () => {
    vi.useFakeTimers();
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child } = fakeChild();
    let wakes = 0;
    power.setWakeListener(() => {
      wakes += 1;
    });
    power.register(child, { toolId: 'compressor' });

    // Ordinary running. The probe ticks and finds exactly the time it slept for.
    vi.advanceTimersByTime(30_000);
    expect(wakes).toBe(0);

    sleepFor(15 * 60_000);
    vi.advanceTimersByTime(6_000);
    expect(wakes).toBe(1);

    // And it settles again rather than reporting a wake on every tick afterwards.
    vi.advanceTimersByTime(30_000);
    expect(wakes).toBe(1);
  });

  it('watches only while something is managed', () => {
    vi.useFakeTimers();
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child } = fakeChild();
    let wakes = 0;
    power.setWakeListener(() => {
      wakes += 1;
    });

    // Nothing registered: an idle agent holding a timer would be at odds with the point
    // of a governor, and there is nothing to wake up for either.
    sleepFor(15 * 60_000);
    vi.advanceTimersByTime(6_000);
    expect(wakes).toBe(0);

    power.register(child, { toolId: 'compressor' });
    power.release(child as unknown as ChildProcess);
    sleepFor(15 * 60_000);
    vi.advanceTimersByTime(6_000);
    expect(wakes).toBe(0);
  });

  it('leaves nothing stopped by the time it reports the wake', async () => {
    vi.useFakeTimers();
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child } = fakeChild();
    // Sampled inside the listener, which is the one moment the wake is over and the
    // cycler has not had a tick since — anywhere later and an ordinary off-window would
    // be indistinguishable from a child the suspend stranded.
    let stoppedAtWake: boolean | null = null;
    power.setWakeListener(() => {
      stoppedAtWake = power.isSuspended(child);
    });
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(50);

    // Into an off-window, so the child is stopped when the machine goes away. The cycler's
    // windows are wall-clock timers, and a suspend lands in the middle of one.
    vi.advanceTimersByTime(150);
    expect(power.isSuspended(child)).toBe(true);

    sleepFor(15 * 60_000);
    vi.advanceTimersByTime(6_000);

    expect(stoppedAtWake).toBe(false);
  });
});

describe('what the queue had running when the machine slept', () => {
  it('leaves an encode that survived exactly where it was', () => {
    // This process is unquestionably alive, so it stands in for an encoder the suspend
    // froze and released — which is the ordinary case, and must not be disturbed.
    const { queue } = encodingQueue(fakeChild(process.pid).child);

    expect(queue.handleWake()).toBe(false);
    expect(queue.state().jobs[0].status).toBe('processing');
    expect(queue.state().running).toBe(true);
  });

  it('presents an encoder that did not survive as interrupted', () => {
    const { queue, abort } = encodingQueue(fakeChild().child);
    // The failure this exists for: a handle that still reads as live for a process the
    // operating system no longer has. Nothing will ever settle that job on its own.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    expect(queue.handleWake()).toBe(true);
    const [job] = queue.state().jobs;
    // Interrupted, not cancelled and not failed: the user stopped nothing and nothing
    // broke. And never left saying "compressing" about a process that is gone.
    expect(job.status).toBe('interrupted');
    expect(queue.state().running).toBe(false);
    expect(abort.signal.aborted).toBe(true);
  });

  it('says nothing about work that had not reached the encoder yet', () => {
    // Image preparation runs in this process. A suspend interrupts it no more than a
    // busy moment does, so there is nothing to report.
    const { queue } = encodingQueue(null);

    expect(queue.handleWake()).toBe(false);
    expect(queue.state().jobs[0].status).toBe('processing');
  });

  it('says nothing when there was nothing running', () => {
    const queue = new JobQueue({ ffmpeg: true, ffprobe: true }, () => {}, [
      makeJob('waiting', 'ready')
    ]);

    expect(queue.handleWake()).toBe(false);
  });
});

describe('reading a suspend off the clocks', () => {
  const thresholds = { periodMs: 5_000, driftMs: 10_000, gapMs: 30_000 };

  it('reads wall time running ahead of monotonic time as a suspend, however short', () => {
    // macOS: the monotonic clock stops while the machine is away, so twenty seconds of
    // sleep is twenty seconds of drift — well under what the gap reading would notice.
    expect(classifyProbeInterval(25_000, 5_000, thresholds)).toEqual({
      sleptMs: 20_000,
      reading: 'drift'
    });
  });

  it('still catches a suspend where the monotonic clock kept counting', () => {
    // Windows may count straight through a suspend, so there is no drift to see; the probe
    // having been unable to fire for fifteen minutes is the evidence instead.
    const event = classifyProbeInterval(15 * 60_000, 15 * 60_000, thresholds);
    expect(event?.reading).toBe('gap');
    expect(event?.sleptMs).toBe(15 * 60_000 - 5_000);
  });

  it('never reads a late event loop as a suspend', () => {
    // A machine held at its limit runs late; both clocks advance through it alike.
    expect(classifyProbeInterval(5_000, 5_000, thresholds)).toBeNull();
    expect(classifyProbeInterval(20_000, 20_000, thresholds)).toBeNull();
    expect(classifyProbeInterval(14_000, 5_000, thresholds)).toBeNull();
  });

  it('ignores a wall clock set backwards', () => {
    expect(classifyProbeInterval(-3_600_000, 5_000, thresholds)).toBeNull();
  });

  it('reports once per suspend and re-bases before telling anyone', () => {
    let wall = 1_000_000;
    let monotonic = 0;
    const events: WakeEvent[] = [];
    const detector = new SleepWakeDetector({
      ...thresholds,
      clocks: { wall: () => wall, monotonic: () => monotonic },
      onWake: event => {
        events.push(event);
        // A listener that takes its time is not itself the next suspend.
        wall += 2_000;
        monotonic += 2_000;
      }
    });
    detector.start();
    expect(detector.running).toBe(true);

    wall += 5_000;
    monotonic += 5_000;
    detector.probe();
    expect(events).toHaveLength(0);

    wall += 60 * 60_000;
    monotonic += 5_000;
    detector.probe();
    expect(events).toEqual([{ sleptMs: 60 * 60_000 - 5_000, reading: 'drift' }]);

    wall += 5_000;
    monotonic += 5_000;
    detector.probe();
    expect(events).toHaveLength(1);

    detector.stop();
    expect(detector.running).toBe(false);
  });

  it("hands the governor's listener what it measured", () => {
    vi.useFakeTimers();
    let wall = 1_000_000;
    let monotonic = 0;
    const power = new PowerGovernor({
      cpuCount: 8,
      pauseSupported: true,
      wakeClocks: { wall: () => wall, monotonic: () => monotonic }
    });
    const events: WakeEvent[] = [];
    power.setWakeListener(event => events.push(event));
    power.register(fakeChild().child, { toolId: 'compressor' });

    wall += 45_000;
    monotonic += 5_000;
    vi.advanceTimersByTime(5_000);
    expect(events).toEqual([{ sleptMs: 40_000, reading: 'drift' }]);
  });

  it('keeps the change broadcast when a wake listener throws', () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let changes = 0;
    const power = new PowerGovernor({
      cpuCount: 8,
      pauseSupported: true,
      onError: (_error, message) => errors.push(message),
      onChange: () => {
        changes += 1;
      }
    });
    power.setWakeListener(() => {
      throw new Error('listener broke');
    });
    power.register(fakeChild().child, { toolId: 'compressor' });
    const before = changes;

    sleepFor(15 * 60_000);
    vi.advanceTimersByTime(6_000);
    expect(errors).toEqual(['Failed to handle a wake from sleep']);
    expect(changes).toBeGreaterThan(before);
  });
});

describe('the elapsed clock of an encode that carried on through a sleep', () => {
  function startedQueue(overrides: Record<string, unknown>) {
    const { queue } = encodingQueue(fakeChild(process.pid).child);
    // The queue's own record, not the copy `state()` hands out.
    const jobs = (queue as unknown as { jobs: Array<Record<string, unknown>> }).jobs;
    Object.assign(jobs[0], overrides);
    return { queue, job: jobs[0] };
  }

  it('books the time away like a pause, so the clock does not count the night', () => {
    const { queue, job } = startedQueue({
      startedAt: Date.now() - 9 * 3_600_000,
      pausedTotalMs: 0
    });

    expect(queue.handleWake({ sleptMs: 8 * 3_600_000 })).toBe(false);
    expect(job.status).toBe('processing');
    expect(job.pausedTotalMs).toBe(8 * 3_600_000);
  });

  it('does not count a sleep twice inside a pause the person took', () => {
    const { queue, job } = startedQueue({
      startedAt: Date.now() - 9 * 3_600_000,
      paused: true,
      pausedAt: Date.now() - 8.5 * 3_600_000,
      pausedTotalMs: 0
    });

    queue.handleWake({ sleptMs: 8 * 3_600_000 });
    expect(job.pausedTotalMs).toBe(0);
  });

  it('never books more than the job has been open for', () => {
    const { queue, job } = startedQueue({ startedAt: Date.now() - 60_000, pausedTotalMs: 10_000 });

    queue.handleWake({ sleptMs: 3_600_000 });
    expect(job.pausedTotalMs as number).toBeGreaterThanOrEqual(60_000);
    expect(job.pausedTotalMs as number).toBeLessThanOrEqual(60_000 + 50);
  });
});
