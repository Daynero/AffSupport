import { expect, it, vi } from 'vitest';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { consumeControlledRestitchScreenRange } from '../supabase/functions/drive-ops/restitch-controlled-range-dispatch';
const id = (n: number) => 'b1750000-0000-4000-8000-' + String(n).padStart(12, '0');
const ticket = 'b'.repeat(43);
function grant() {
  return {
    grantId: id(1),
    rootOperationId: id(2),
    teamId: id(3),
    actorId: id(4),
    slot: 'end',
    versionId: id(5),
    requestId: id(6),
    executorId: id(7),
    epoch: 1,
    nativeInstanceId: id(8),
    state: 'consumed',
    acquisition: 0,
    reservation: {
      requestId: id(6),
      candidateVersionId: id(5),
      acquisition: 0,
      offset: 0,
      bytesReserved: 4,
      ioMsReserved: 120000,
      retry: false,
      settlement: null
    }
  };
}
it('uses only the control-bound consume and current-authority seams with its own hidden server invocation', async () => {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockResolvedValueOnce({ data: { dispatch: true, grant: grant() }, error: null })
    .mockResolvedValueOnce({ data: { consumedByInvocation: true, grant: grant() }, error: null });
  const result = await consumeControlledRestitchScreenRange({ rpc }, ticket);
  await result.checkAuthority();
  expect(rpc.mock.calls.map(call => call[0])).toEqual([
    'service_consume_restitch_control_screen_range',
    'service_check_restitch_control_screen_range'
  ]);
  expect(rpc.mock.calls[1]![1]).toEqual({
    p_ticket_hash: rpc.mock.calls[0]![1].p_ticket_hash,
    p_dispatch: rpc.mock.calls[0]![1].p_dispatch
  });
  expect(JSON.stringify(result)).not.toContain(String(rpc.mock.calls[0]![1].p_dispatch));
  expect(JSON.stringify(rpc.mock.calls)).not.toContain(ticket);
});
it('recovers a lost consume reply by one exact bound read without issuing another consume', async () => {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockRejectedValueOnce(Error('PRIVATE'))
    .mockResolvedValueOnce({ data: { consumedByInvocation: true, grant: grant() }, error: null });
  expect(await consumeControlledRestitchScreenRange({ rpc }, ticket)).toMatchObject({
    requestId: id(6)
  });
  expect(rpc.mock.calls.map(call => call[0])).toEqual([
    'service_consume_restitch_control_screen_range',
    'service_read_restitch_control_screen_range_consumption'
  ]);
  expect(rpc.mock.calls[1]![1].p_dispatch).toBe(rpc.mock.calls[0]![1].p_dispatch);
});
it.each(['AUTH_REQUIRED', 'PERMISSION_DENIED', 'WRONG_STATE'] as const)(
  'preserves current %s without a legacy fallback',
  async code => {
    const rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValueOnce({ data: null, error: { message: code } });
    await expect(consumeControlledRestitchScreenRange({ rpc }, ticket)).rejects.toMatchObject({
      code
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  }
);
it('rechecks session authority before upstream I/O and refuses a stale acknowledgement', async () => {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockResolvedValueOnce({ data: { dispatch: true, grant: grant() }, error: null })
    .mockResolvedValueOnce({ data: null, error: { message: 'AUTH_REQUIRED' } });
  const result = await consumeControlledRestitchScreenRange({ rpc }, ticket);
  await expect(result.checkAuthority()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
});
it('refuses a substituted authority receipt and exposes no callable invocation or hash fields', async () => {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockResolvedValueOnce({ data: { dispatch: true, grant: grant() }, error: null })
    .mockResolvedValueOnce({
      data: { consumedByInvocation: true, grant: { ...grant(), requestId: id(99) } },
      error: null
    });
  const result = await consumeControlledRestitchScreenRange({ rpc }, ticket);
  await expect(result.checkAuthority()).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(Object.keys(result)).not.toContain('p_dispatch');
  expect(Object.keys(result)).not.toContain('p_ticket_hash');
  expect(Object.isFrozen(result.scope)).toBe(true);
  expect(Object.isFrozen(result.reservation)).toBe(true);
});

it.each(['grantId', 'nativeInstanceId'] as const)(
  'rejects a substituted %s even when the rest of the scope matches',
  async key => {
    const rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValueOnce({ data: { dispatch: true, grant: grant() }, error: null })
      .mockResolvedValueOnce({
        data: { consumedByInvocation: true, grant: { ...grant(), [key]: id(99) } },
        error: null
      });
    const result = await consumeControlledRestitchScreenRange({ rpc }, ticket);
    await expect(result.checkAuthority()).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
  }
);
