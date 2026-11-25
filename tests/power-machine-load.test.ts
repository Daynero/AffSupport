import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type os from 'node:os';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MachineLoadMonitor,
  cpuPercentBetween,
  totalCpuTimes,
  type CpuTimes
} from '../apps/agent/src/power/machine-load.js';
import {
  GRAPHICS_HELPER_SCRIPT,
  WindowsGraphicsProbe,
  parseGraphicsReply
} from '../apps/agent/src/power/windows-graphics.js';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { registerPowerRoutes } from '../apps/agent/src/power/routes.js';
import { ChannelHub, type StreamSocket } from '../apps/agent/src/server/sse.js';
import {
  AGENT_TOOL_CONTRACTS,
  MACHINE_LOAD_CHANNEL,
  machineLoadFrom,
  machineLoadSupported,
  type MachineLoad
} from '../packages/shared/src/types.js';

/**
 * The header's load meter reads the whole computer — every core and the graphics device —
 * and the agent publishes it on its own stream channel, measured only while a page watches.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function core(busy: number, idle: number): os.CpuInfo {
  return { model: 'test', speed: 1, times: { user: busy, nice: 0, sys: 0, irq: 0, idle } };
}

describe('processor share', () => {
  it('adds every core together', () => {
    expect(totalCpuTimes([core(10, 90), core(30, 70)])).toEqual({ busy: 40, total: 200 });
  });

  it('is the busy share of the time that passed, not of all time', () => {
    const before: CpuTimes = { busy: 1_000, total: 10_000 };
    const after: CpuTimes = { busy: 1_470, total: 11_000 };
    expect(cpuPercentBetween(before, after)).toBe(47);
  });

  it('has no figure when no time passed', () => {
    const same: CpuTimes = { busy: 5, total: 10 };
    expect(cpuPercentBetween(same, same)).toBeNull();
  });

  it('never goes below zero or above a hundred', () => {
    expect(cpuPercentBetween({ busy: 50, total: 100 }, { busy: 40, total: 200 })).toBe(0);
    expect(cpuPercentBetween({ busy: 0, total: 100 }, { busy: 500, total: 200 })).toBe(100);
  });
});

describe('the shared reading', () => {
  it('shows the larger of the two figures and says which', () => {
    const gpu = machineLoadFrom({ cpuPercent: 12.4, gpuPercent: 63, sampledAt: 't' });
    expect(gpu).toMatchObject({ percent: 63, cpuPercent: 12, gpuPercent: 63, source: 'gpu' });
    const cpu = machineLoadFrom({ cpuPercent: 47, gpuPercent: 12, sampledAt: 't' });
    expect(cpu).toMatchObject({ percent: 47, source: 'cpu' });
  });

  it('is the processor alone where the graphics cannot be read', () => {
    expect(machineLoadFrom({ cpuPercent: 30, gpuPercent: null, sampledAt: 't' })).toMatchObject({
      percent: 30,
      gpuPercent: null,
      source: 'cpu'
    });
  });

  it('is a capability an older agent does not have', () => {
    expect(machineLoadSupported({ ...AGENT_TOOL_CONTRACTS })).toBe(true);
    expect(machineLoadSupported({ power: 1 })).toBe(false);
    expect(machineLoadSupported(null)).toBe(false);
  });
});

/** Processor times that advance by `busy` of every 100 units per read. */
function scriptedCpu(shares: number[]) {
  let busy = 0;
  let total = 0;
  let index = 0;
  return () => {
    const share = shares[Math.min(index, shares.length - 1)];
    index += 1;
    busy += share;
    total += 100;
    return { busy, total };
  };
}

