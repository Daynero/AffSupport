import { expect, it } from 'vitest';
import {
  decideCatalogVideoWrite,
  parseCatalogPublicationTarget,
  settleCatalogVideoPublication,
  type CatalogPublicationJob,
  type CatalogPublicationPolicy
} from '../packages/shared/src/team/catalog-publication-lifecycle';
const target = { kind: 'source' as const, materialId: 'source', sourceVersion: 'immutable-v1' };
const next = { kind: 'video_set' as const, videoSetId: 'set', recipeRevision: 2 };
const policy: CatalogPublicationPolicy = {
  mode: 'scheduled',
  revision: 2,
  dueAt: '2030-01-01T12:00:00Z',
  timeZone: 'UTC'
};
const active = { target, providerRevision: 'provider-v1', verifiedAt: '2029-01-01T00:00:00Z' };
const job: CatalogPublicationJob = {
  revision: 2,
  state: 'waiting',
  writerFence: null,
  target: next
};
const now = Date.parse(policy.dueAt);
it('keeps new catalog video cells empty before due and preserves a previously published source', () => {
  expect(
    decideCatalogVideoWrite({
      policy,
      job,
      active: null,
      serverNow: now - 1,
      targetAvailable: true
    })
  ).toEqual({ action: 'preserve_active', target: null });
  expect(
    decideCatalogVideoWrite({ policy, job, active, serverNow: now - 1, targetAvailable: true })
  ).toEqual({ action: 'preserve_active', target });
});
it('publishes at the exact server due instant only after target readiness', () => {
  expect(
    decideCatalogVideoWrite({ policy, job, active, serverNow: now, targetAvailable: true })
  ).toEqual({ action: 'reserve_publication', revision: 2, target: next });
  expect(
    decideCatalogVideoWrite({ policy, job, active, serverNow: now, targetAvailable: false })
  ).toEqual({ action: 'blocked', reason: 'target_unavailable' });
});
it.each(['applying', 'verifying', 'unknown', 'cancel_requested'] as const)(
  'reconciles %s even after cancellation holds the policy',
  state => {
    expect(
      decideCatalogVideoWrite({
        policy: { mode: 'held', revision: 2 },
        job: { ...job, state },
        active,
        serverNow: now,
        targetAvailable: true
      })
    ).toEqual({ action: 'reconcile', revision: 2 });
  }
);
it('consumes a published one-shot job instead of publishing again on the next tick', () => {
  expect(
    decideCatalogVideoWrite({
      policy,
      job: { ...job, state: 'published' },
      active,
      serverNow: now + 1,
      targetAvailable: true
    })
  ).toEqual({ action: 'preserve_active', target });
});
it('rejects stale revisions and does not reinterpret unavailable server time', () => {
  expect(
    decideCatalogVideoWrite({
      policy,
      job: { ...job, revision: 1 },
      active,
      serverNow: now,
      targetAvailable: true
    })
  ).toEqual({ action: 'blocked', reason: 'stale_job' });
  expect(
    decideCatalogVideoWrite({ policy, job, active, serverNow: NaN, targetAvailable: true })
  ).toEqual({ action: 'blocked', reason: 'clock_unavailable' });
});
it('keeps active delivery for unknown/failed writes and promotes only exact-fence verified settlement', () => {
  const input = {
    policy,
    job: { ...job, state: 'verifying' as const, writerFence: 'fence' },
    expectedRevision: 2,
    expectedFence: 'fence',
    active
  };
  expect(settleCatalogVideoPublication({ ...input, outcome: 'unknown' }).active).toEqual(active);
  expect(settleCatalogVideoPublication({ ...input, outcome: 'failed' }).active).toEqual(active);
  expect(() =>
    settleCatalogVideoPublication({
      ...input,
      expectedFence: 'stale',
      outcome: 'verified',
      providerRevision: 'v2',
      verifiedAt: policy.dueAt
    })
  ).toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(
    settleCatalogVideoPublication({
      ...input,
      outcome: 'verified',
      providerRevision: 'v2',
      verifiedAt: policy.dueAt
    })
  ).toEqual({
    job: { ...input.job, state: 'published' },
    active: { target: next, providerRevision: 'v2', verifiedAt: policy.dueAt }
  });
});

it('keeps an old dispatched owner in reconciliation after a newer policy is observed', () => {
  expect(
    decideCatalogVideoWrite({
      policy: { mode: 'held', revision: 3 },
      job: { ...job, state: 'unknown', writerFence: 'old' },
      active,
      serverNow: now,
      targetAvailable: true
    })
  ).toEqual({ action: 'reconcile', revision: 2 });
});

it('captures exclusive immutable source and generated targets at the boundary', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const raw = { kind: 'source', materialId: id, sourceVersion: 'v1' };
  const parsed = parseCatalogPublicationTarget(raw);
  raw.sourceVersion = 'v2';
  expect(parsed).toEqual({ kind: 'source', materialId: id, sourceVersion: 'v1' });
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(
    parseCatalogPublicationTarget({ kind: 'video_set', videoSetId: id, recipeRevision: 3 })
  ).toEqual({ kind: 'video_set', videoSetId: id, recipeRevision: 3 });
  for (const value of [
    null,
    { kind: 'source', materialId: id, sourceVersion: 'https://provider/private' },
    { kind: 'source', materialId: id, sourceVersion: 'v1', videoSetId: id },
    { kind: 'video_set', videoSetId: id, recipeRevision: 0 },
    { kind: 'video_set', videoSetId: id, recipeRevision: 1, materialId: id }
  ])
    expect(() => parseCatalogPublicationTarget(value)).toThrow('INVALID_INPUT');
});
