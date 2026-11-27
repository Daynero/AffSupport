import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SotyLoadMonitor,
  type SotyLoadProbes,
  type SotyTree,
  type TreeReading
} from '../apps/agent/src/power/soty-load.js';
import {
  GRAPHICS_HELPER_SCRIPT,
  WindowsLoadProbe,
  helperRequest,
  parseHelperReply
} from '../apps/agent/src/power/windows-graphics.js';
import { ProcessGraphicsShare, parseGraphicsClients } from '../apps/agent/src/power/graphics.js';
import { consumedPerProcess } from '../apps/agent/src/power/process-tree.js';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { registerPowerRoutes } from '../apps/agent/src/power/routes.js';
import { ChannelHub, type StreamSocket } from '../apps/agent/src/server/sse.js';
import {
  AGENT_TOOL_CONTRACTS,
  SOTY_LOAD_CHANNEL,
  sotyLoadFrom,
  sotyLoadSupported,
  type PowerActivity,
  type SotyLoad
} from '../packages/shared/src/types.js';

/**
 * The header's power button shows how hard SOTY is working the computer — its own processes
 * and their graphics work — not the machine's load. A browser or a game is not Soty, and a
 * button that lit up for them while the panel said "Soty is idle — 0%" told two stories.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the shared reading', () => {
  it('shows the larger of the two figures and says which', () => {
    const gpu = sotyLoadFrom({
      cpuPercent: 12.4,
      gpuPercent: 63,
      activity: 'active',
      sampledAt: 't'
    });
    expect(gpu).toMatchObject({ percent: 63, cpuPercent: 12, gpuPercent: 63, source: 'gpu' });
    const cpu = sotyLoadFrom({
      cpuPercent: 47,
      gpuPercent: 12,
      activity: 'active',
      sampledAt: 't'
    });
    expect(cpu).toMatchObject({ percent: 47, source: 'cpu', activity: 'active' });
  });

  it('is the processor alone where graphics cannot be attributed to a process', () => {
    expect(
      sotyLoadFrom({ cpuPercent: 30, gpuPercent: null, activity: 'idle', sampledAt: 't' })
    ).toMatchObject({ percent: 30, gpuPercent: null, source: 'cpu', activity: 'idle' });
  });

  it('keeps every figure a whole percent inside 0–100', () => {
    expect(
      sotyLoadFrom({ cpuPercent: 140, gpuPercent: -3, activity: 'active', sampledAt: 't' })
    ).toMatchObject({ percent: 100, cpuPercent: 100, gpuPercent: 0 });
    expect(
      sotyLoadFrom({ cpuPercent: Number.NaN, gpuPercent: null, activity: 'idle', sampledAt: 't' })
    ).toMatchObject({ percent: 0 });
  });

  it('is not claimed by an agent that published the whole machine on this channel', () => {
    expect(AGENT_TOOL_CONTRACTS.machineLoad).toBe(2);
    expect(sotyLoadSupported({ ...AGENT_TOOL_CONTRACTS })).toBe(true);
    // 1.7.2: the same channel, the whole computer's figure.
    expect(sotyLoadSupported({ ...AGENT_TOOL_CONTRACTS, machineLoad: 1 })).toBe(false);
    expect(sotyLoadSupported({ power: 1 })).toBe(false);
    expect(sotyLoadSupported(null)).toBe(false);
  });

  it('keeps the channel name the released interface subscribes to', () => {
    expect(SOTY_LOAD_CHANNEL).toBe('machine-load');
  });
});

describe('differencing per process', () => {
  it('counts only processes present in both readings', () => {
    const before = new Map([
      [10, 5],
      [20, 1]
    ]);
    const after = new Map([
      [10, 6.5],
      // Discovered late, carrying its whole lifetime: not one tick's work.
      [30, 900]
    ]);
    expect(consumedPerProcess(before, after)).toBe(1.5);
  });

  it('never counts a recycled PID as negative consumption', () => {
    expect(consumedPerProcess(new Map([[10, 50]]), new Map([[10, 2]]))).toBe(0);
  });
});

/* ── macOS: per-client GPU time from the Apple-silicon driver ─────────────── */

