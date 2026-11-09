import { describe, expect, it } from 'vitest';
import {
  isCatalogCreatedVideoProgress,
  isCatalogVideoPreparingResult
} from '../apps/web/src/api/catalog-video-creation';
const pending = {
  outcome: 'preparing_video',
  catalogIntentId: '11111111-1111-4111-8111-111111111111',
  videoSetId: '22222222-2222-4222-8222-222222222222',
  requestedCount: 5,
  registeredCount: 2,
  state: 'preparing'
};
describe('catalog creation pending response', () => {
  it('accepts bounded progress without treating it as a catalog', () => {
    expect(isCatalogVideoPreparingResult(pending)).toBe(true);
    expect(isCatalogVideoPreparingResult({ ...pending, state: 'unknown' })).toBe(true);
    expect(isCatalogVideoPreparingResult({ outcome: 'created', catalog: {} })).toBe(false);
  });
  it.each([
    { catalogIntentId: 'bad' },
    { videoSetId: null },
    { requestedCount: 0 },
    { requestedCount: 401 },
    { registeredCount: 6 },
    { registeredCount: -1 },
    { registeredCount: 1.5 },
    { state: 'succeeded' }
  ])('rejects malformed or impossible progress %j', patch => {
    expect(isCatalogVideoPreparingResult({ ...pending, ...patch })).toBe(false);
  });
});

it('keeps current generation progress distinct from the created table receipt', () => {
  const progress = {
    videoSetId: pending.videoSetId,
    requestedCount: 5,
    registeredCount: 2,
    state: 'preparing',
    catalogVideoCells: 'deferred_blank',
    providerCas: 'unsupported'
  };
  expect(isCatalogCreatedVideoProgress(progress)).toBe(true);
  expect(isCatalogCreatedVideoProgress({ ...progress, state: 'ready' })).toBe(false);
  expect(isCatalogCreatedVideoProgress({ ...progress, state: 'canceled' })).toBe(true);
  expect(isCatalogCreatedVideoProgress({ ...progress, registeredCount: 6 })).toBe(false);
});
