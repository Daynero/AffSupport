// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { useTasks } from '../apps/web/src/team/tasks/useTasks';

const fixture = vi.hoisted(() => ({
  actor: 'alice',
  permissions: { view: true },
  listTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn()
}));
vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: fixture.actor } })
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useOptionalTeam: () => ({ permissions: fixture.permissions })
}));
vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: () => null }));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    listTasks: fixture.listTasks,
    createTask: fixture.createTask,
    updateTask: fixture.updateTask
  }
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
  fixture.actor = 'alice';
  fixture.permissions = { view: true };
});
const row = { id: 'secret', title: 'Private task', note: null, status: 'todo' } as TeamTaskSummary;

it('never paints the previous actor’s cached rows while the replacement read is pending', async () => {
  fixture.listTasks
    .mockResolvedValueOnce([row])
    .mockImplementationOnce(() => new Promise(() => {}));
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.tasks).toHaveLength(1));
  fixture.actor = 'bob';
  view.rerender();
  expect(view.result.current.tasks).toEqual([]);
  expect(view.result.current.loading).toBe(true);
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledTimes(2));
});

it('drops a pending result after permissions change and does not reuse rows on remount', async () => {
  let resolve!: (rows: TeamTaskSummary[]) => void;
  fixture.listTasks
    .mockImplementationOnce(
      () =>
        new Promise<TeamTaskSummary[]>(done => {
          resolve = done;
        })
    )
    .mockResolvedValueOnce([])
    .mockImplementationOnce(() => new Promise(() => {}));
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledOnce());
  fixture.permissions = { view: false };
  view.rerender();
  await act(async () => {
    resolve([row]);
  });
  expect(view.result.current.tasks).toEqual([]);
  view.unmount();
  const next = renderHook(() => useTasks({ teamId: 'team' }));
  expect(next.result.current.tasks).toEqual([]);
  expect(next.result.current.loading).toBe(true);
});

it('coalesces slow revision bursts into one follow-up read', async () => {
  let resolve!: (rows: TeamTaskSummary[]) => void;
  fixture.listTasks
    .mockImplementationOnce(
      () =>
        new Promise<TeamTaskSummary[]>(done => {
          resolve = done;
        })
    )
    .mockResolvedValue([]);
  const view = renderHook(({ revision }) => useTasks({ teamId: 'team', revision }), {
    initialProps: { revision: 0 }
  });
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledOnce());
  for (let revision = 1; revision <= 10; revision++) {
    view.rerender({ revision });
    await act(async () => {
      await new Promise(done => setTimeout(done, 2));
    });
  }
  expect(fixture.listTasks).toHaveBeenCalledOnce();
  await act(async () => resolve([]));
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledTimes(2));
});

it('aborts pagination and ignores its late rows after an actor change', async () => {
  let resolve!: (rows: TeamTaskSummary[]) => void;
  fixture.listTasks
    .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ ...row, id: String(i) })))
    .mockImplementationOnce(
      () =>
        new Promise<TeamTaskSummary[]>(done => {
          resolve = done;
        })
    )
    .mockResolvedValueOnce([]);
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.hasMore).toBe(true));
  act(() => {
    void view.result.current.loadMore();
  });
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledTimes(2));
  const signal = fixture.listTasks.mock.calls[1]![0].signal as AbortSignal;
  fixture.actor = 'bob';
  view.rerender();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve([row]));
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledTimes(3));
  expect(view.result.current.tasks).toEqual([]);
});

it('does not store the previous filter’s rows under a newly selected cache key', async () => {
  fixture.listTasks.mockResolvedValueOnce([row]).mockImplementation(() => new Promise(() => {}));
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.tasks).toHaveLength(1));
  act(() => view.result.current.setStatusFilter('done'));
  expect(view.result.current.tasks).toEqual([]);
  expect(view.result.current.loading).toBe(true);
  act(() => view.result.current.setStatusFilter('all'));
  expect(view.result.current.tasks).toEqual([row]);
  act(() => view.result.current.setStatusFilter('done'));
  expect(view.result.current.tasks).toEqual([]);
});

it('ignores a late successful mutation after an actor change', async () => {
  let finish!: (value: TeamTaskSummary) => void;
  fixture.listTasks.mockResolvedValue([]);
  fixture.createTask.mockImplementation(
    () =>
      new Promise<TeamTaskSummary>(done => {
        finish = done;
      })
  );
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let mutation!: Promise<TeamTaskSummary>;
  act(() => {
    mutation = view.result.current.create({ title: 'Private task' });
  });
  fixture.actor = 'bob';
  view.rerender();
  await act(async () => {
    finish(row);
    await mutation;
  });
  expect(view.result.current.tasks).toEqual([]);
});

it('keeps a confirmed write when an older read completes and schedules one fresh follow-up', async () => {
  let finish!: (value: TeamTaskSummary[]) => void;
  fixture.listTasks
    .mockImplementationOnce(
      () =>
        new Promise<TeamTaskSummary[]>(done => {
          finish = done;
        })
    )
    .mockResolvedValue([row]);
  fixture.createTask.mockResolvedValue(row);
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledOnce());
  await act(async () => {
    await view.result.current.create({ title: 'Private task' });
  });
  expect(view.result.current.tasks).toEqual([row]);
  await act(async () => {
    finish([]);
  });
  await waitFor(() => expect(fixture.listTasks).toHaveBeenCalledTimes(2));
  expect(view.result.current.tasks).toEqual([row]);
});

it.each(['actor', 'team'])(
  'refuses retained mutation/pagination callbacks invoked after a %s change',
  async changed => {
    const initial = Array.from({ length: 50 }, (_, index) => ({
      ...row,
      id: String(index),
      labels: [],
      agents: []
    }));
    const replacement = { ...initial[0]!, title: 'Current scope task' };
    fixture.listTasks.mockResolvedValueOnce(initial).mockResolvedValue([replacement]);
    const view = renderHook(({ teamId }) => useTasks({ teamId }), {
      initialProps: { teamId: 'old-team' }
    });
    await waitFor(() => expect(view.result.current.hasMore).toBe(true));
    const retained = view.result.current;
    if (changed === 'actor') fixture.actor = 'bob';
    view.rerender({ teamId: changed === 'team' ? 'new-team' : 'old-team' });
    await waitFor(() => expect(view.result.current.tasks).toEqual([replacement]));
    const reads = fixture.listTasks.mock.calls.length;
    await expect(retained.create({ title: 'Old scope' })).rejects.toMatchObject({
      name: 'AbortError'
    });
    await expect(retained.update(initial[0]!, { title: 'Old scope' })).rejects.toMatchObject({
      name: 'AbortError'
    });
    await act(async () => {
      await retained.loadMore();
      retained.setTaskLabels('0', [{ id: 'old-label' } as never]);
      retained.setTaskAgents('0', [{ id: 'old-agent' } as never]);
    });
    expect(fixture.createTask).not.toHaveBeenCalled();
    expect(fixture.updateTask).not.toHaveBeenCalled();
    expect(fixture.listTasks).toHaveBeenCalledTimes(reads);
    expect(view.result.current.tasks).toEqual([replacement]);
  }
);