function client(pid: number, name: string, times: number[] | null): string {
  const usage =
    times === null
      ? ''
      : `      "AppUsage" = (${times
          .map(time => `{"API"="Metal","lastSubmittedTime"=1,"accumulatedGPUTime"=${time}}`)
          .join(',')})\n`;
  return (
    `+-o AGXDeviceUserClient  <class AGXDeviceUserClient, id 0x1, !registered, !matched, active, busy 0, retain 5>\n` +
    `    {\n${usage}      "IOUserClientCreator" = "pid ${pid}, ${name}"\n    }\n\n`
  );
}

describe('macOS graphics clients', () => {
  it('sums every client a process opened, and every queue of each', () => {
    const listing =
      client(422, 'WindowServer', [16_764_869_210_500, 261_665_291]) +
      client(9001, 'whisper-cli', [2_000_000_000]) +
      client(9001, 'whisper-cli', [500_000_000, 0]) +
      client(423, 'runningboardd', []);
    const byPid = parseGraphicsClients(listing);
    expect(byPid?.get(9001)).toBe(2_500_000_000);
    expect(byPid?.get(422)).toBe(16_765_130_875_791);
    expect(byPid?.get(423)).toBe(0);
  });

  it('has no figure where the driver keeps none (an Intel Mac)', () => {
    expect(parseGraphicsClients('')).toBeNull();
    expect(parseGraphicsClients(client(5, 'x', null))).toBeNull();
  });

  it("is Soty's share of the graphics processor, not the machine's", async () => {
    let now = 0;
    const listings = [
      client(422, 'WindowServer', [10e9]) + client(9001, 'whisper-cli', [1e9]),
      // Two seconds later: the browser used 1.8 s of GPU time, whisper 1.2 s.
      client(422, 'WindowServer', [11.8e9]) + client(9001, 'whisper-cli', [2.2e9])
    ];
    const share = new ProcessGraphicsShare({
      listing: async () => listings.shift() ?? null,
      now: () => now
    });
    expect(await share.percent([9001])).toBeNull();
    now = 2_000;
    expect(await share.percent([9001])).toBeCloseTo(60, 5);
  });

  it('does not average over a gap nobody watched', async () => {
    let now = 0;
    const share = new ProcessGraphicsShare({
      listing: async () => client(7, 'ffmpeg', [now * 1e6]),
      now: () => now
    });
    await share.percent([7]);
    now = 60_000;
    expect(await share.percent([7])).toBeNull();
    now = 61_000;
    expect(await share.percent([7])).toBeCloseTo(100, 5);
  });

  it('stops asking a machine that has shown three times it has no per-client figures', async () => {
    const listing = vi.fn(async () => '');
    const share = new ProcessGraphicsShare({ listing });
    for (let read = 0; read < 5; read += 1) await share.percent([1]);
    expect(listing).toHaveBeenCalledTimes(3);
    expect(share.disabled()).toBe(true);
  });

  it('does not give up on a probe that merely failed to run', async () => {
    const share = new ProcessGraphicsShare({ listing: async () => null });
    for (let read = 0; read < 5; read += 1) await share.percent([1]);
    expect(share.disabled()).toBe(false);
  });
});

/* ── The monitor ─────────────────────────────────────────────────────────── */

interface FakeTree extends SotyTree {
  pids: number[];
  state: PowerActivity;
  refreshes: number[];
}

function fakeTree(pids: number[] = [], state: PowerActivity = 'idle'): FakeTree {
  const tree: FakeTree = {
    pids,
    state,
    refreshes: [],
    trackedPids: () => tree.pids,
    activity: () => tree.state,
    refreshTreeIfOlderThan: maxAgeMs => {
      tree.refreshes.push(maxAgeMs);
    }
  };
  return tree;
}

