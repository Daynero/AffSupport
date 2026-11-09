import { expect, it, vi } from 'vitest';
import {
  createScreenSelectionBudget,
  selectScreenCandidate,
  reserveScreenTransfer
} from '../packages/shared/src/team/restitch-selection';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { issueRestitchScreenRange } from '../supabase/functions/drive-ops/restitch-range-issue';
const id = (n: number) => 'b1621000-0000-4000-8000-' + String(n).padStart(12, '0');
const secret = 'synthetic-secret-'.repeat(3);
function fixture() {
  const input = {
    scope: {
      rootOperationId: id(1),
      teamId: id(2),
      actorId: id(3),
      slot: 'end' as const,
      executor: { id: id(4), epoch: 1 }
    },
    nativeInstanceId: id(5),
    versionId: id(6),
    acquisition: 0,
    requestId: id(7),
    grantId: id(8),
    offset: 0
  };
  const before = selectScreenCandidate(createScreenSelectionBudget(), input.versionId, 4);
  const next = reserveScreenTransfer(before, input.versionId, input.requestId, 0);
  const row = {
    grantId: input.grantId,
    rootOperationId: input.scope.rootOperationId,
    teamId: input.scope.teamId,
    actorId: input.scope.actorId,
    slot: 'end',
    executorId: input.scope.executor.id,
    epoch: 1,
    nativeInstanceId: input.nativeInstanceId,
    requestId: input.requestId,
    versionId: input.versionId,
    acquisition: 0,
    state: 'issued',
    expiresAt: '2026-12-08T00:00:00Z',
    reservation: next.reservation
  };
  const budget = {
    rootOperationId: input.scope.rootOperationId,
    teamId: input.scope.teamId,
    actorId: input.scope.actorId,
    slot: 'end',
    budget: before
  };
  return { input, before, next, row, budget };
}
it('returns a ticket only after atomic original reservation and authority acknowledgement', async () => {
  const f = fixture(),
    rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: f.budget, error: null })
      .mockResolvedValueOnce({ data: f.row, error: null });
  const result = await issueRestitchScreenRange({ rpc }, secret, f.input);
  expect(result.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(result.reservation).toEqual(f.next.reservation);
  expect(rpc.mock.calls.map(c => c[0])).toEqual([
    'service_read_restitch_screen_range_issue',
    'service_read_restitch_selection_slot',
    'service_issue_restitch_screen_range'
  ]);
  expect(rpc.mock.calls[2]![1]).toMatchObject({
    p_expected_budget: f.before,
    p_next_budget: f.next.state,
    p_ticket_hash: expect.stringMatching(/^\\x[0-9a-f]{64}$/u)
  });
  expect(JSON.stringify(rpc.mock.calls)).not.toContain(result.ticket);
});
it.each(['throw', 'returned', 'malformed'] as const)(
  'resolves a %s issue acknowledgement only by reading the same IDs',
  async mode => {
    const f = fixture(),
      rpc = vi
        .fn<ServiceRpcClient['rpc']>()
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: f.budget, error: null })
        .mockImplementationOnce(async () => {
          if (mode === 'throw') throw Error('PRIVATE');
          return mode === 'returned'
            ? { data: null, error: { message: 'Failed to fetch PRIVATE' } }
            : { data: { invalid: true }, error: null };
        })
        .mockResolvedValueOnce({ data: f.row, error: null });
    await expect(issueRestitchScreenRange({ rpc }, secret, f.input)).resolves.toMatchObject({
      reservation: f.next.reservation
    });
    expect(
      rpc.mock.calls.map(c => c[0]).filter(n => n === 'service_issue_restitch_screen_range')
    ).toHaveLength(1);
    expect(rpc.mock.calls.at(-1)?.[1]).toEqual(rpc.mock.calls[0]![1]);
  }
);
it('does not create a fresh grant or reservation after an unproved issue outcome', async () => {
  const f = fixture(),
    rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: f.budget, error: null })
      .mockRejectedValueOnce(Error('PRIVATE'))
      .mockResolvedValueOnce({ data: null, error: null });
  await expect(issueRestitchScreenRange({ rpc }, secret, f.input)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(4);
  expect(rpc.mock.calls.filter(c => c[0] === 'service_issue_restitch_screen_range')).toHaveLength(
    1
  );
});
it('reconstructs an original acknowledged ticket without reserving or issuing again', async () => {
  const f = fixture(),
    rpc = vi.fn<ServiceRpcClient['rpc']>().mockResolvedValue({ data: f.row, error: null });
  const first = await issueRestitchScreenRange({ rpc }, secret, f.input),
    second = await issueRestitchScreenRange({ rpc }, secret, f.input);
  expect(first).toEqual(second);
  expect(rpc.mock.calls.every(c => c[0] === 'service_read_restitch_screen_range_issue')).toBe(true);
});
it.each([
  { actorId: id(9) },
  { executorId: id(9) },
  { nativeInstanceId: id(9) },
  { state: 'consumed' },
  { state: 'abandoned' }
])('refuses substituted or previously used historical authority %j', async change => {
  const f = fixture(),
    rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValue({ data: { ...f.row, ...change }, error: null });
  await expect(issueRestitchScreenRange({ rpc }, secret, f.input)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('captures the original scope and request before the first awaited read', async () => {
  const f = fixture(),
    original = structuredClone(f.input),
    rpc = vi.fn<ServiceRpcClient['rpc']>().mockImplementationOnce(async () => {
      f.input.scope.actorId = id(9);
      f.input.scope.executor.id = id(9);
      f.input.requestId = id(9);
      return { data: f.row, error: null };
    });
  await expect(issueRestitchScreenRange({ rpc }, secret, f.input)).resolves.toMatchObject({
    reservation: f.next.reservation
  });
  expect(rpc.mock.calls[0]![1]).toMatchObject({
    p_actor: original.scope.actorId,
    p_executor: original.scope.executor.id,
    p_request: original.requestId
  });
});
it('does not treat an already recorded bare reservation as permission to issue a new ticket', async () => {
  const f = fixture(),
    rpc = vi
      .fn<ServiceRpcClient['rpc']>()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { ...f.budget, budget: f.next.state }, error: null });
  await expect(issueRestitchScreenRange({ rpc }, secret, f.input)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});
