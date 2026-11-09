import { expect, it, vi } from 'vitest';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import {
  consumeRestitchScreenRange,
  dispatchRestitchScreenRange
} from '../supabase/functions/drive-ops/restitch-range-dispatch';
const id = (n: number) => 'b1620000-0000-4000-8000-' + String(n).padStart(12, '0');
const ticket = 'a'.repeat(43);
const grant = () => ({
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
  reservation: {
    requestId: id(6),
    candidateVersionId: id(5),
    acquisition: 0,
    offset: 0,
    bytesReserved: 4,
    ioMsReserved: 120000,
    retry: false,
    settlement: null
  },
  acquisition: 0
});
it('consumes only once, with a fresh server nonce and a hashed purpose-bound ticket', async () => {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockResolvedValueOnce({ data: { dispatch: true, grant: grant() }, error: null })
    .mockResolvedValueOnce({ data: { dispatch: false, grant: grant() }, error: null });
  expect(await consumeRestitchScreenRange({ rpc }, ticket)).toMatchObject({
    requestId: id(6),
    scope: { executor: { id: id(7), epoch: 1 } }
  });
  await expect(consumeRestitchScreenRange({ rpc }, ticket)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(2);
  const first = rpc.mock.calls[0]!,
    second = rpc.mock.calls[1]!;
  expect(first[0]).toBe('service_consume_restitch_screen_range');
  expect(first[1]).toMatchObject({
    p_purpose: 'restitch_screen_range_v1',
    p_ticket_hash: expect.stringMatching(/^\\x[0-9a-f]{64}$/u),
    p_dispatch: expect.any(String)
  });
  expect(first[1]?.p_dispatch).not.toBe(second[1]?.p_dispatch);
  expect(JSON.stringify(rpc.mock.calls)).not.toContain(ticket);
});
it.each(['throw', 'returned'] as const)(
  'recovers only its exact consumption after %s ACK loss without a second mutation',
  async mode => {
    const rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockImplementationOnce(async () => {
        if (mode === 'throw') throw Error('PRIVATE_PAYLOAD');
        return { data: null, error: { message: 'Failed to fetch PRIVATE_PAYLOAD' } };
      })
      .mockResolvedValueOnce({ data: { consumedByInvocation: true, grant: grant() }, error: null });
    await expect(consumeRestitchScreenRange({ rpc }, ticket)).resolves.toMatchObject({
      requestId: id(6)
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual([
      'service_read_restitch_screen_range_consumption',
      {
        p_ticket_hash: rpc.mock.calls[0]![1]?.p_ticket_hash,
        p_dispatch: rpc.mock.calls[0]![1]?.p_dispatch
      }
    ]);
  }
);
it.each([false, null, 'true'])(
  'does not borrow another invocation after unknown consumption %j',
  async consumedByInvocation => {
    const rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockRejectedValueOnce(Error('PRIVATE_PAYLOAD'))
      .mockResolvedValueOnce({ data: { consumedByInvocation, grant: grant() }, error: null });
    const readCredentials = vi.fn(),
      fetcher = vi.fn<typeof fetch>();
    await expect(
      dispatchRestitchScreenRange({ service: { rpc }, ticket }, { readCredentials, fetch: fetcher })
    ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
    expect(readCredentials).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
  }
);
it.each(['PERMISSION_DENIED', 'EXPIRED'] as const)(
  'keeps known %s separate without reading back or leaking provider text',
  async code => {
    const rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValue({ data: null, error: { message: code + ' PRIVATE_PAYLOAD' } });
    await expect(consumeRestitchScreenRange({ rpc }, ticket)).rejects.toMatchObject({
      code,
      message: code
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  }
);
it.each([
  null,
  { ...grant(), actorId: 'private' },
  { ...grant(), state: 'issued' },
  { ...grant(), epoch: '1' },
  { ...grant(), slot: { toString: (): string => 'end' } },
  {
    ...grant(),
    reservation: { ...grant().reservation, settlement: { bytes: 0, ioMs: 0, complete: false } }
  }
])('refuses malformed consumption before source credentials or any I/O %j', async value => {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockResolvedValue({ data: { dispatch: true, grant: value }, error: null });
  const readCredentials = vi.fn(),
    fetcher = vi.fn<typeof fetch>();
  await expect(
    dispatchRestitchScreenRange({ service: { rpc }, ticket }, { readCredentials, fetch: fetcher })
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(readCredentials).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('rechecks frozen source authority after consumption and never reserves another range', async () => {
  const rpc = vi
    .fn<ServiceRpcClient['rpc']>()
    .mockResolvedValueOnce({ data: { dispatch: true, grant: grant() }, error: null })
    .mockResolvedValueOnce({ data: null, error: { message: 'WRONG_STATE' } });
  const readCredentials = vi.fn(),
    fetcher = vi.fn<typeof fetch>();
  await expect(
    dispatchRestitchScreenRange({ service: { rpc }, ticket }, { readCredentials, fetch: fetcher })
  ).rejects.toMatchObject({ code: 'WRONG_STATE' });
  expect(rpc.mock.calls.map(c => c[0])).toEqual([
    'service_consume_restitch_screen_range',
    'service_read_restitch_selection_source_owned'
  ]);
  expect(readCredentials).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not consume a ticket for an already-canceled invocation', async () => {
  const rpc = vi.fn<ServiceRpcClient['rpc']>(),
    controller = new AbortController();
  controller.abort();
  await expect(
    dispatchRestitchScreenRange(
      { service: { rpc }, ticket, signal: controller.signal },
      { readCredentials: vi.fn(), fetch: vi.fn() }
    )
  ).rejects.toMatchObject({ code: 'PROCESS_CANCELED' });
  expect(rpc).not.toHaveBeenCalled();
});

it('captures the consumed reservation instead of retaining the mutable RPC response', async () => {
  const value = grant(),
    rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValue({ data: { dispatch: true, grant: value }, error: null });
  const result = await consumeRestitchScreenRange({ rpc }, ticket);
  value.reservation.offset = 2;
  value.reservation.bytesReserved = 2;
  value.executorId = id(9);
  expect(result).toMatchObject({
    reservation: { offset: 0, bytesReserved: 4 },
    scope: { executor: { id: id(7), epoch: 1 } }
  });
});
