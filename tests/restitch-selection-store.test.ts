import { inspect, isDeepStrictEqual } from 'node:util';
import { expect, it, vi } from 'vitest';
import {
  createScreenSelectionBudget,
  selectScreenCandidate,
  settleScreenTransfer,
  type ScreenSelectionBudget
} from '@video-compressor/shared';
import { RestitchSelectionSlotStore } from '../supabase/functions/drive-ops/restitch-selection-store';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = { rootOperationId: id(1), teamId: id(2), actorId: id(3), slot: 'end' as const };
const version = id(4),
  request = id(5);
function fixture() {
  let state = selectScreenCandidate(createScreenSelectionBudget(), version, 4);
  const fault = {
    casLost: false,
    settleLost: false,
    readFails: false,
    revoked: false,
    foreign: false,
    invalid: false
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (
      name === 'service_read_restitch_selection_slot' ||
      name === 'service_read_active_restitch_selection_slot'
    ) {
      if (name === 'service_read_active_restitch_selection_slot' && fault.revoked)
        return { data: null, error: { message: 'PERMISSION_DENIED' } };
      if (fault.readFails) throw Error('SYNTHETIC_NETWORK');
      return {
        error: null,
        data: {
          ...scope,
          actorId: fault.foreign ? id(8) : scope.actorId,
          budget: fault.invalid ? null : structuredClone(state)
        }
      };
    }
    if (name === 'service_cas_restitch_selection_slot') {
      if (fault.revoked) return { data: null, error: { message: 'PERMISSION_DENIED' } };
      if (!isDeepStrictEqual(args.p_expected_budget, state)) return { error: null, data: false };
      state = structuredClone(args.p_next_budget) as ScreenSelectionBudget;
      if (fault.casLost) {
        fault.casLost = false;
        throw Error('SYNTHETIC_NETWORK');
      }
      return { error: null, data: true };
    }
    if (name === 'service_settle_restitch_selection_range') {
      const before = state.transfers.find(t => t.requestId === args.p_request);
      expect(before).toEqual(args.p_expected_reservation);
      state = settleScreenTransfer(
        state,
        String(args.p_request),
        args.p_measurement as { bytes: number; ioMs: number; complete: boolean }
      );
      if (fault.settleLost) {
        fault.settleLost = false;
        throw Error('SYNTHETIC_NETWORK');
      }
      return { error: null, data: true };
    }
    throw Error('Unexpected service method');
  });
  const service: ServiceRpcClient = { rpc };
  return {
    fault,
    rpc,
    service,
    store: () => new RestitchSelectionSlotStore(service, scope),
    state: () => structuredClone(state)
  };
}
it('never turns a lost reservation acknowledgement into dispatch or another mutation', async () => {
  const f = fixture();
  f.fault.casLost = true;
  await expect(f.store().reserve(version, request, 0, 0)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect((await f.store().reserve(version, request, 0, 0)).kind).toBe('readback');
  expect(f.state().transfers).toHaveLength(1);
  expect(
    f.rpc.mock.calls.filter(([name]) => name === 'service_cas_restitch_selection_slot')
  ).toHaveLength(1);
});
it('gives two overlapping same-ID callers at most one acknowledged dispatch', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.store().reserve(version, request, 0, 0),
    f.store().reserve(version, request, 0, 0)
  ]);
  expect(results.filter(r => r.status === 'fulfilled' && r.value.kind === 'dispatch')).toHaveLength(
    1
  );
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(f.state().transfers).toHaveLength(1);
  expect((await f.store().reserve(version, request, 0, 0)).kind).toBe('readback');
});
it('retains unknown accounting across a reconstructed store without another candidate or request', async () => {
  const f = fixture();
  await f.store().reserve(version, request, 0, 0);
  await expect(f.store().reserve(version, id(6), 0, 0)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  await expect(f.store().select(id(7), 4)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.state().transfers).toHaveLength(1);
  expect(f.state().candidates).toHaveLength(1);
});
it('confirms a lost settlement reply by exact read-only server measurement', async () => {
  const f = fixture();
  await f.store().reserve(version, request, 0, 0);
  f.fault.settleLost = true;
  await f.store().settle(request, { bytes: 4, ioMs: 7, complete: true });
  expect(f.state().transfers[0]?.settlement).toEqual({ bytes: 4, ioMs: 7, complete: true });
  expect(
    f.rpc.mock.calls.filter(([name]) => name === 'service_settle_restitch_selection_range')
  ).toHaveLength(1);
});
it('does not replace a conflicting confirmed measurement', async () => {
  const f = fixture();
  await f.store().reserve(version, request, 0, 0);
  await f.store().settle(request, { bytes: 2, ioMs: 7, complete: false });
  await expect(
    f.store().settle(request, { bytes: 3, ioMs: 7, complete: false })
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(f.state().transfers[0]?.settlement?.bytes).toBe(2);
});
it('does not clamp an observed provider overrun into a confirmed range', async () => {
  const f = fixture();
  await f.store().reserve(version, request, 0, 0);
  await expect(
    f.store().settle(request, { bytes: 5, ioMs: 7, complete: false })
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(f.state().transfers[0]?.settlement).toBeNull();
  expect(
    f.rpc.mock.calls.filter(([name]) => name === 'service_settle_restitch_selection_range')
  ).toHaveLength(0);
});
it.each(['foreign', 'invalid'] as const)(
  'never recreates a missing or foreign slot: %s',
  async fault => {
    const f = fixture();
    f.fault[fault] = true;
    await expect(f.store().reserve(version, request, 0, 0)).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
    expect(f.rpc).toHaveBeenCalledOnce();
  }
);
it('settles an issued range after access revocation but refuses another range', async () => {
  const f = fixture();
  await f.store().reserve(version, request, 0, 0);
  f.fault.revoked = true;
  await f.store().settle(request, { bytes: 2, ioMs: 7, complete: false });
  await expect(f.store().reserve(version, id(6), 0, 0)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  expect(f.state().transfers).toHaveLength(1);
});
it('does not reset partial-prefix retry consumption when the adapter is reconstructed', async () => {
  const f = fixture();
  for (const n of [5, 6, 7]) {
    await f.store().reserve(version, id(n), 0, 0);
    await f.store().settle(id(n), { bytes: 2, ioMs: 5, complete: false });
  }
  await expect(f.store().reserve(version, id(8), 0, 0)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_SELECTION_LIMIT'
  });
  expect(f.state().transfers).toHaveLength(3);
});
it('awaits raw lazy RPC thenables without requiring Promise.catch', async () => {
  const f = fixture();
  const raw: ServiceRpcClient = {
    rpc: (name, args) => {
      const result = f.rpc(name, args);
      return { then: result.then.bind(result) };
    }
  };
  expect(
    (await new RestitchSelectionSlotStore(raw, scope).reserve(version, request, 0, 0)).kind
  ).toBe('dispatch');
});
it('does not serialize a service client or its private transport fields', async () => {
  const f = fixture();
  const service = { ...f.service, credential: 'SYNTHETIC_PRIVATE_AUTHORITY' };
  const store = new RestitchSelectionSlotStore(service, scope);
  expect(inspect(store, { showHidden: true })).not.toContain('SYNTHETIC_PRIVATE_AUTHORITY');
  expect(JSON.stringify(store)).not.toContain('SYNTHETIC_PRIVATE_AUTHORITY');
});

it('confirms exact lost-ACK measurement regardless of its property insertion order', async () => {
  const f = fixture();
  await f.store().reserve(version, request, 0, 0);
  f.fault.settleLost = true;
  await expect(
    f.store().settle(request, { complete: false, ioMs: 7, bytes: 2 })
  ).resolves.toBeUndefined();
  expect(f.state().transfers[0]?.settlement).toEqual({ bytes: 2, ioMs: 7, complete: false });
  expect(
    f.rpc.mock.calls.filter(([name]) => name === 'service_settle_restitch_selection_range')
  ).toHaveLength(1);
});

it.each(['reserve', 'reacquire', 'refresh'] as const)(
  'refuses stale %s acquisition without spending the new attempt',
  async action => {
    const f = fixture();
    const store = f.store();
    await store.reserve(version, request, 0, 0);
    await store.settle(request, { bytes: 2, ioMs: 5, complete: false });
    await store.reacquire(version, 0);
    if (action === 'reacquire') {
      await store.reserve(version, id(6), 0, 1);
      await store.settle(id(6), { bytes: 2, ioMs: 5, complete: false });
    }
    const before = f.state();
    const pending =
      action === 'reserve'
        ? store.reserve(version, id(7), 0, 0)
        : action === 'reacquire'
          ? store.reacquire(version, 0)
          : store.refresh(version, id(8), 0);
    await expect(pending).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { budget_reason: 'acquisition_mismatch' }
    });
    expect(f.state()).toEqual(before);
  }
);
it('retains old-request readback only for its original acquisition', async () => {
  const f = fixture();
  const store = f.store();
  await store.reserve(version, request, 0, 0);
  await store.settle(request, { bytes: 2, ioMs: 5, complete: false });
  await store.reacquire(version, 0);
  expect((await store.reserve(version, request, 0, 0)).kind).toBe('readback');
  await expect(store.reserve(version, request, 0, 1)).rejects.toMatchObject({
    code: 'INVALID_INPUT'
  });
  expect(f.state().transfers).toHaveLength(1);
});
it.each([-1, 0.5, 3])(
  'refuses malformed expected acquisition %s before reading or spending',
  async acquisition => {
    const f = fixture();
    await expect(f.store().reserve(version, request, 0, acquisition)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.state().transfers).toHaveLength(0);
  }
);