/**
 * Scripted probes. `self` and each PID's processor seconds advance by the given amount per
 * reading; `graphics` is what each graphics read answers.
 */
function scriptedProbes(input: {
  selfPerRead?: number;
  cpuPerRead?: Record<number, number>;
  graphics?: (number | null)[];
  attributable?: boolean;
  supported?: boolean;
}) {
  let self = 0;
  const totals = new Map<number, number>();
  const graphics = [...(input.graphics ?? [])];
  const read = vi.fn(async (pids: readonly number[], withGraphics: boolean) => {
    for (const pid of pids) {
      totals.set(pid, (totals.get(pid) ?? 0) + (input.cpuPerRead?.[pid] ?? 0));
    }
    const reading: TreeReading = {
      cpuSeconds: new Map(pids.map(pid => [pid, totals.get(pid) as number]))
    };
    if (withGraphics) reading.graphicsPercent = graphics.length ? (graphics.shift() ?? null) : null;
    return reading;
  });
  const probes: SotyLoadProbes = {
    supported: () => input.supported ?? true,
    selfCpuSeconds: () => {
      self += input.selfPerRead ?? 0;
      return self;
    },
    graphicsAttributable: () => input.attributable ?? true,
    read,
    reset: vi.fn(),
    stop: vi.fn()
  };
  return { probes, read };
}

function monitorWith(tree: SotyTree, probes: SotyLoadProbes, clock: { now: number }) {
  return new SotyLoadMonitor({
    tree,
    probes,
    cpuCount: 10,
    intervalMs: 60_000,
    graphicsIntervalMs: 2_000,
    now: () => clock.now
  });
}

/** Starts watching; the first reading (the baseline) is taken at once, at the current time. */
async function begin(monitor: SotyLoadMonitor): Promise<() => void> {
  const stop = monitor.watch();
  await new Promise(resolve => setImmediate(resolve));
  return stop;
}

async function tick(monitor: SotyLoadMonitor, clock: { now: number }, ms = 1_000) {
  clock.now += ms;
  await monitor.sample();
}

