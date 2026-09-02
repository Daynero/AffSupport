import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { PowerSampler } from '../apps/agent/src/power/sampler.js';
import { parseGraphicsUtilization } from '../apps/agent/src/power/graphics.js';

/**
 * The half of the machine the readout used to be blind to.
 *
 * Speech recognition runs on the graphics processor, where a transcription that had the whole
 * computer struggling reported **0.4%** — truthfully, because it was not using the processor.
 * A lever labelled "power" that reads nearly zero while the fans are at full tells its owner
 * their setting is working when it is measuring something else entirely.
 *
 * The figure is the machine's, though, not Soty's: macOS publishes no per-process graphics
 * usage without elevated privileges. So the rule tested here is both halves of the honesty —
 * say it while Soty is running something, and never claim somebody else's browser.
 */

function fakeChild(pid: number) {
  return { pid, kill: vi.fn(() => true), once: vi.fn() } as unknown as ChildProcess;
}

/**
 * A machine whose processor is doing nothing — which is what the real one looks like while
 * whisper works, because the work is all on the other side of the chip.
 */
function samplerWith(graphics: () => Promise<number | null>) {
  const governor = new PowerGovernor({ cpuCount: 10 });
  const sampler = new PowerSampler({
    governor,
    cpuCount: 10,
    probes: {
      supported: () => true,
      cpuSeconds: async () => new Map([[1, 0]]),
      selfCpuSeconds: () => 0,
      graphicsPercent: graphics
    }
  });
  return { sampler, governor };
}

/** Two ticks, because the first has nothing to difference against. */
async function settle(sampler: PowerSampler) {
  vi.setSystemTime(new Date('2026-09-02T09:00:00.000Z'));
  await sampler.sample();
  vi.setSystemTime(new Date('2026-09-02T09:00:01.000Z'));
  await sampler.sample();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reading the graphics processor', () => {
  it('finds the figure the driver publishes', () => {
    const listing =
      '"PerformanceStatistics" = {"Alloc system memory"=8092385280,"Tiler Utilization %"=78,' +
      '"Renderer Utilization %"=78,"Device Utilization %"=95,"SplitSceneCount"=0}';
    expect(parseGraphicsUtilization(listing)).toBe(95);
  });

  it('reports nothing rather than zero when the key is absent', () => {
    // A driver that publishes no such statistic and a device that is idle are different
    // claims, and only one of them is "0%".
    expect(parseGraphicsUtilization('"PerformanceStatistics" = {"recoveryCount"=0}')).toBeNull();
    expect(parseGraphicsUtilization('')).toBeNull();
  });

  it('keeps a nonsense reading inside the range a percentage can have', () => {
    expect(parseGraphicsUtilization('"Device Utilization %"=1000')).toBe(100);
  });
});

describe('what the readout is allowed to claim', () => {
  it('says the graphics figure while Soty has something running', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => 95);
    const { sampler, governor } = samplerWith(probe);
    governor.register(fakeChild(4242), { toolId: 'transcription' });

    await settle(sampler);

    const sample = governor.state().sample;
    expect(sample.availability).toBe('ok');
    if (sample.availability === 'ok') {
      // The number that explains why the machine is on its knees — beside a processor share
      // of nothing at all, which is exactly the pair the old readout showed only half of.
      expect(sample.graphicsSharePercent).toBe(95);
      expect(sample.systemSharePercent).toBe(0);
    }
  });

  it('claims nothing of the graphics while Soty is running nothing', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => 95);
    const { sampler, governor } = samplerWith(probe);

    await settle(sampler);

    const sample = governor.state().sample;
    if (sample.availability === 'ok') expect(sample.graphicsSharePercent).toBeNull();
    // Not merely unreported — not even asked. That 95% is somebody's video call, and reading
    // it once a second to throw it away is a probe nobody needed.
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports the processor share as before when the graphics cannot be read', async () => {
    vi.useFakeTimers();
    const { sampler, governor } = samplerWith(async () => null);
    governor.register(fakeChild(4243), { toolId: 'transcription' });

    await settle(sampler);

    const sample = governor.state().sample;
    expect(sample.availability).toBe('ok');
    // Every platform but macOS lands here, and it must not become an error or a zero.
    if (sample.availability === 'ok') expect(sample.graphicsSharePercent).toBeNull();
  });
});
