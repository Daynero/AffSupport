import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { describeRequiring, requirePlatform } from './support/requires.js';

/**
 * The compressor queue used to suspend the active encode itself so prioritized
 * estimates could jump the line. Adding a duty cycler that also suspends the
 * same process created two owners of one process's stopped state — and the
 * loser's intent is discarded silently, which is the worst kind of regression.
 *
 * These tests hold the contract that replaced it: the queue asks the governor
 * for a hold, and every path that is about to terminate a child asks the
 * governor to resume it first.
 */

function fakeChild(pid = 7001) {
  const signals: string[] = [];
  const child = {
    pid,
    kill: vi.fn((signal: string) => {
      signals.push(signal);
      return true;
    }),
    once: vi.fn()
  } as unknown as ChildProcessWithoutNullStreams;
  return { child, signals };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const posixSignals = requirePlatform('darwin', 'linux');

describeRequiring(posixSignals, 'estimate prioritization under a limit', () => {
  it('keeps the encode stopped for the whole hold, whatever the cycler wants', async () => {
    vi.useFakeTimers();
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(50);

    const release = power.hold(child, 'estimate-priority');
    signals.length = 0;

    // Several full duty periods pass while the estimates run.
    vi.advanceTimersByTime(2_000);

    // If the cycler resumed here, prioritized estimates would be competing with
    // the encode again and the handoff would quietly stop working.
    expect(signals).not.toContain('SIGCONT');

    release();
    vi.advanceTimersByTime(400);
    expect(signals).toContain('SIGCONT');
  });

  it('lets the encode run again once the last hold is released', async () => {
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });

    const first = power.hold(child, 'estimate-priority');
    const second = power.hold(child, 'another-reason');
    signals.length = 0;

    first();
    // Still held by the second caller: releasing one hold must not undo another.
    expect(signals).not.toContain('SIGCONT');
    second();
    expect(signals.at(-1)).toBe('SIGCONT');
  });
});

describeRequiring(posixSignals, 'termination while suspended', () => {
  it('resumes before a graceful signal can be delivered', async () => {
    vi.useFakeTimers();
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);
    vi.advanceTimersByTime(400);

    power.resumeForTermination(child);
    // A stopped process does not run its signal handlers, so SIGTERM sent now
    // would be ignored until something resumed it — and the 2 s escalation
    // would kill FFmpeg before it could finalize its output file.
    expect(signals.at(-1)).toBe('SIGCONT');

    child.kill('SIGTERM');
    expect(signals.at(-1)).toBe('SIGTERM');
  });

  it('keeps the child resumed for the rest of its life', async () => {
    vi.useFakeTimers();
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);

    power.resumeForTermination(child);
    signals.length = 0;
    vi.advanceTimersByTime(3_000);

    // The cycler must not re-suspend a process that is on its way out, or the
    // graceful window closes again a fraction of a second later.
    expect(signals).toEqual([]);
  });

  it('clears outstanding holds so nothing keeps it stopped', () => {
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    power.hold(child, 'estimate-priority');

    power.resumeForTermination(child);
    expect(signals.at(-1)).toBe('SIGCONT');
  });
});

describeRequiring(posixSignals, 'kill escalation under a limit', () => {
  it('stretches the grace period in step with the duty cycle', async () => {
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    expect(power.scaleTimeout(2_000)).toBe(2_000);
    await power.setLimit(20);
    // A throttled process gets a fifth of the machine, so a fixed 2 s grace
    // period would shrink to 400 ms of actual runtime — exactly when the tool
    // needs longest to flush its output.
    expect(power.scaleTimeout(2_000)).toBe(10_000);
  });
});
