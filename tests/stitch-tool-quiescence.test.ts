import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ spawn: vi.fn(), governor: vi.fn() }));
vi.mock('../apps/agent/src/power/spawn.js', () => ({
  spawnTracked: hooks.spawn,
  activeGovernorOrNull: hooks.governor
}));
import { runTool } from '../apps/agent/src/stitcher/run';

function child(pid: number | undefined = 70100) {
  const instance = Object.assign(new EventEmitter(), {
    pid: pid as number | undefined,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn((_signal?: NodeJS.Signals | number) => true)
  });
  hooks.spawn.mockReturnValue(instance);
  return instance;
}
beforeEach(() => {
  hooks.spawn.mockReset();
  hooks.governor.mockReset();
  hooks.governor.mockReturnValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

it('joins close after an error from a child that has a PID instead of reporting quiescence early', async () => {
  const process = child();
  let finished = false;
  const pending = runTool('fixture-tool', []).then(result => {
    finished = true;
    return result;
  });
  process.emit('error', Object.assign(Error('synthetic child error'), { code: 'EIO' }));
  await Promise.resolve();
  const finishedBeforeClose = finished;
  process.emit('close', 1);
  const result = await pending;
  expect(finishedBeforeClose).toBe(false);
  expect(result).toMatchObject({ code: 1, spawnErrorCode: 'EIO', cancelled: false });
  expect(process.kill).toHaveBeenCalledWith('SIGTERM');
});
it('settles a proven spawn failure without waiting for a process that never existed', async () => {
  const process = child();
  process.pid = undefined;
  const pending = runTool('fixture-tool', []);
  process.emit('error', Object.assign(Error('synthetic missing tool'), { code: 'ENOENT' }));
  expect(await pending).toMatchObject({ code: null, spawnErrorCode: 'ENOENT', cancelled: false });
  expect(process.kill).not.toHaveBeenCalled();
});
it('keeps ownership until close when the child observer throws', async () => {
  const process = child();
  let finished = false;
  const pending = runTool('fixture-tool', [], {
    onChild: () => {
      throw Error('observer failure');
    }
  }).then(
    result => {
      finished = true;
      return result;
    },
    error => {
      finished = true;
      return error as Error;
    }
  );
  await Promise.resolve();
  const early = finished;
  process.emit('close', 0);
  const result = await pending;
  expect(early).toBe(false);
  expect(result).toMatchObject({ code: 0, spawnErrorCode: null });
});
it('contains a failing progress observer and still joins the actual child exit', async () => {
  const process = child();
  const pending = runTool('fixture-tool', [], {
    onLine: () => {
      throw Error('observer failure');
    }
  });
  let escaped = false;
  try {
    process.stdout.emit('data', Buffer.from('frame=1\n'));
  } catch {
    escaped = true;
  }
  process.emit('close', 0);
  const result = await pending;
  expect(escaped).toBe(false);
  expect(result).toMatchObject({ code: 0, stdout: 'frame=1\n' });
});
it('scales the default termination deadline under the shared power limit', async () => {
  vi.useFakeTimers();
  const scaleTimeout = vi.fn((ms: number) => ms * 5);
  hooks.governor.mockReturnValue({ scaleTimeout });
  const process = child(),
    controller = new AbortController();
  const pending = runTool('fixture-tool', [], { signal: controller.signal });
  controller.abort();
  await vi.advanceTimersByTimeAsync(4000);
  const killedTooEarly = process.kill.mock.calls.some(call => call[0] === 'SIGKILL');
  await vi.advanceTimersByTimeAsync(16000);
  process.emit('close', null);
  await pending;
  expect(killedTooEarly).toBe(false);
  expect(scaleTimeout).toHaveBeenCalledExactlyOnceWith(4000);
  expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
});
it('keeps the default termination timing unchanged at full power', async () => {
  vi.useFakeTimers();
  hooks.governor.mockReturnValue({ scaleTimeout: (ms: number) => ms });
  const process = child(),
    controller = new AbortController();
  const pending = runTool('fixture-tool', [], { signal: controller.signal });
  controller.abort();
  await vi.advanceTimersByTimeAsync(3999);
  const early = process.kill.mock.calls.some(call => call[0] === 'SIGKILL');
  await vi.advanceTimersByTimeAsync(1);
  process.emit('close', null);
  await pending;
  expect(early).toBe(false);
  expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
});
it('does not scale an explicitly provided termination deadline a second time', async () => {
  vi.useFakeTimers();
  const scaleTimeout = vi.fn((ms: number) => ms * 5);
  hooks.governor.mockReturnValue({ scaleTimeout });
  const process = child(),
    controller = new AbortController();
  const pending = runTool('fixture-tool', [], { signal: controller.signal, killAfterMs: 6000 });
  controller.abort();
  await vi.advanceTimersByTimeAsync(5999);
  const early = process.kill.mock.calls.some(call => call[0] === 'SIGKILL');
  await vi.advanceTimersByTimeAsync(1);
  process.emit('close', null);
  await pending;
  expect(early).toBe(false);
  expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
  expect(scaleTimeout).not.toHaveBeenCalled();
});

it('retains the first failure and owns repeated child errors until close', async () => {
  const process = child();
  const pending = runTool('fixture-tool', []);
  process.emit('error', Object.assign(Error('first failure'), { code: 'EIO' }));
  expect(() =>
    process.emit('error', Object.assign(Error('later failure'), { code: 'EPIPE' }))
  ).not.toThrow();
  process.emit('close', 1);
  expect(await pending).toMatchObject({ spawnErrorCode: 'EIO', code: 1 });
  expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
});
it('does not leave a kill timer armed when termination synchronously observes close', async () => {
  vi.useFakeTimers();
  const process = child(),
    controller = new AbortController();
  process.kill.mockImplementation(() => {
    process.emit('close', null);
    return true;
  });
  const pending = runTool('fixture-tool', [], { signal: controller.signal });
  controller.abort();
  expect(await pending).toMatchObject({ cancelled: true });
  expect(vi.getTimerCount()).toBe(0);
});