describe("Soty's load monitor", () => {
  it('asks the OS about nothing while Soty has no process running', async () => {
    const clock = { now: 0 };
    const tree = fakeTree();
    // The agent answering the page: 0.1 s of CPU a second on a ten-core machine.
    const { probes, read } = scriptedProbes({ selfPerRead: 0.1 });
    const monitor = monitorWith(tree, probes, clock);
    const stop = await begin(monitor);
    await tick(monitor, clock);
    expect(read).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toMatchObject({
      availability: 'ok',
      percent: 1,
      cpuPercent: 1,
      // Nothing of Soty's could be drawing: a measured zero, not an unknown.
      gpuPercent: 0,
      activity: 'idle'
    });
    stop();
  });

  it("ignores the rest of the machine entirely: only Soty's processes are read", async () => {
    const clock = { now: 0 };
    const tree = fakeTree([4100, 4101], 'active');
    const { probes, read } = scriptedProbes({ cpuPerRead: { 4100: 4, 4101: 1 } });
    const monitor = monitorWith(tree, probes, clock);
    const stop = await begin(monitor);
    await tick(monitor, clock);
    expect(read.mock.calls.every(([pids]) => pids.join() === '4100,4101')).toBe(true);
    // 5 CPU-seconds in a second, over ten cores.
    expect(monitor.snapshot()).toMatchObject({ percent: 50, cpuPercent: 50, activity: 'active' });
    stop();
  });

  it('shows the graphics when they are the busier of the two, read every other second', async () => {
    const clock = { now: 0 };
    const tree = fakeTree([900], 'active');
    // whisper on the GPU: next to nothing on the processor.
    const { probes, read } = scriptedProbes({
      cpuPerRead: { 900: 0.1 },
      graphics: [null, 72, 70]
    });
    const monitor = monitorWith(tree, probes, clock);
    const stop = await begin(monitor);
    await tick(monitor, clock);
    // Still the first graphics read's baseline: the processor alone, not an invented zero.
    expect(monitor.snapshot()).toMatchObject({ percent: 1, gpuPercent: null });
    await tick(monitor, clock);
    expect(monitor.snapshot()).toMatchObject({ percent: 72, gpuPercent: 72, source: 'gpu' });
    expect(read.mock.calls.map(([, withGraphics]) => withGraphics)).toEqual([true, false, true]);
    stop();
  });

  it('leaves the graphics out where no process can be credited with them', async () => {
    const clock = { now: 0 };
    const { probes, read } = scriptedProbes({ cpuPerRead: { 7: 2 }, attributable: false });
    const monitor = monitorWith(fakeTree([7], 'active'), probes, clock);
    const stop = await begin(monitor);
    await tick(monitor, clock);
    expect(read.mock.calls.every(([, withGraphics]) => withGraphics === false)).toBe(true);
    expect(monitor.snapshot()).toMatchObject({ percent: 20, gpuPercent: null, source: 'cpu' });
    stop();
  });

  it('keeps the descendant list fresh at a slow, bounded rate', async () => {
    const clock = { now: 0 };
    const tree = fakeTree([7], 'active');
    const { probes } = scriptedProbes({});
    const monitor = monitorWith(tree, probes, clock);
    const stop = await begin(monitor);
    expect(tree.refreshes.every(maxAge => maxAge === 10_000)).toBe(true);
    stop();
  });

  it('warms up rather than inventing a zero, and never reports one for an unsupported host', async () => {
    const clock = { now: 0 };
    const { probes } = scriptedProbes({ supported: false });
    const monitor = monitorWith(fakeTree(), probes, clock);
    expect(monitor.snapshot().availability).toBe('warming-up');
    const stop = await begin(monitor);
    expect(monitor.snapshot().availability).toBe('unsupported');
    stop();
  });

  it('rides out a slow reading or two, then says it has none', async () => {
    const clock = { now: 0 };
    const { probes, read } = scriptedProbes({ cpuPerRead: { 7: 3 } });
    const monitor = monitorWith(fakeTree([7], 'active'), probes, clock);
    const stop = await begin(monitor);
    await tick(monitor, clock);
    expect(monitor.snapshot()).toMatchObject({ availability: 'ok', percent: 30 });
    read.mockResolvedValue(null as unknown as TreeReading);
    await tick(monitor, clock);
    await tick(monitor, clock);
    expect(monitor.snapshot()).toMatchObject({ availability: 'ok', percent: 30 });
    await tick(monitor, clock);
    expect(monitor.snapshot().availability).toBe('error');
    stop();
  });

  it('tells listeners only when something a viewer sees changes', async () => {
    const clock = { now: 0 };
    const tree = fakeTree([7], 'active');
    const { probes } = scriptedProbes({ cpuPerRead: { 7: 3 }, attributable: false });
    const monitor = monitorWith(tree, probes, clock);
    const heard: SotyLoad[] = [];
    monitor.onChange(load => heard.push(load));
    const stop = await begin(monitor);
    await tick(monitor, clock);
    await tick(monitor, clock);
    tree.state = 'idle';
    await tick(monitor, clock);
    stop();
    expect(
      heard.map(load => (load.availability === 'ok' ? `${load.percent}/${load.activity}` : ''))
    ).toEqual(['30/active', '30/idle']);
  });

  it('keeps the resident helper a while after the last viewer, then ends it', () => {
    vi.useFakeTimers();
    const { probes } = scriptedProbes({});
    const monitor = new SotyLoadMonitor({ tree: fakeTree(), probes, lingerMs: 30_000 });
    const first = monitor.watch();
    first();
    vi.advanceTimersByTime(10_000);
    // Back within the grace: the helper is kept.
    const second = monitor.watch();
    vi.advanceTimersByTime(60_000);
    expect(probes.stop).not.toHaveBeenCalled();
    second();
    vi.advanceTimersByTime(30_000);
    expect(probes.stop).toHaveBeenCalledTimes(1);
  });
});

