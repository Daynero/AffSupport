import { beforeEach, expect, it, vi } from 'vitest';
import { launchAssignmentsApi } from '../apps/web/src/api/team-launch-assignments';
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
  launchId: 'launch',
  agentRowId: 'rk',
  expectedVersion: '0',
  requestKey: 'same-key'
};
const receipt = {
  launchId: 'launch',
  version: '1',
  state: 'assigned',
  agentRowId: 'rk',
  sourceAgentRowId: 'original-rk',
  operationId: 'operation',
  requestKey: 'same-key'
};
it('writes only explicit current assignment with CAS and its request key, never source/config', async () => {
  rpc.mockResolvedValue({ data: receipt, error: null });
  expect(await launchAssignmentsApi.set(input)).toEqual(receipt);
  expect(rpc).toHaveBeenCalledExactlyOnceWith('set_launch_assignment', {
    p_team: 'team',
    p_launch: 'launch',
    p_agent: 'rk',
    p_expected_version: '0',
    p_key: 'same-key'
  });
});
it('recovers a committed lost reply by actor-scoped durable receipt, without replaying the write', async () => {
  rpc.mockRejectedValueOnce(new Error('network'));
  rpc.mockResolvedValueOnce({ data: receipt, error: null });
  expect(await launchAssignmentsApi.set(input)).toEqual(receipt);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'set_launch_assignment',
    'get_launch_assignment_mutation'
  ]);
  expect(rpc.mock.calls[1][1]).toEqual({ p_team: 'team', p_key: 'same-key' });
});
it('keeps an absent or wrong-intent receipt unknown, never a successful assignment', async () => {
  for (const data of [
    null,
    { ...receipt, launchId: 'another-launch' },
    { ...receipt, agentRowId: 'another-rk' }
  ]) {
    rpc.mockRejectedValueOnce(new Error('network'));
    rpc.mockResolvedValueOnce({ data, error: null });
    await expect(launchAssignmentsApi.set(input)).rejects.toMatchObject({
      code: 'LAUNCH_RESULT_UNCERTAIN'
    });
  }
});
it('does not read back or replay a definitive permission/CAS refusal', async () => {
  rpc.mockResolvedValue({ data: null, error: new TeamApiError('LAUNCH_VERSION_CONFLICT', false) });
  await expect(launchAssignmentsApi.set(input)).rejects.toMatchObject({
    code: 'LAUNCH_VERSION_CONFLICT'
  });
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('refuses malformed authoritative reads rather than claiming free/unassigned', async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  await expect(launchAssignmentsApi.read('team', 'launch')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});
