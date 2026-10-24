import { afterEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc: seam.rpc }),
  getSupabaseClient: () => null,
  withFreshSession: async (fn: () => unknown) => fn()
}));
import { teamApi } from '../apps/web/src/api/team';
afterEach(() => vi.resetAllMocks());
it('reads only the existing narrow team-scoped projection and strips unexpected private fields', async () => {
  seam.rpc.mockResolvedValue({
    data: [
      {
        user_id: 'member-b',
        display_name: 'Editor B',
        email: 'private@example.test',
        permission_overrides: { edit: true }
      }
    ],
    error: null
  });
  expect(await teamApi.listAssignees('team-a')).toEqual([
    { userId: 'member-b', displayName: 'Editor B' }
  ]);
  expect(seam.rpc).toHaveBeenCalledWith('list_launch_assignees', { p_team: 'team-a' });
});
it('refuses malformed directory responses rather than presenting unassigned', async () => {
  for (const data of [
    null,
    {},
    [{ user_id: 'member-b' }],
    [{ user_id: 5, display_name: 'Name' }]
  ]) {
    seam.rpc.mockResolvedValue({ data, error: null });
    await expect(teamApi.listAssignees('team-a')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  }
});
it('preserves authoritative access denial', async () => {
  seam.rpc.mockResolvedValue({
    data: null,
    error: { code: '42501', message: 'PERMISSION_DENIED' }
  });
  await expect(teamApi.listAssignees('team-a')).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
});
