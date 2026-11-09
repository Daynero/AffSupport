import { expect, it, vi } from 'vitest';
import {
  runCatalogPublicationTick,
  type CatalogPublicationAuthority,
  type CatalogDuePublication
} from '../packages/shared/src/team/catalog-publication-runner';
const due = Date.parse('2030-01-01T12:00:00Z');
const item: CatalogDuePublication = {
  catalogId: 'catalog',
  policy: { mode: 'scheduled', revision: 1, dueAt: new Date(due).toISOString(), timeZone: 'UTC' },
  job: {
    revision: 1,
    state: 'waiting',
    writerFence: null,
    target: { kind: 'source', materialId: 'source', sourceVersion: 'v1' }
  },
  active: null
};
function setup(items: readonly CatalogDuePublication[] = [item]) {
  const a = {
    claim: vi.fn(async () => items),
    now: () => due,
    availability: vi.fn(async (): Promise<'ready' | 'waiting' | 'blocked'> => 'ready'),
    wait: vi.fn(async () => {}),
    reserve: vi.fn(async () => ({ writerFence: 'fence' })),
    dispatch: vi.fn(async () => {}),
    apply: vi.fn(async () => {}),
    verify: vi.fn(async () => ({
      outcome: 'verified' as const,
      providerRevision: 'v2',
      verifiedAt: new Date(due).toISOString()
    })),
    settle: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    blocked: vi.fn(async () => {})
  };
  return a satisfies CatalogPublicationAuthority;
}
it('publishes an original-source target without requiring a fake generated child', async () => {
  const a = setup();
  expect(await runCatalogPublicationTick(a)).toEqual({
    claimed: 1,
    verified: 1,
    preserved: 0,
    waiting: 0,
    blocked: 0,
    uncertain: 0
  });
  expect(a.availability).toHaveBeenCalledTimes(2);
  expect(a.settle).toHaveBeenCalledWith(
    item,
    'fence',
    expect.objectContaining({ outcome: 'verified' })
  );
});
it('does not dispatch before due, while held, or while a previous write is unknown', async () => {
  const a = setup();
  a.now = () => due - 1;
  await runCatalogPublicationTick(a);
  expect(a.reserve).not.toHaveBeenCalled();
  const held = setup([{ ...item, policy: { mode: 'held', revision: 1 } }]);
  await runCatalogPublicationTick(held);
  expect(held.apply).not.toHaveBeenCalled();
  const unknown = setup([{ ...item, job: { ...item.job, state: 'unknown', writerFence: 'old' } }]);
  await runCatalogPublicationTick(unknown);
  expect(unknown.reconcile).toHaveBeenCalledOnce();
  expect(unknown.apply).not.toHaveBeenCalled();
});
it('verifies a lost apply reply without applying a second time', async () => {
  const a = setup();
  a.apply.mockRejectedValueOnce(Error('lost reply'));
  expect((await runCatalogPublicationTick(a)).verified).toBe(1);
  expect(a.apply).toHaveBeenCalledOnce();
  expect(a.verify).toHaveBeenCalledOnce();
});
it('refuses a target revoked between reservation and dispatch', async () => {
  const a = setup();
  a.availability.mockResolvedValueOnce('ready').mockResolvedValueOnce('blocked');
  expect((await runCatalogPublicationTick(a)).blocked).toBe(1);
  expect(a.dispatch).not.toHaveBeenCalled();
  expect(a.apply).not.toHaveBeenCalled();
});
it('does not dispatch when reservation acknowledgement is missing', async () => {
  const a = setup();
  a.reserve.mockRejectedValueOnce(Error('lost acknowledgement'));
  expect((await runCatalogPublicationTick(a)).uncertain).toBe(1);
  expect(a.dispatch).not.toHaveBeenCalled();
});
it('isolates a failed job so a healthy sibling still settles', async () => {
  const a = setup([item, { ...item, catalogId: 'second' }]);
  a.availability.mockRejectedValueOnce(Error('unavailable'));
  expect(await runCatalogPublicationTick(a)).toMatchObject({
    claimed: 2,
    verified: 1,
    uncertain: 1
  });
  expect(a.apply).toHaveBeenCalledOnce();
});
it('rejects an oversized claim instead of dispatching unbounded background work', async () => {
  const a = setup([item, { ...item, catalogId: 'second' }]);
  await expect(runCatalogPublicationTick(a, 1)).rejects.toThrow('INVALID_RESPONSE');
  expect(a.apply).not.toHaveBeenCalled();
});

