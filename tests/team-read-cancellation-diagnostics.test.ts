import { afterEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ track: vi.fn(), rpc: vi.fn() }));
vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: seam.track, journalContext: () => ({ userId: 'actor' }) }
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc: seam.rpc }),
  getSupabaseClient: () => null,
  withFreshSession: async (work: () => unknown) => work()
}));
import { memberAttempt } from '../apps/web/src/team/members/diagnostics';
import { taskAttempt, taskRpc } from '../apps/web/src/team/tasks/diagnostics';
import { teamApi } from '../apps/web/src/api/team';
afterEach(() => vi.resetAllMocks());
function expectCancellation() {
  const events = seam.track.mock.calls.map(([event]) => event);
  expect(events).toContain('operation_cancelled');
  expect(events).not.toContain('operation_failed');
  expect(events).not.toContain('error_occurred');
}
it('reports a rejected task scope abort as cancellation while preserving the rejection', async () => {
  const cause = new DOMException('Scope ended', 'AbortError');
  await expect(taskRpc('task_list', () => Promise.reject(cause))).rejects.toBe(cause);
  expectCancellation();
});
it.each(['listTasks', 'listAssignees'] as const)(
  'reports PostgREST %s abort replies as cancellation',
  async method => {
    seam.rpc.mockResolvedValue({
      data: null,
      error: { message: 'AbortError: This operation was aborted' }
    });
    const request =
      method === 'listTasks'
        ? teamApi.listTasks({ teamId: 'team' })
        : teamApi.listAssignees('team');
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expectCancellation();
  }
);
it('still reports a genuine read error as failure', async () => {
  const cause = new Error('A read failed');
  await expect(taskRpc('task_list', () => Promise.reject(cause))).rejects.toBe(cause);
  const events = seam.track.mock.calls.map(([event]) => event);
  expect(events).toContain('operation_failed');
  expect(events).toContain('error_occurred');
  expect(events).not.toContain('operation_cancelled');
});

it.each(['member', 'task'])('preserves the closed timeout code in %s diagnostics', kind => {
  const cause = Object.assign(new Error('Read deadline exceeded'), {
    code: 'WORKSPACE_READ_TIMEOUT'
  });
  const attempt =
    kind === 'member'
      ? memberAttempt('members_list', crypto.randomUUID())
      : taskAttempt('task_list');
  attempt.finish('failure', cause);
  expect(seam.track).toHaveBeenCalledWith(
    'error_occurred',
    expect.objectContaining({ error_code: 'WORKSPACE_READ_TIMEOUT' })
  );
  expect(seam.track).toHaveBeenCalledWith(
    'operation_failed',
    expect.objectContaining({ error_code: 'WORKSPACE_READ_TIMEOUT' })
  );
});
