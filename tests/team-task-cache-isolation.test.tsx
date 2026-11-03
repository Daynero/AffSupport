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

it('keeps independently confirmed labels and agents while a bare task update is in flight', async () => {
  const initial = { ...row, labels: [], agents: [], attachmentCount: 3 };
  let finish!: (value: TeamTaskSummary) => void;
  fixture.listTasks.mockResolvedValue([initial]);
  fixture.updateTask.mockImplementation(
    () =>
      new Promise<TeamTaskSummary>(done => {
        finish = done;
      })
  );
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.tasks).toEqual([initial]));
  let pending!: Promise<TeamTaskSummary>;
  act(() => {
    pending = view.result.current.update(
      initial,
      { title: 'Updated title' },
      { checkVersion: false }
    );
  });
  const labels = [{ id: 'confirmed-label', name: 'Confirmed' } as never];
  const agents = [{ id: 'confirmed-agent' } as never];
  act(() => {
    view.result.current.setTaskLabels(initial.id, labels);
    view.result.current.setTaskAgents(initial.id, agents);
  });
  await act(async () => {
    finish({ ...initial, title: 'Updated title', attachmentCount: 0 });
    await pending;
  });
  expect(view.result.current.tasks[0]).toMatchObject({
    title: 'Updated title',
    labels,
    agents,
    attachmentCount: 3
  });
});

it('does not roll a task back when concurrent write replies arrive out of server-version order', async () => {
  const initial = { ...row, labels: [], agents: [], updatedAt: '2026-11-03T10:00:00.000Z' };
  fixture.listTasks.mockResolvedValue([initial]);
  const completions: Array<(value: TeamTaskSummary) => void> = [];
  fixture.updateTask.mockImplementation(
    () => new Promise<TeamTaskSummary>(done => completions.push(done))
  );
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.tasks).toEqual([initial]));
  let older!: Promise<TeamTaskSummary>;
  let newer!: Promise<TeamTaskSummary>;
  act(() => {
    older = view.result.current.update(initial, { title: 'Earlier save' }, { checkVersion: false });
    newer = view.result.current.update(initial, { title: 'Latest save' }, { checkVersion: false });
  });
  await act(async () => {
    completions[1]!({ ...initial, title: 'Latest save', updatedAt: '2026-11-03T10:00:02.000Z' });
    await newer;
  });
  await act(async () => {
    completions[0]!({ ...initial, title: 'Earlier save', updatedAt: '2026-11-03T10:00:01.000Z' });
    await older;
  });
  expect(view.result.current.tasks[0]).toMatchObject({
    title: 'Latest save',
    updatedAt: '2026-11-03T10:00:02.000Z'
  });
});

it('does not replace a newer authoritative row with a delayed create receipt', async () => {
  const created = { ...row, labels: [], agents: [], updatedAt: '2026-11-03T10:00:01.000Z' };
  const latest = {
    ...created,
    title: 'Edited after creation',
    updatedAt: '2026-11-03T10:00:02.000Z'
  };
  fixture.listTasks.mockResolvedValueOnce([]).mockResolvedValue([latest]);
  let finish!: (value: TeamTaskSummary) => void;
  fixture.createTask.mockImplementation(
    () =>
      new Promise<TeamTaskSummary>(done => {
        finish = done;
      })
  );
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let pending!: Promise<TeamTaskSummary>;
  act(() => {
    pending = view.result.current.create({ title: created.title });
  });
  await act(async () => {
    await view.result.current.refetch();
  });
  expect(view.result.current.tasks).toEqual([latest]);
  await act(async () => {
    finish(created);
    await pending;
  });
  expect(view.result.current.tasks).toEqual([latest]);
});

it('keeps manual refresh pending when a write requires a replacement snapshot', async () => {
  const pending: Array<(rows: TeamTaskSummary[]) => void> = [];
  fixture.listTasks
    .mockResolvedValueOnce([])
    .mockImplementation(() => new Promise<TeamTaskSummary[]>(resolve => pending.push(resolve)));
  fixture.createTask.mockResolvedValue(row);
  const view = renderHook(() => useTasks({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let settled = false;
  let refresh!: Promise<void | undefined>;
  act(() => {
    refresh = view.result.current.refetch().then(() => {
      settled = true;
    });
  });
  await waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => {
    await view.result.current.create({ title: row.title });
  });
  await act(async () => {
    pending[0]!([]);
  });
  expect(pending).toHaveLength(2);
  expect(settled).toBe(false);
  await act(async () => {
    pending[1]!([row]);
    await refresh;
  });
  expect(settled).toBe(true);
  expect(view.result.current.tasks).toEqual([row]);
});
