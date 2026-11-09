import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ spawn: vi.fn(), record: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: hooks.spawn }));
vi.mock('../apps/agent/src/server/diagnostics-log.js', () => ({
  diagnostics: { record: hooks.record },
  durationBucket: () => 'under_1s'
}));
import { spawnManaged, type ManagedSpawnGovernor } from '../apps/agent/src/power/spawn.js';

function fixture(pid: number | undefined = 70101) {
  const nativeKill = vi.fn((_signal?: NodeJS.Signals | number) => true);
  const child = Object.assign(new EventEmitter(), {
    pid: pid as number | undefined,
    exitCode: null,
    kill: nativeKill
  });
  hooks.spawn.mockReturnValue(child);
  const governor = {
    register: vi.fn(),
    release: vi.fn(),
    resumeForTermination: vi.fn(),
    budget: () => ({ priority: null }),
    scaleTimeout: (ms: number) => ms
  } as unknown as ManagedSpawnGovernor;
  spawnManaged(governor, 'synthetic-tool', [], { toolId: 'stitcher' });
  return { child, governor, nativeKill };
}
beforeEach(() => {
  vi.useFakeTimers();
  hooks.spawn.mockReset();
  hooks.record.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

it('keeps a live child inside the shared budget until close after an error', () => {
  const { child, governor } = fixture();
  child.emit('error', Error('synthetic I/O failure'));
  const releasedEarly = vi.mocked(governor.release).mock.calls.length;
  child.emit('close', 1, null);
  expect(releasedEarly).toBe(0);
  expect(governor.release).toHaveBeenCalledExactlyOnceWith(child);
});
it('does not claim process exit in diagnostics before an existing child closes', () => {
  const { child } = fixture();
  child.emit('error', Error('synthetic I/O failure'));
  const reportedEarly = hooks.record.mock.calls.some(call => call[1] === 'exited');
  child.emit('close', 1, null);
  expect(reportedEarly).toBe(false);
  expect(hooks.record).toHaveBeenLastCalledWith(
    'spawn',
    'exited',
    expect.objectContaining({ outcome: 'nonzero' })
  );
});
it('keeps termination escalation armed across an error from a live child', async () => {
  const { child, nativeKill } = fixture();
  child.kill('SIGTERM');
  child.emit('error', Error('synthetic signal error'));
  await vi.advanceTimersByTimeAsync(2000);
  child.emit('close', null, 'SIGKILL');
  expect(nativeKill).toHaveBeenLastCalledWith('SIGKILL');
});
it('releases and records a proven spawn failure once even if close follows', () => {
  const { child, governor } = fixture();
  child.pid = undefined;
  child.emit('error', Error('synthetic spawn failure'));
  expect(governor.release).toHaveBeenCalledExactlyOnceWith(child);
  child.emit('close', -2, null);
  expect(governor.release).toHaveBeenCalledTimes(1);
  expect(hooks.record.mock.calls.filter(call => call[1] === 'exited')).toHaveLength(1);
  expect(hooks.record).toHaveBeenLastCalledWith(
    'spawn',
    'exited',
    expect.objectContaining({ outcome: 'spawn_error' })
  );
});
