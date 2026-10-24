import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), mint: vi.fn(), record: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../apps/agent/src/files/path-grants.js', () => ({ pathGrants: { mint: mocks.mint } }));
vi.mock('../apps/agent/src/server/diagnostics-log.js', () => ({
  diagnostics: { record: mocks.record }
}));
const originalPlatform = process.platform;
beforeEach(() => {
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.mint.mockReset();
  mocks.record.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.useRealTimers();
});
function child(ignoreTerm = false) {
  const value = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn((signal: string) => {
      if (!ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => value.emit('close', null));
      return true;
    })
  });
  mocks.spawn.mockReturnValue(value);
  return value;
}
describe('native picker lifecycle', () => {
  it.each(['darwin', 'win32'])(
    'closes a %s picker on agent shutdown and never grants a late selection',
    async platform => {
      Object.defineProperty(process, 'platform', { value: platform });
      const picker = await import('../apps/agent/src/files/picker.js');
      const pickerChild = child();
      const selection = picker.selectVideos();
      pickerChild.stdout.emit('data', Buffer.from('/tmp/synthetic-late.mp4\n'));
      await picker.shutdownNativePickers();
      await expect(selection).resolves.toEqual([]);
      expect(pickerChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.record).toHaveBeenCalledWith(
        'picker',
        'exit',
        expect.objectContaining({ outcome: 'interrupted' })
      );
    }
  );
  it('escalates a picker that ignores graceful shutdown and clears its timers', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.useFakeTimers();
    const picker = await import('../apps/agent/src/files/picker.js');
    const pickerChild = child(true);
    const selection = picker.selectVideos();
    const shutdown = picker.shutdownNativePickers();
    await vi.runAllTimersAsync();
    await shutdown;
    await selection;
    expect(pickerChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not launch another dialog once shutdown has begun', async () => {
    const picker = await import('../apps/agent/src/files/picker.js');
    await picker.shutdownNativePickers();
    await expect(picker.selectVideos()).resolves.toEqual([]);
    await expect(picker.selectOutputFolder()).resolves.toBeNull();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('does not mislabel a termination error as an unavailable picker', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const picker = await import('../apps/agent/src/files/picker.js');
    const pickerChild = child();
    pickerChild.kill.mockImplementation(() => {
      queueMicrotask(() => pickerChild.emit('error', new Error('gone')));
      return true;
    });
    const selection = picker.selectVideos();
    await picker.shutdownNativePickers();
    await expect(selection).resolves.toEqual([]);
    expect(mocks.record).toHaveBeenCalledWith(
      'picker',
      'exit',
      expect.objectContaining({ outcome: 'interrupted' })
    );
  });
});

it.each(['darwin', 'win32'])(
  'aborts an output-folder picker on %s without granting a late choice',
  async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    const picker = await import('../apps/agent/src/files/picker.js');
    const pickerChild = child();
    const controller = new AbortController();
    const selected = picker.selectOutputFolder(controller.signal);
    pickerChild.stdout.emit('data', Buffer.from('/tmp/own-output\n'));
    controller.abort();
    pickerChild.emit('close', 0);
    await expect(selected).resolves.toBeNull();
    expect(pickerChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.mint).not.toHaveBeenCalled();
  }
);

it('keeps a shared folder picker for another caller when just one waiter cancels', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const picker = await import('../apps/agent/src/files/picker.js');
  const pickerChild = child();
  const controller = new AbortController();
  const first = picker.selectOutputFolder(controller.signal);
  const second = picker.selectOutputFolder();
  controller.abort();
  expect(pickerChild.kill).not.toHaveBeenCalled();
  pickerChild.stdout.emit('data', Buffer.from('/tmp/own-output\n'));
  pickerChild.emit('close', 0);
  await expect(first).resolves.toBeNull();
  await expect(second).resolves.toBe('/tmp/own-output');
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it.each(['darwin', 'win32'])(
  'bounds termination of an aborted %s destination picker',
  async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.useFakeTimers();
    const picker = await import('../apps/agent/src/files/picker.js');
    const pickerChild = child(true);
    const controller = new AbortController();
    const selection = picker.selectOutputFolder(controller.signal);
    controller.abort();
    await expect(selection).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pickerChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.mint).not.toHaveBeenCalled();
  }
);
