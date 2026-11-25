import { expect, it, vi } from 'vitest';
import { runTool, toolSucceeded } from '../apps/agent/src/stitcher/run';

/**
 * 072: a stuck FFmpeg was stopped only by the six-hour watchdog of the whole run, while its
 * heartbeat kept the round looking alive. A child that writes nothing and uses no CPU for the
 * stall budget is now stopped, and its failure takes the caller's usual failure code.
 */
const node = process.execPath;

it('stops a child that writes nothing and uses no CPU', async () => {
  const cpuSeconds = vi.fn(async () => 1);
  const result = await runTool(node, ['-e', 'setTimeout(() => {}, 60_000)'], {
    stallMs: 300,
    stallCheckMs: 50,
    killAfterMs: 1_000,
    cpuSeconds
  });
  expect(result.stalled).toBe(true);
  expect(result.cancelled).toBe(false);
  expect(toolSucceeded(result)).toBe(false);
  expect(cpuSeconds).toHaveBeenCalled();
}, 20_000);

it('leaves a child alone while it keeps writing', async () => {
  const result = await runTool(
    node,
    [
      '-e',
      'let n = 0; const t = setInterval(() => { process.stderr.write("frame\\n"); if (++n === 15) { clearInterval(t); } }, 40);'
    ],
    { stallMs: 300, stallCheckMs: 50, cpuSeconds: async () => 1 }
  );
  expect(result.stalled).toBeUndefined();
  expect(toolSucceeded(result)).toBe(true);
}, 20_000);

it('leaves a quiet child alone while its CPU time moves, and when CPU time is unknown', async () => {
  let cpu = 0;
  const moving = await runTool(node, ['-e', 'setTimeout(() => {}, 700)'], {
    stallMs: 300,
    stallCheckMs: 50,
    cpuSeconds: async () => (cpu += 0.1)
  });
  expect(moving.stalled).toBeUndefined();
  expect(toolSucceeded(moving)).toBe(true);
  const unknown = await runTool(node, ['-e', 'setTimeout(() => {}, 700)'], {
    stallMs: 300,
    stallCheckMs: 50,
    cpuSeconds: async () => null
  });
  expect(unknown.stalled).toBeUndefined();
  expect(toolSucceeded(unknown)).toBe(true);
}, 20_000);
