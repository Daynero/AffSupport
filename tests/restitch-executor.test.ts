import { expect, it, vi } from 'vitest';
import {
  claimRestitchExecutor,
  readRestitchExecutorClaim,
  quiesceRestitchExecutor
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

it('recovers a transport failure returned as an RPC error value after commit', async () => {
  const rpc = vi.fn(async (name: string) =>
    name === 'service_claim_restitch_executor'
      ? { data: null, error: { message: 'Failed to fetch' } }
      : { data: receipt, error: null }
  );
  expect(await claimRestitchExecutor({ rpc }, input)).toEqual(receipt);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'service_claim_restitch_executor',
    'service_read_restitch_executor_claim'
  ]);
});
it('retains an unknown returned-error claim when exact readback is absent', async () => {
  const rpc = vi.fn(async (name: string) => ({
    data: null,
    error:
      name === 'service_claim_restitch_executor' ? { message: 'private transport detail' } : null
  }));
  await expect(claimRestitchExecutor({ rpc }, input)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});
it.each(['PERMISSION_DENIED', 'SOURCE_CHANGED', 'RESTITCH_CLIENT_OUTDATED'])(
  'preserves a proven %s claim refusal without a recovery mutation or read',
  async code => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: code } }));
    await expect(claimRestitchExecutor({ rpc }, input)).rejects.toMatchObject({ code });
    expect(rpc).toHaveBeenCalledOnce();
  }
);

const closure = { ...input, executorId: id(6), epoch: 1, quiescenceId: id(10) };
it('closes only the original claim receipt and nonce after the native owner has joined activity', async () => {
  const rpc = vi.fn(async (name: string) => ({
    data: name === 'service_read_restitch_executor_claim' ? receipt : true,
    error: null
  }));
  expect(await quiesceRestitchExecutor({ rpc }, closure)).toBe(true);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'service_read_restitch_executor_claim',
    'service_quiesce_restitch_executor'
  ]);
  expect(rpc.mock.calls[1]).toEqual([
    'service_quiesce_restitch_executor',
    {
      p_root_operation: input.rootOperationId,
      p_team: input.teamId,
      p_actor: input.actorId,
      p_executor: id(6),
      p_epoch: 1,
      p_quiescence: id(10)
    }
  ]);
});
it.each([null, { ...receipt, executorId: id(80) }, { ...receipt, epoch: 2 }])(
  'refuses missing/substituted closure ownership %j before a close mutation',
  async value => {
    const rpc = vi.fn(async () => ({ data: value, error: null }));
    await expect(quiesceRestitchExecutor({ rpc }, closure)).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
    expect(rpc).toHaveBeenCalledOnce();
  }
);
it.each([false, null, 'true', { closed: true }])(
  'never turns ambiguous close response %j into acknowledged quiescence',
  async value => {
    const rpc = vi.fn(async (name: string) => ({
      data: name === 'service_read_restitch_executor_claim' ? receipt : value,
      error: null
    }));
    await expect(quiesceRestitchExecutor({ rpc }, closure)).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  }
);
it('retains a lost closure acknowledgement without replaying its mutation or claiming another owner', async () => {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'service_quiesce_restitch_executor') throw Error('private payload');
    return { data: receipt, error: null };
  });
  await expect(quiesceRestitchExecutor({ rpc }, closure)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});
it('captures closure identity before a deferred claim read', async () => {
  const mutable = { ...closure };
  const rpc = vi.fn(async (name: string) => {
    if (name === 'service_read_restitch_executor_claim') {
      mutable.actorId = id(70);
      mutable.executorId = id(71);
      mutable.quiescenceId = id(72);
      return { data: receipt, error: null };
    }
    return { data: true, error: null };
  });
  expect(await quiesceRestitchExecutor({ rpc }, mutable)).toBe(true);
  expect(rpc.mock.calls[1]).toEqual([
    'service_quiesce_restitch_executor',
    {
      p_root_operation: input.rootOperationId,
      p_team: input.teamId,
      p_actor: input.actorId,
      p_executor: closure.executorId,
      p_epoch: closure.epoch,
      p_quiescence: closure.quiescenceId
    }
  ]);
});
it.each([
  { epoch: 0 },
  { epoch: Number.MAX_SAFE_INTEGER + 1 },
  { executorId: 'private-path' },
  { quiescenceId: 'private-url' }
])('refuses invalid native closure fields before service access %j', async invalid => {
  const rpc = vi.fn();
  await expect(quiesceRestitchExecutor({ rpc }, { ...closure, ...invalid })).rejects.toMatchObject({
    code: 'INVALID_INPUT'
  });
  expect(rpc).not.toHaveBeenCalled();
});
