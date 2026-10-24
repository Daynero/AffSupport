// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { useTaskAutosave } from '../apps/web/src/team/tasks/useTaskAutosave';
const stamp = '2026-09-05T11:00:00.000Z';
function task(): TeamTaskSummary {
  return {
    id: 'task',
    teamId: 'team',
    title: 'Peer',
    note: null,
    assigneeId: null,
    assigneeLabelSnapshot: null,
    status: 'todo',
    progressMax: 100,
    progressValue: 0,
    progressManuallySet: false,
    attachmentCount: 0,
    dateOn: null,
    agents: [],
    labels: [],
    createdBy: 'actor',
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: null
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('does not replay acknowledged fields with a later refused patch', async () => {
  const write = vi
    .fn()
    .mockResolvedValueOnce(task())
    .mockRejectedValueOnce(new Error('SOURCE_CHANGED'))
    .mockResolvedValue(task());
  const { result } = renderHook(() =>
    useTaskAutosave({ write, read: async () => task(), onSaved: vi.fn() })
  );
  await act(async () => {
    result.current.save({ title: 'Already acknowledged' });
  });
  await act(async () => {
    result.current.save({ note: 'Still local' });
  });
  expect(result.current.state).toBe('conflict');
  await act(async () => {
    result.current.overwrite();
  });
  expect(write.mock.calls[2]?.[0]).toEqual({ note: 'Still local' });
});
it('holds typing that was pending when a conflict arrived until an explicit choice', async () => {
  let reject!: (cause: unknown) => void;
  const write = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no;
      })
    )
    .mockResolvedValue(task());
  const { result } = renderHook(() =>
    useTaskAutosave({ write, read: async () => task(), onSaved: vi.fn() })
  );
  act(() => result.current.save({ title: 'First local' }));
  act(() => result.current.saveSoon({ note: 'Latest local' }));
  await act(async () => {
    reject(new Error('SOURCE_CHANGED'));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(write).toHaveBeenCalledOnce();
  expect(result.current.state).toBe('conflict');
  await act(async () => result.current.overwrite());
  expect(write.mock.calls[1]?.[0]).toEqual({ title: 'First local', note: 'Latest local' });
});
it('drops all unsent typing timers when taking the reviewed server version', async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error('SOURCE_CHANGED'))
    .mockResolvedValue(task());
  const { result } = renderHook(() =>
    useTaskAutosave({ write, read: async () => task(), onSaved: vi.fn() })
  );
  await act(async () => result.current.save({ title: 'Local' }));
  act(() => result.current.saveSoon({ note: 'Later typing' }));
  act(() => result.current.takeNewer());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(write).toHaveBeenCalledOnce();
  expect(result.current.state).toBe('idle');
});
it('ignores a conflict read that finishes after the user dismissed that decision', async () => {
  let resolve!: (value: TeamTaskSummary) => void;
  const read = vi.fn(
    () =>
      new Promise<TeamTaskSummary>(yes => {
        resolve = yes;
      })
  );
  const { result } = renderHook(() =>
    useTaskAutosave({
      write: vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')),
      read,
      onSaved: vi.fn()
    })
  );
  await act(async () => result.current.save({ title: 'Local' }));
  expect(result.current.state).toBe('conflict');
  act(() => result.current.takeNewer());
  await act(async () => {
    resolve(task());
  });
  expect(result.current.state).toBe('idle');
  expect(result.current.conflict).toBeNull();
});

it('accepts a newer confirmed snapshot selected by the editor instead of an older conflict read', async () => {
  const saved = vi.fn();
  const { result } = renderHook(() =>
    useTaskAutosave({
      write: vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')),
      read: async () => task(),
      onSaved: saved
    })
  );
  await act(async () => result.current.save({ title: 'Local' }));
  const latest = { ...task(), title: 'Latest peer', updatedAt: '2026-09-05T12:00:00.000Z' };
  act(() => result.current.takeNewer(latest));
  expect(saved).toHaveBeenCalledWith(latest);
});

it('rejects a confirmed override belonging to another task or space', async () => {
  const saved = vi.fn();
  const { result } = renderHook(() =>
    useTaskAutosave({
      write: vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')),
      read: async () => task(),
      onSaved: saved
    })
  );
  await act(async () => result.current.save({ title: 'Local' }));
  act(() => result.current.takeNewer({ ...task(), id: 'other-task', teamId: 'other-space' }));
  expect(saved).toHaveBeenCalledWith(task());
});