it('refuses duplicate catalog claims before any side effects', async () => {
  const a = setup([item, item]);
  await expect(runCatalogPublicationTick(a, 2)).rejects.toThrow('INVALID_RESPONSE');
  expect(a.reserve).not.toHaveBeenCalled();
});

it('keeps incomplete variants waiting instead of reporting access failure', async () => {
  const a = setup();
  a.availability.mockResolvedValueOnce('waiting');
  expect((await runCatalogPublicationTick(a)).waiting).toBe(1);
  expect(a.wait).toHaveBeenCalledWith(item);
  expect(a.blocked).not.toHaveBeenCalled();
  expect(a.reserve).not.toHaveBeenCalled();
});

it('captures reservation ownership before revalidation can mutate the reply', async () => {
  const a = setup(),
    reservation = { writerFence: 'original' };
  a.reserve.mockResolvedValueOnce(reservation);
  a.availability.mockImplementation(async () => {
    if (a.availability.mock.calls.length === 2) reservation.writerFence = 'replacement';
    return 'ready';
  });
  await runCatalogPublicationTick(a);
  expect(a.apply).toHaveBeenCalledWith(item, 'original');
  expect(a.settle).toHaveBeenCalledWith(item, 'original', expect.anything());
});
it('refuses a malformed reservation before any dispatch', async () => {
  const a = setup();
  a.reserve.mockResolvedValueOnce({ writerFence: '' });
  expect((await runCatalogPublicationTick(a)).uncertain).toBe(1);
  expect(a.apply).not.toHaveBeenCalled();
});
it('counts waiting, blocked, refused reservations and readiness lost before dispatch', async () => {
  const waiting = setup();
  waiting.availability.mockResolvedValueOnce('waiting');
  expect(await runCatalogPublicationTick(waiting)).toMatchObject({ waiting: 1 });
  expect(waiting.wait).toHaveBeenCalledWith(item);
  const blocked = setup();
  blocked.availability.mockResolvedValueOnce('blocked');
  expect(await runCatalogPublicationTick(blocked)).toMatchObject({ blocked: 1 });
  expect(blocked.blocked).toHaveBeenCalledWith(item, 'target_unavailable');
  const refused = setup();
  refused.reserve.mockResolvedValueOnce(null as never);
  expect(await runCatalogPublicationTick(refused)).toMatchObject({ uncertain: 1 });
  expect(refused.dispatch).not.toHaveBeenCalled();
  const lateWait = setup();
  lateWait.availability.mockResolvedValueOnce('ready').mockResolvedValueOnce('waiting');
  expect(await runCatalogPublicationTick(lateWait)).toMatchObject({ waiting: 1 });
  expect(lateWait.wait).toHaveBeenCalledWith(item, 'fence');
  expect(lateWait.dispatch).not.toHaveBeenCalled();
  const lateBlock = setup();
  lateBlock.availability.mockResolvedValueOnce('ready').mockResolvedValueOnce('blocked');
  expect(await runCatalogPublicationTick(lateBlock)).toMatchObject({ blocked: 1 });
  expect(lateBlock.blocked).toHaveBeenCalledWith(item, 'target_unavailable', 'fence');
  const badFence = setup();
  badFence.reserve.mockResolvedValueOnce({ writerFence: '' });
  expect(await runCatalogPublicationTick(badFence)).toMatchObject({ uncertain: 1 });
});
it('settles an absent readback as not verified and counts it uncertain', async () => {
  const a = setup();
  a.verify.mockResolvedValueOnce({ outcome: 'absent' } as never);
  expect(await runCatalogPublicationTick(a)).toMatchObject({ verified: 0, uncertain: 1 });
  expect(a.settle).toHaveBeenCalledWith(item, 'fence', { outcome: 'absent' });
});
it('refuses an invalid limit and an over-sized or duplicated claim', async () => {
  await expect(runCatalogPublicationTick(setup(), 0)).rejects.toThrow('INVALID_INPUT');
  await expect(runCatalogPublicationTick(setup([item, item]), 1)).rejects.toThrow(
    'INVALID_RESPONSE'
  );
  await expect(runCatalogPublicationTick(setup([item, item]), 3)).rejects.toThrow(
    'INVALID_RESPONSE'
  );
});
