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

it('keeps a known wait reason for an accepted round and rejects an unknown one', () => {
  expect(
    parseCatalogVideoRowProgress({
      ...progress,
      registeredCount: 0,
      state: 'accepted',
      waitReason: 'AGENT_REQUIRED'
    })
  ).toMatchObject({ state: 'accepted', waitReason: 'AGENT_REQUIRED' });
  expect(parseCatalogVideoRowProgress({ ...progress, waitReason: 'SOMETHING_ELSE' })).toBeNull();
  expect(parseCatalogVideoRowProgress(progress)).not.toHaveProperty('waitReason');
});