describe('the governor as the tree', () => {
  function fakeChild(pid: number) {
    return { pid, kill: vi.fn(() => true), once: vi.fn() } as unknown as ChildProcess;
  }

  it('walks the process table at most once per requested age, and never with nothing to walk', async () => {
    let now = 0;
    const walks = vi.fn(async () => [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 }
    ]);
    const governor = new PowerGovernor({
      cpuCount: 4,
      pauseSupported: true,
      now: () => now,
      probeProcessTable: walks,
      descendantSignals: { pause: () => true, resume: () => true, setPriority: () => {} }
    });
    governor.refreshTreeIfOlderThan(10_000);
    expect(walks).not.toHaveBeenCalled();
    expect(governor.activity()).toBe('idle');

    governor.register(fakeChild(100), { toolId: 'landing-preview' });
    expect(governor.activity()).toBe('active');
    governor.refreshTreeIfOlderThan(10_000);
    await vi.waitFor(() => expect(governor.trackedPids()).toEqual([100, 200]));
    now = 9_000;
    governor.refreshTreeIfOlderThan(10_000);
    expect(walks).toHaveBeenCalledTimes(1);
    now = 10_000;
    governor.refreshTreeIfOlderThan(10_000);
    expect(walks).toHaveBeenCalledTimes(2);
    await governor.shutdown();
  });
});

function recorder(): StreamSocket & { frames: string[] } {
  const frames: string[] = [];
  return { frames, write: (chunk: string) => frames.push(chunk) };
}

describe('the Soty-load channel', () => {
  it('measures only while somebody subscribes to it', async () => {
    const app = Fastify({ logger: false });
    const hub = new ChannelHub();
    let watchers = 0;
    let listener: ((load: SotyLoad) => void) | null = null;
    const reading = sotyLoadFrom({
      cpuPercent: 47,
      gpuPercent: 12,
      activity: 'active',
      sampledAt: 't'
    });
    registerPowerRoutes(app, {
      governor: new PowerGovernor({ cpuCount: 4, pauseSupported: true }),
      allowedOrigins: new Set(),
      channelHub: hub,
      sotyLoad: {
        watch: () => {
          watchers += 1;
          return () => {
            watchers -= 1;
          };
        },
        snapshot: () => reading,
        onChange: next => {
          listener = next;
          return () => {};
        }
      }
    });

    expect(hub.channels()).toContain(SOTY_LOAD_CHANNEL);
    const power = recorder();
    const detachPower = hub.subscribe(power, ['power']);
    expect(watchers).toBe(0);

    const socket = recorder();
    const detach = hub.subscribe(socket, [SOTY_LOAD_CHANNEL]);
    expect(watchers).toBe(1);
    expect(socket.frames.at(-1)).toContain('"channel":"machine-load"');
    expect(socket.frames.at(-1)).toContain('"percent":47');

    (listener as unknown as (load: SotyLoad) => void)(
      sotyLoadFrom({ cpuPercent: 80, gpuPercent: null, activity: 'active', sampledAt: 'u' })
    );
    expect(socket.frames.at(-1)).toContain('"percent":80');
    expect(power.frames.join('')).not.toContain('machine-load');

    detach();
    expect(watchers).toBe(0);
    detachPower();
    hub.closeAll();
    await app.close();
  });
});

/* ── Windows: one resident helper for both figures ────────────────────────── */

/** A stand-in PowerShell that answers each request with the next scripted line. */
function fakeHelper(replies: (string | undefined)[]) {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stdout.setEncoding = () => {};
  const written: string[] = [];
  const child = Object.assign(emitter, {
    stdout,
    stdin: {
      writable: true,
      write: vi.fn((chunk: string) => {
        written.push(chunk);
        const reply = replies.shift();
        if (reply !== undefined) queueMicrotask(() => stdout.emit('data', `${reply}\r\n`));
        return true;
      }),
      end: vi.fn(() => queueMicrotask(() => emitter.emit('close', 0)))
    },
    kill: vi.fn(() => true)
  }) as unknown as ChildProcess;
  return { child, written };
}

