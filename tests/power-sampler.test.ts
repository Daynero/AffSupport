import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { PowerSampler } from '../apps/agent/src/power/sampler.js';
import { descendantsOf } from '../apps/agent/src/power/process-tree.js';
import { parseCpuTime } from '../apps/agent/src/platform/platform.js';

/**
 * The readout has one job it must never get wrong: report what Soty is using,
 * and say so plainly when it cannot. A fabricated 0% would read a stalled agent
 * as an idle one.
 */

function fakeChild(pid: number) {
  return { pid, kill: vi.fn(() => true), once: vi.fn() } as unknown as ChildProcess;
}

interface ProbeScript {
  cpuSeconds: number[];
  table?: { pid: number; ppid: number }[];
  supported?: boolean;
  throws?: boolean;
}

function samplerWith(script: ProbeScript, governor = new PowerGovernor({ cpuCount: 10 })) {
  let call = 0;
  const sampler = new PowerSampler({
    governor,
    cpuCount: 10,
    probes: {
      supported: () => script.supported ?? true,
      cpuSeconds: async () => {
        if (script.throws) throw new Error('probe failed');
        return new Map([[1, script.cpuSeconds[Math.min(call, script.cpuSeconds.length - 1)]]]);
      },
      processTable: async () => script.table ?? [],
      selfCpuSeconds: () => {
        call += 1;
        return 0;
      }
    }
  });
  return { sampler, governor };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('share calculation', () => {
  it('reports no figure before two readings exist', async () => {
    const { sampler, governor } = samplerWith({ cpuSeconds: [10] });
    await sampler.sample();
    // The first tick has nothing to difference against. Reporting 0% here would
    // be inventing a number.
    expect(governor.state().sample.availability).toBe('warming-up');
  });

  it('differences consecutive readings into a share of the whole machine', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    const { sampler, governor } = samplerWith({ cpuSeconds: [0, 5] });

    await sampler.sample();
    vi.setSystemTime(new Date('2026-08-20T09:00:01.000Z'));
    await sampler.sample();

    const sample = governor.state().sample;
    expect(sample.availability).toBe('ok');
    if (sample.availability === 'ok') {
      // 5 CPU-seconds over 1 wall-second on 10 cores is half the machine.
      expect(sample.systemSharePercent).toBeCloseTo(50, 1);
      expect(sample.cpuCount).toBe(10);
    }
  });

  it('never reports a negative share when a process exits mid-window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    // The tracked total drops because a child went away, not because time ran
    // backwards; an impossible figure must not reach the UI.
    const { sampler, governor } = samplerWith({ cpuSeconds: [20, 4] });

    await sampler.sample();
    vi.setSystemTime(new Date('2026-08-20T09:00:01.000Z'));
    await sampler.sample();

    const sample = governor.state().sample;
    if (sample.availability === 'ok') expect(sample.systemSharePercent).toBe(0);
  });

  it('caps the share at the whole machine', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    const { sampler, governor } = samplerWith({ cpuSeconds: [0, 999] });

    await sampler.sample();
    vi.setSystemTime(new Date('2026-08-20T09:00:01.000Z'));
    await sampler.sample();

    const sample = governor.state().sample;
    if (sample.availability === 'ok') expect(sample.systemSharePercent).toBeLessThanOrEqual(100);
  });
});

describe('when a figure cannot be produced', () => {
  it('says so on a platform that cannot measure', async () => {
    const { sampler, governor } = samplerWith({ cpuSeconds: [0], supported: false });
    await sampler.sample();
    const sample = governor.state().sample;
    expect(sample.availability).toBe('unsupported');
    expect(sample).not.toHaveProperty('systemSharePercent');
  });

  it('says so when the probe fails', async () => {
    const { sampler, governor } = samplerWith({ cpuSeconds: [0], throws: true });
    await sampler.sample();
    const sample = governor.state().sample;
    expect(sample.availability).toBe('error');
    expect(sample).not.toHaveProperty('systemSharePercent');
  });
});

describe('measuring only while watched', () => {
  it('starts on the first viewer and stops with the last', () => {
    vi.useFakeTimers();
    const { sampler } = samplerWith({ cpuSeconds: [0, 1] });

    expect(sampler.watcherCount()).toBe(0);
    const first = sampler.watch();
    const second = sampler.watch();
    expect(sampler.watcherCount()).toBe(2);

    first();
    expect(sampler.watcherCount()).toBe(1);
    second();
    // Nobody watching means no probing at all: the measurement must not be a
    // meaningful contributor to the load it reports.
    expect(sampler.watcherCount()).toBe(0);
  });

  it('ignores a teardown called twice', () => {
    vi.useFakeTimers();
    const { sampler } = samplerWith({ cpuSeconds: [0, 1] });
    const stop = sampler.watch();
    stop();
    stop();
    expect(sampler.watcherCount()).toBe(0);
  });

  it('drops its baseline when the last viewer leaves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    const { sampler, governor } = samplerWith({ cpuSeconds: [0, 5] });

    const stop = sampler.watch();
    await sampler.sample();
    stop();

    // A viewer returning minutes later must not difference against a stale
    // reading and report a nonsense average for the gap.
    sampler.watch();
    await sampler.sample();
    expect(governor.state().sample.availability).toBe('warming-up');
  });
});

describe('process trees', () => {
  it('collects every descendant of a root', () => {
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 400, ppid: 1 }
    ];
    // Chromium's renderers are grandchildren; measuring only the direct child
    // would under-report, and throttling only it would leave them at full speed.
    expect(descendantsOf(rows, [100]).sort()).toEqual([200, 300]);
  });

  it('returns nothing for a leaf', () => {
    expect(descendantsOf([{ pid: 100, ppid: 1 }], [100])).toEqual([]);
  });

  it('terminates on a table captured mid-reparenting', () => {
    // A cycle here would hang the sampler on a once-a-second timer.
    const rows = [
      { pid: 100, ppid: 200 },
      { pid: 200, ppid: 100 }
    ];
    expect(() => descendantsOf(rows, [100])).not.toThrow();
  });

  it('ignores a row that claims to be its own parent', () => {
    expect(descendantsOf([{ pid: 100, ppid: 100 }], [100])).toEqual([]);
  });

  it('feeds the tracked PID list', () => {
    const governor = new PowerGovernor({ cpuCount: 10 });
    governor.register(fakeChild(100), { toolId: 'landing-preview' });
    governor.setDescendants(100, [200, 300]);
    expect(governor.trackedPids().sort()).toEqual([100, 200, 300]);
  });
});

describe('cpu time parsing', () => {
  it.each([
    ['0:00.00', 0],
    ['0:01.50', 1.5],
    ['1:30.00', 90],
    ['1:00:00', 3600],
    ['2-01:00:00', 2 * 86_400 + 3600]
  ])('reads %s as %d seconds', (value, expected) => {
    expect(parseCpuTime(value)).toBeCloseTo(expected, 2);
  });

  it('rejects unusable input rather than guessing', () => {
    for (const value of ['', undefined, 'nope', 'a:b']) expect(parseCpuTime(value)).toBeNull();
  });
});
