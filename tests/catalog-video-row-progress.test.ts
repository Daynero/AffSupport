import { expect, it } from 'vitest';
import { parseCatalogVideoRowProgress } from '../apps/web/src/api/catalog-video-row-progress';

const progress = {
  setId: '11111111-1111-4111-8111-111111111111',
  requestedCount: 5,
  registeredCount: 2,
  state: 'preparing'
};

it('accepts bounded registered output progress without treating it as delivery', () => {
  expect(parseCatalogVideoRowProgress({ ...progress, providerPayload: 'private' })).toEqual(
    progress
  );
  expect(parseCatalogVideoRowProgress({ ...progress, state: 'ready' })).toBeNull();
  expect(
    parseCatalogVideoRowProgress({ ...progress, state: 'ready', registeredCount: 5 })
  ).toMatchObject({ state: 'ready', registeredCount: 5 });
});

it('rejects malformed counts and child identities rather than inventing progress', () => {
  for (const patch of [
    { requestedCount: 401 },
    { requestedCount: 0 },
    { registeredCount: -1 },
    { registeredCount: 6 },
    { registeredCount: 2.5 },
    { state: 'published' },
    { activeChildOperationId: 'unknown' },
    { setId: 'missing' }
  ])
    expect(parseCatalogVideoRowProgress({ ...progress, ...patch })).toBeNull();
});

it('keeps a wait reason, known or newer, and drops only a malformed one (072)', () => {
  expect(
    parseCatalogVideoRowProgress({
      ...progress,
      registeredCount: 0,
      state: 'accepted',
      waitReason: 'AGENT_REQUIRED'
    })
  ).toMatchObject({ state: 'accepted', waitReason: 'AGENT_REQUIRED' });
  // A code a newer server adds must not take the row's whole progress with it.
  expect(parseCatalogVideoRowProgress({ ...progress, waitReason: 'SOMETHING_ELSE' })).toMatchObject(
    { waitReason: 'SOMETHING_ELSE' }
  );
  expect(
    parseCatalogVideoRowProgress({
      ...progress,
      waitReason: 'not a code',
      waitCode: 'AGENT_STALLED'
    })
  ).toMatchObject({ setId: progress.setId, waitCode: 'AGENT_STALLED' });
  expect(
    parseCatalogVideoRowProgress({ ...progress, waitReason: 'not a code' })
  ).not.toHaveProperty('waitReason');
  expect(parseCatalogVideoRowProgress(progress)).not.toHaveProperty('waitReason');
});

it('keeps an R2 Launch’s sets for the page that hands them over, dropping malformed ones (057 T119)', () => {
  const sets = [
    { setId: progress.setId, requestedCount: 3, registeredCount: 1 },
    { setId: '22222222-2222-4222-8222-222222222222', requestedCount: 2, registeredCount: 1 }
  ];
  expect(parseCatalogVideoRowProgress({ ...progress, spaceSets: sets })).toEqual({
    ...progress,
    spaceSets: sets
  });
  for (const spaceSets of [
    [],
    [{ ...sets[0], setId: 'x' }],
    [{ ...sets[0], registeredCount: 4 }],
    'x'
  ])
    expect(parseCatalogVideoRowProgress({ ...progress, spaceSets })).toEqual(progress);
  // A Drive generation's segments are not sets to hand over.
  expect(parseCatalogVideoRowProgress({ ...progress, segments: sets })).toEqual(progress);
});
