import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { descendantsByRoot, descendantsOf } from '../apps/agent/src/power/process-tree.js';
import type { ProcessTableRow } from '../apps/agent/src/platform/platform.js';
import { describeRequiring, requirePlatform } from './support/requires.js';

/**
 * The descendant half of the throttle.
 *
 * Stopping a managed child is not enough on its own: Playwright's Chromium is a
 * broker that does almost no work itself, so suspending only the root would
 * leave every renderer running at full speed — the limit honoured on paper
 * while the machine stayed pinned, and the readout (which does count
 * descendants) saying so.
 *
 * Walking the tree is also the single most expensive thing the power feature
 * does: it shells out to the process table, and on Windows that is a full WMI
 * enumeration. How often it happens is behaviour, not an implementation detail.
 */

function fakeChild(pid: number) {
  return {
    pid,
    kill: vi.fn(() => true),
    once: vi.fn()
  } as unknown as ChildProcess;
}

interface Signals {
  paused: number[];
  resumed: number[];
  prioritized: number[];
}

function governorWithTree(rows: ProcessTableRow[]) {
  const signals: Signals = { paused: [], resumed: [], prioritized: [] };
  const table = { rows, walks: 0 };
  const power = new PowerGovernor({
    cpuCount: 10,
    pauseSupported: true,
    probeProcessTable: async () => {
      table.walks += 1;
      return table.rows;
    },
    descendantSignals: {
      pause: pid => {
        signals.paused.push(pid);
        return true;
      },
      resume: pid => {
        signals.resumed.push(pid);
        return true;
      },
      setPriority: pid => {
        signals.prioritized.push(pid);
      }
    }
  });
  return { power, signals, table };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('process tree walk', () => {
  const rows: ProcessTableRow[] = [
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 200 },
    { pid: 400, ppid: 1 },
    { pid: 500, ppid: 400 }
  ];

  it('answers per root from one index of the table', () => {
    const byRoot = descendantsByRoot(rows, [100, 400]);
    expect(byRoot.get(100)?.sort()).toEqual([200, 300]);
    expect(byRoot.get(400)).toEqual([500]);
  });

  it('agrees with the single-root walk', () => {
    for (const root of [100, 400]) {
      expect(descendantsByRoot(rows, [root]).get(root)?.sort()).toEqual(
        descendantsOf(rows, [root]).sort()
      );
    }
  });

  it('survives a table captured mid-reparenting', () => {
    const cyclic: ProcessTableRow[] = [
      { pid: 10, ppid: 20 },
      { pid: 20, ppid: 10 }
    ];
    expect(() => descendantsByRoot(cyclic, [10])).not.toThrow();
  });
});

describe('descendant control', () => {
  it('stops the renderers, not just the browser process', async () => {
    vi.useFakeTimers();
    const { power, signals } = governorWithTree([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 100 }
    ]);
    power.register(fakeChild(100), { toolId: 'landing-preview' });
    await power.setLimit(50);
    await power.refreshTree();

    await vi.advanceTimersByTimeAsync(1_000);
    // Chromium's broker process does almost no work itself: throttling it alone
    // would hold the limit on paper while the machine stayed pinned.
    expect(signals.paused).toContain(200);
    expect(signals.paused).toContain(300);
  });

  it('adopts a descendant that appears while the root is already stopped', async () => {
    const { power, signals } = governorWithTree([{ pid: 100, ppid: 1 }]);
    power.register(fakeChild(100), { toolId: 'landing-preview' });
    await power.setLimit(20);
    power.hold(fakeChild(100), 'test');

    // A tool that forks during an off-window would otherwise run unthrottled
    // until the root's next full suspend.
    power.setDescendants(100, [777]);
    expect(signals.paused).toContain(777);
  });

  it('resumes a descendant it stopped even after that PID left the tree', async () => {
    const { power, signals } = governorWithTree([{ pid: 100, ppid: 1 }]);
    const child = fakeChild(100);
    power.register(child, { toolId: 'landing-preview' });
    await power.setLimit(20);
    power.hold(child, 'test');
    power.setDescendants(100, [777]);
    expect(signals.paused).toContain(777);

    // Reparented away, so no longer listed — but still stopped, and this
    // governor is the only thing that knows it.
    power.setDescendants(100, []);
    power.resumeForTermination(child);
    expect(signals.resumed).toContain(777);
  });

  it('forgets the priority marker for a PID that has left the tree', async () => {
    const { power, signals } = governorWithTree([{ pid: 100, ppid: 1 }]);
    power.register(fakeChild(100), { toolId: 'landing-preview' });
    await power.setLimit(50);

    power.setDescendants(100, [777]);
    power.setDescendants(100, []);
    power.setDescendants(100, [777]);
    // Re-prioritised because it is a new arrival as far as we can tell. The
    // point of the test is the other direction: the marker set must not keep
    // every PID a long-lived Chromium ever spawned.
    expect(signals.prioritized.filter(pid => pid === 777)).toHaveLength(2);
  });
});

describeRequiring(requirePlatform('darwin', 'linux'), 'walk frequency', () => {
  it('does not walk the table at all when nothing needs it', async () => {
    const { power, table } = governorWithTree([{ pid: 100, ppid: 1 }]);
    power.register(fakeChild(100), { toolId: 'compressor' });
    // Unrestricted and unwatched: nothing is being suspended and nobody is
    // reading a figure, so the measurement must cost exactly nothing.
    expect(table.walks).toBe(0);
  });

  it('survives a burst of short-lived tools without a walk per spawn', async () => {
    vi.useFakeTimers();
    const { power, table } = governorWithTree([{ pid: 100, ppid: 1 }]);
    await power.setLimit(50);

    // The estimator fires sub-second ffprobe calls back to back. Tearing the
    // tracker down between them and rebuilding it on the next one used to walk
    // the process table once per spawn — on Windows, a WMI enumeration each.
    for (let index = 0; index < 10; index += 1) {
      const child = fakeChild(1_000 + index);
      power.register(child, { toolId: 'estimate-probe' });
      power.release(child);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(table.walks).toBeLessThanOrEqual(2);
  });

  it('retires the tracker once nothing needs it any more', async () => {
    vi.useFakeTimers();
    const { power, table } = governorWithTree([{ pid: 100, ppid: 1 }]);
    const child = fakeChild(100);
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(50);
    await vi.advanceTimersByTimeAsync(0);
    power.release(child);

    const walksWhenIdle = table.walks;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(table.walks).toBe(walksWhenIdle);
    await power.shutdown();
  });
});
