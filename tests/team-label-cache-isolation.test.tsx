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