describe('machine load monitor', () => {
  it('warms up, then reports, and costs nothing until someone watches', () => {
    const cpuTimes = vi.fn(scriptedCpu([0, 40, 40]));
    const monitor = new MachineLoadMonitor({ probes: { cpuTimes }, intervalMs: 60_000 });
    expect(cpuTimes).not.toHaveBeenCalled();
    expect(monitor.snapshot().availability).toBe('warming-up');

    const stop = monitor.watch();
    expect(monitor.snapshot().availability).toBe('warming-up');
    monitor.sample();
    expect(monitor.snapshot()).toMatchObject({ availability: 'ok', percent: 40, source: 'cpu' });
    stop();
    expect(monitor.watcherCount()).toBe(0);
  });

  it('reads the graphics on its own slower beat and shows whichever is busier', async () => {
    let now = 0;
    const graphicsPercent = vi.fn(async () => 72);
    const monitor = new MachineLoadMonitor({
      probes: { cpuTimes: scriptedCpu([0, 20, 20, 20]), graphicsPercent },
      intervalMs: 60_000,
      graphicsIntervalMs: 2_000,
      now: () => now
    });
    const stop = monitor.watch();
    expect(graphicsPercent).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setImmediate(resolve));
    now = 1_000;
    monitor.sample();
    expect(graphicsPercent).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot()).toMatchObject({
      percent: 72,
      cpuPercent: 20,
      gpuPercent: 72,
      source: 'gpu'
    });
    now = 2_000;
    monitor.sample();
    expect(graphicsPercent).toHaveBeenCalledTimes(2);
    stop();
  });

  it('tells listeners only when a figure changes', () => {
    const monitor = new MachineLoadMonitor({
      probes: { cpuTimes: scriptedCpu([0, 30, 30, 50]) },
      intervalMs: 60_000
    });
    const heard: MachineLoad[] = [];
    monitor.onChange(load => heard.push(load));
    const stop = monitor.watch();
    monitor.sample();
    monitor.sample();
    monitor.sample();
    stop();
    // warming-up is the starting snapshot, so the first news is the first figure.
    expect(
      heard.map(load => (load.availability === 'ok' ? load.percent : load.availability))
    ).toEqual([30, 50]);
  });

  it('keeps the resident graphics helper a while after the last viewer, then ends it', () => {
    vi.useFakeTimers();
    const stopGraphics = vi.fn();
    const monitor = new MachineLoadMonitor({
      probes: { cpuTimes: scriptedCpu([0]), graphicsPercent: async () => null, stopGraphics },
      lingerMs: 30_000
    });
    const first = monitor.watch();
    first();
    vi.advanceTimersByTime(10_000);
    // Back within the grace: the helper is kept.
    const second = monitor.watch();
    vi.advanceTimersByTime(60_000);
    expect(stopGraphics).not.toHaveBeenCalled();
    second();
    vi.advanceTimersByTime(30_000);
    expect(stopGraphics).toHaveBeenCalledTimes(1);
  });
});

function recorder(): StreamSocket & { frames: string[] } {
  const frames: string[] = [];
  return { frames, write: (chunk: string) => frames.push(chunk) };
}

describe('the machine-load channel', () => {
  it('measures only while somebody subscribes to it', async () => {
    const app = Fastify({ logger: false });
    const hub = new ChannelHub();
    let watchers = 0;
    let listener: ((load: MachineLoad) => void) | null = null;
    const reading = machineLoadFrom({ cpuPercent: 47, gpuPercent: 12, sampledAt: 't' });
    registerPowerRoutes(app, {
      governor: new PowerGovernor({ cpuCount: 4, pauseSupported: true }),
      allowedOrigins: new Set(),
      channelHub: hub,
      machineLoad: {
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

    expect(hub.channels()).toContain(MACHINE_LOAD_CHANNEL);
    const power = recorder();
    const detachPower = hub.subscribe(power, ['power']);
    expect(watchers).toBe(0);

    const socket = recorder();
    const detach = hub.subscribe(socket, [MACHINE_LOAD_CHANNEL]);
    expect(watchers).toBe(1);
    expect(socket.frames.at(-1)).toContain('"channel":"machine-load"');
    expect(socket.frames.at(-1)).toContain('"percent":47');

    (listener as unknown as (load: MachineLoad) => void)(
      machineLoadFrom({ cpuPercent: 80, gpuPercent: null, sampledAt: 'u' })
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

/** A stand-in PowerShell that answers each `g` with the next scripted line. */
function fakeGraphicsHelper(replies: string[]) {
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

describe('Windows graphics helper', () => {
  it('reads only whole percents in range', () => {
    expect(parseGraphicsReply('47')).toBe(47);
    expect(parseGraphicsReply('-')).toBeNull();
    expect(parseGraphicsReply('101')).toBeNull();
    expect(parseGraphicsReply('4.5')).toBeNull();
    expect(parseGraphicsReply(null)).toBeNull();
  });

  it('asks one fixed word per reading and keeps one helper for all of them', async () => {
    const { child, written } = fakeGraphicsHelper(['-', '31']);
    const spawnHelper = vi.fn(() => child);
    const probe = new WindowsGraphicsProbe({ spawnHelper });
    expect(await probe.read()).toBeNull();
    expect(await probe.read()).toBe(31);
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(written).toEqual(['g\n', 'g\n']);
    probe.stop();
    expect(probe.running()).toBe(false);
  });

  it('gives up after a helper that dies on start, rather than spawning forever', async () => {
    let now = 0;
    const spawnHelper = vi.fn(() => {
      const { child } = fakeGraphicsHelper([]);
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    const probe = new WindowsGraphicsProbe({ spawnHelper, now: () => now });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await probe.read();
      now += 10;
    }
    expect(spawnHelper).toHaveBeenCalledTimes(3);
    expect(probe.disabled()).toBe(true);
  });

  it('reads the counters by their English names, from a constant script', () => {
    expect(GRAPHICS_HELPER_SCRIPT).toContain('PerformanceCounterCategory("GPU Engine")');
    expect(GRAPHICS_HELPER_SCRIPT).toContain('["utilization percentage"]');
    expect(GRAPHICS_HELPER_SCRIPT).not.toContain('$pid');
  });
});
