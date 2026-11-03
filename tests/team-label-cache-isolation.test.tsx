// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamTaskLabel } from '@video-compressor/shared';
import { useTaskLabels } from '../apps/web/src/team/labels/useTaskLabels';
const fixture = vi.hoisted(() => ({
  actor: 'alice',
  accessRevision: 0,
  listTaskLabels: vi.fn(),
  createTaskLabel: vi.fn(),
  updateTaskLabel: vi.fn(),
  deleteTaskLabel: vi.fn()
}));
vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: fixture.actor } })
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useOptionalTeam: () => ({ accessRevision: fixture.accessRevision })
}));
vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: () => null }));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: fixture }));
const label = { id: 'label', name: 'Private label', color: 'blue', taskCount: 7 } as TeamTaskLabel;
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  fixture.actor = 'alice';
  fixture.accessRevision = 0;
});

it.each(['actor', 'access'])(
  'clears labels synchronously on %s changes and refuses retained write callbacks',
  async changed => {
    fixture.listTaskLabels
      .mockResolvedValueOnce([label])
      .mockImplementation(() => new Promise(() => {}));
    const view = renderHook(() => useTaskLabels({ teamId: 'team' }));
    await waitFor(() => expect(view.result.current.labels).toEqual([label]));
    const retained = view.result.current;
    if (changed === 'actor') fixture.actor = 'bob';
    else fixture.accessRevision++;
    view.rerender();
    expect(view.result.current.labels).toEqual([]);
    expect(view.result.current.loading).toBe(true);
    await expect(retained.create('Old label', label.color)).rejects.toMatchObject({
      name: 'AbortError'
    });
    await expect(retained.update(label.id, 'Old label', label.color)).rejects.toMatchObject({
      name: 'AbortError'
    });
    await expect(retained.remove(label.id)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.createTaskLabel).not.toHaveBeenCalled();
    expect(fixture.updateTaskLabel).not.toHaveBeenCalled();
    expect(fixture.deleteTaskLabel).not.toHaveBeenCalled();
  }
);

it('retains task counts on an update receipt and drops a late receipt from a previous actor', async () => {
  fixture.listTaskLabels.mockResolvedValue([label]);
  fixture.updateTaskLabel.mockResolvedValue({ ...label, name: 'Renamed', taskCount: 0 });
  let finish!: (value: TeamTaskLabel) => void;
  fixture.createTaskLabel.mockImplementation(
    () =>
      new Promise<TeamTaskLabel>(done => {
        finish = done;
      })
  );
  const view = renderHook(() => useTaskLabels({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.labels).toEqual([label]));
  await act(async () => {
    await view.result.current.update(label.id, 'Renamed', label.color);
  });
  expect(view.result.current.labels[0]?.taskCount).toBe(7);
  let pending!: Promise<TeamTaskLabel>;
  act(() => {
    pending = view.result.current.create('Old actor label', label.color);
  });
  fixture.actor = 'bob';
  fixture.listTaskLabels.mockResolvedValue([]);
  view.rerender();
  await act(async () => {
    finish(label);
    await pending;
  });
  expect(view.result.current.labels).toEqual([]);
});

it('does not duplicate a created label already delivered by a concurrent authoritative read', async () => {
  fixture.listTaskLabels.mockResolvedValueOnce([]).mockResolvedValue([label]);
  let finish!: (value: TeamTaskLabel) => void;
  fixture.createTaskLabel.mockImplementation(
    () =>
      new Promise<TeamTaskLabel>(done => {
        finish = done;
      })
  );
  const view = renderHook(() => useTaskLabels({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let pending!: Promise<TeamTaskLabel>;
  act(() => {
    pending = view.result.current.create(label.name, label.color);
  });
  await act(async () => {
    await view.result.current.refetch();
  });
  expect(view.result.current.labels).toEqual([label]);
  await act(async () => {
    finish(label);
    await pending;
  });
  expect(view.result.current.labels).toEqual([label]);
});

it('does not revert a newer label when an older update receipt arrives last', async () => {
  const initial = { ...label, updatedAt: '2026-11-03T10:00:00.000Z' };
  fixture.listTaskLabels.mockResolvedValue([initial]);
  const completions: Array<(value: TeamTaskLabel) => void> = [];
  fixture.updateTaskLabel.mockImplementation(
    () => new Promise<TeamTaskLabel>(done => completions.push(done))
  );
  const view = renderHook(() => useTaskLabels({ teamId: 'team' }));
  await waitFor(() => expect(view.result.current.labels).toEqual([initial]));
  let older!: Promise<TeamTaskLabel>;
  let newer!: Promise<TeamTaskLabel>;
  act(() => {
    older = view.result.current.update(label.id, 'Earlier', label.color);
    newer = view.result.current.update(label.id, 'Latest', label.color);
  });
  await act(async () => {
    completions[1]!({ ...initial, name: 'Latest', updatedAt: '2026-11-03T10:00:02.000Z' });
    await newer;
  });
  await act(async () => {
    completions[0]!({ ...initial, name: 'Earlier', updatedAt: '2026-11-03T10:00:01.000Z' });
    await older;
  });
  expect(view.result.current.labels[0]).toMatchObject({
    name: 'Latest',
    updatedAt: '2026-11-03T10:00:02.000Z',
    taskCount: 7
  });
});

it('keeps manual refresh pending when a label write supersedes its snapshot', async () => {
  const pending: Array<(rows: TeamTaskLabel[]) => void> = [];
  fixture.listTaskLabels
    .mockResolvedValueOnce([])
    .mockImplementation(() => new Promise<TeamTaskLabel[]>(resolve => pending.push(resolve)));
  fixture.createTaskLabel.mockResolvedValue(label);
  const view = renderHook(() => useTaskLabels({ teamId: 'team' }));
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
    await view.result.current.create(label.name, label.color);
  });
  await act(async () => {
    pending[0]!([]);
  });
  expect(pending).toHaveLength(2);
  expect(settled).toBe(false);
  await act(async () => {
    pending[1]!([label]);
    await refresh;
  });
  expect(settled).toBe(true);
  expect(view.result.current.labels).toEqual([label]);
});
