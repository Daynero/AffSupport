import { expect, it, vi } from 'vitest';
import {
  claimRestitchExecutor,
  readRestitchExecutorClaim
} from '../supabase/functions/drive-ops/restitch-executor';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
const input = {
  rootOperationId: id(1),
  teamId: id(2),
  actorId: id(3),
  claimId: id(4),
  nativeInstanceId: id(5),
  installedContract: 1
};
const receipt = {
  rootOperationId: id(1),
  claimId: id(4),
  nativeInstanceId: id(5),
  executorId: id(6),
  epoch: 1,
  active: true
};
it('recovers a committed claim using exact readback with no second mutation', async () => {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'service_claim_restitch_executor') throw Error('PRIVATE_NETWORK_ERROR');
    return { data: receipt, error: null };
  });
  expect(await claimRestitchExecutor({ rpc }, input)).toEqual(receipt);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'service_claim_restitch_executor',
    'service_read_restitch_executor_claim'
  ]);
});
it.each([
  null,
  { ...receipt, claimId: id(8) },
  { ...receipt, epoch: '1' },
  { ...receipt, active: 'true' }
])('never treats a missing or malformed readback as a new executor %j', async value => {
  const rpc = vi.fn(async (name: string) => ({
    data: name === 'service_claim_restitch_executor' ? null : value,
    error: null
  }));
  await expect(claimRestitchExecutor({ rpc }, input)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});
it('retains historical inactive receipt evidence instead of reactivating it', async () => {
  const rpc = vi.fn(async () => ({ data: { ...receipt, active: false }, error: null }));
  expect(await readRestitchExecutorClaim({ rpc }, input)).toEqual({ ...receipt, active: false });
  expect(rpc.mock.calls).toHaveLength(1);
});
it('rejects missing or substituted installed support before any service call', async () => {
  const rpc = vi.fn();
  await expect(
    claimRestitchExecutor({ rpc }, { ...input, installedContract: 0 })
  ).rejects.toMatchObject({ code: 'RESTITCH_CLIENT_OUTDATED' });
  expect(rpc).not.toHaveBeenCalled();
});
it('captures the original claim before deferred acknowledgement and readback', async () => {
  const mutable = { ...input };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'service_claim_restitch_executor') {
      mutable.actorId = id(8);
      mutable.claimId = id(9);
      await Promise.resolve();
      throw Error('LOST_ACK');
    }
    expect(args.p_actor).toBe(input.actorId);
    expect(args.p_claim).toBe(input.claimId);
    return { data: receipt, error: null };
  });
  expect(await claimRestitchExecutor({ rpc }, mutable)).toEqual(receipt);
});
