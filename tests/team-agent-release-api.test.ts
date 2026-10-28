import { beforeEach, expect, it, vi } from 'vitest';
import { agentReleaseApi } from '../apps/web/src/api/team-agent-release';
import { TeamApiError } from '../apps/web/src/api/team';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc }),
  withFreshSession: (run: () => Promise<unknown>) => run()
}));
vi.mock('../apps/web/src/api/team', () => ({
  TeamApiError: class extends Error {
    constructor(
      public code: string,
      public retryable: boolean
    ) {
      super(code);
    }
  },
  throwRpc: (error: unknown) => {
    if (error) throw error;
  }
}));
beforeEach(() => rpc.mockReset());
const input = {
  teamId: 'team',
  agentRowId: 'rk',
  expectedVersion: 'sha256-state',
  requestKey: 'exact-key'
};
const receipt = {
  agentRowId: 'rk',
  version: 'after-sha',
  operationId: 'op',
  requestKey: 'exact-key',
  releasedCount: 2,
  clearedManualCount: 1,
  availability: { status: 'free', assignmentCount: 0, legacyCount: 0 }
};
it('atomically releases the captured full state with CAS instead of iterating Launch deletes', async () => {
  rpc.mockResolvedValue({ data: receipt, error: null });
  expect(await agentReleaseApi.release(input)).toEqual(receipt);
  expect(rpc).toHaveBeenCalledExactlyOnceWith('release_team_agent_assignments', {
    p_team: 'team',
    p_agent: 'rk',
    p_expected_version: 'sha256-state',
    p_key: 'exact-key'
  });
});
it('recovers a lost bulk reply by the exact actor receipt without a second write', async () => {
  rpc.mockRejectedValueOnce(new Error('lost'));
  rpc.mockResolvedValueOnce({ data: receipt, error: null });
  expect(await agentReleaseApi.release(input)).toEqual(receipt);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'release_team_agent_assignments',
    'get_launch_assignment_mutation'
  ]);
});
it('never declares an unrelated or incomplete receipt a successful release', async () => {
  for (const data of [
    null,
    { ...receipt, agentRowId: 'other' },
    { ...receipt, availability: { status: 'busy', assignmentCount: 1, legacyCount: 0 } }
  ]) {
    rpc.mockRejectedValueOnce(new Error('lost'));
    rpc.mockResolvedValueOnce({ data, error: null });
    await expect(agentReleaseApi.release(input)).rejects.toMatchObject({
      code: 'LAUNCH_RESULT_UNCERTAIN'
    });
  }
});
it('does not replay a legacy reconciliation or concurrency refusal', async () => {
  rpc.mockResolvedValue({ data: null, error: new TeamApiError('WRONG_STATE', false) });
  await expect(agentReleaseApi.release(input)).rejects.toMatchObject({ code: 'WRONG_STATE' });
  expect(rpc).toHaveBeenCalledTimes(1);
});