describe('Windows load helper', () => {
  it('sends only positive integers, as one fixed-shape line', () => {
    expect(helperRequest([12, 34], true)).toBe('g 12,34\n');
    expect(helperRequest([12, -1, 1.5, Number.NaN, 0], false)).toBe('c 12\n');
  });

  it('reads the graphics figure and each process time, in the invariant culture', () => {
    expect(parseHelperReply('31 4100:12.5 4101:0.03125 4102:1E-05')).toEqual({
      graphicsPercent: 31,
      cpuSeconds: new Map([
        [4100, 12.5],
        [4101, 0.03125],
        [4102, 0.00001]
      ])
    });
    expect(parseHelperReply('- 4100:3')).toEqual({
      graphicsPercent: null,
      cpuSeconds: new Map([[4100, 3]])
    });
    // A Ukrainian decimal comma is a malformed pair, not a misread number.
    expect(parseHelperReply('- 4100:12,5')?.cpuSeconds.size).toBe(0);
  });

  it('refuses a line that is not a reading', () => {
    expect(parseHelperReply(null)).toBeNull();
    expect(parseHelperReply('101 4100:1')).toBeNull();
    expect(parseHelperReply('4.5')).toBeNull();
    expect(parseHelperReply('error')).toBeNull();
  });

  it('keeps one helper for every reading, and asks for graphics only when told to', async () => {
    const { child, written } = fakeHelper(['- 7:1.5', '44 7:2']);
    const spawnHelper = vi.fn(() => child);
    const probe = new WindowsLoadProbe({ spawnHelper });
    expect(await probe.read([7], false)).toEqual({ cpuSeconds: new Map([[7, 1.5]]) });
    expect(await probe.read([7], true)).toEqual({
      cpuSeconds: new Map([[7, 2]]),
      graphicsPercent: 44
    });
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(written).toEqual(['c 7\n', 'g 7\n']);
    probe.stop();
    expect(probe.running()).toBe(false);
  });

  it('ends a helper that stopped answering, so a late reply cannot answer the next request', async () => {
    vi.useFakeTimers();
    const first = fakeHelper([undefined]);
    const second = fakeHelper(['- 7:3']);
    const spawnHelper = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
    const probe = new WindowsLoadProbe({ spawnHelper });
    const pending = probe.read([7], false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBeNull();
    expect(probe.running()).toBe(false);
    vi.useRealTimers();
    expect(await probe.read([7], false)).toEqual({ cpuSeconds: new Map([[7, 3]]) });
    expect(spawnHelper).toHaveBeenCalledTimes(2);
  });

  it('gives up after a helper that dies on start, rather than spawning forever', async () => {
    let now = 0;
    const spawnHelper = vi.fn(() => {
      const { child } = fakeHelper([]);
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    const probe = new WindowsLoadProbe({ spawnHelper, now: () => now });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await probe.read([7], false);
      now += 10;
    }
    expect(spawnHelper).toHaveBeenCalledTimes(3);
    expect(probe.disabled()).toBe(true);
  });

  it("reads Soty's own counters by their English names, from a constant script", () => {
    expect(GRAPHICS_HELPER_SCRIPT).toContain('PerformanceCounterCategory("GPU Engine")');
    expect(GRAPHICS_HELPER_SCRIPT).toContain('["utilization percentage"]');
    // Only the listed processes' engine instances count towards the figure.
    expect(GRAPHICS_HELPER_SCRIPT).toContain("'^pid_([0-9]+)_'");
    expect(GRAPHICS_HELPER_SCRIPT).toContain('$wanted.ContainsKey($Matches[1])');
    expect(GRAPHICS_HELPER_SCRIPT).toContain(
      'TotalProcessorTime.TotalSeconds.ToString("R", $invariant)'
    );
    // PowerShell's own PID is an automatic variable; reusing the name would read the wrong one.
    expect(GRAPHICS_HELPER_SCRIPT.toLowerCase()).not.toContain('$pid');
  });
});
