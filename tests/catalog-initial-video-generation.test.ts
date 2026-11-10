import { expect, it, vi } from 'vitest';
import {
  createCatalogInitialVideoPlan,
  prepareCatalogInitialVideo,
  CatalogVideoPreparationPending,
  type CatalogInitialVideoAuthority
} from '../supabase/functions/drive-ops/catalog-video-generation';
import { parseCreateProductCatalogRequest } from '../supabase/functions/drive-ops/product-catalog';
const body = {
  teamId: '77000000-0000-4000-8000-000000000001',
  videoMaterialId: '77000000-0000-4000-8000-000000000002',
  sourceLink: 'https://example.invalid',
  productCount: 3,
  idempotencyKey: 'initial-video-test'
};
const preferences = {
  catalogVideoProtocolVersion: 1 as const,
  restitchEnabled: true,
  videoVariationCount: 2,
  videoPublication: { mode: 'immediate' as const }
};
it('leaves omitted protocol legacy and refuses ambiguous or excessive N', () => {
  expect(parseCreateProductCatalogRequest(body).catalogVideoProtocolVersion).toBeUndefined();
  expect(() => parseCreateProductCatalogRequest({ ...body, restitchEnabled: true })).toThrow();
  expect(() =>
    parseCreateProductCatalogRequest({ ...body, ...preferences, videoVariationCount: 4 })
  ).toThrow();
  expect(parseCreateProductCatalogRequest({ ...body, ...preferences })).toMatchObject(preferences);
});
it('freezes stable children and row identities before reporting pending work', async () => {
  const plan = createCatalogInitialVideoPlan(preferences, 3, Date.parse('2030-01-01T00:00:00Z'));
  const authority: CatalogInitialVideoAuthority = {
    serverNow: vi.fn(),
    prepare: vi.fn(async () => ({ state: 'preparing' as const, registeredCount: 1 })),
    registerCreated: vi.fn()
  };
  await expect(
    prepareCatalogInitialVideo(authority, body.videoMaterialId, plan)
  ).rejects.toBeInstanceOf(CatalogVideoPreparationPending);
  expect(plan.childRequestIds).toHaveLength(2);
  expect(new Set(plan.recipeRowIds).size).toBe(3);
  expect(authority.prepare).toHaveBeenCalledWith({ intentId: body.videoMaterialId, plan });
});
it('reuses an accepted past due without calendar revalidation and writes blank independently of unfinished N', async () => {
  const plan = createCatalogInitialVideoPlan(preferences, 3, Date.parse('2030-01-01T00:00:00Z'));
  plan.preferences.videoPublication = {
    mode: 'scheduled',
    dueAt: '2020-01-01T10:00:00.000Z',
    localDateTime: '2020-01-01T10:00',
    resolvedOffset: '+00:00',
    timeZone: 'UTC'
  };
  const authority: CatalogInitialVideoAuthority = {
    serverNow: vi.fn(),
    prepare: vi.fn(async () => ({
      state: 'preparing' as const,
      registeredCount: 1
    })),
    registerCreated: vi.fn()
  };
  expect(await prepareCatalogInitialVideo(authority, body.videoMaterialId, plan)).toEqual({
    kind: 'deferred'
  });
  expect(authority.serverNow).not.toHaveBeenCalled();
});
it('promises the deferred link only on a stack whose targeted writer answers', async () => {
  // 1.4.1 stamped every scheduled creation "unsupported", so even a stack that
  // publishes the link told the person the storage could not update the sheet.
  const scheduled = {
    mode: 'scheduled' as const,
    dueAt: '2030-01-01T10:00:00.000Z',
    localDateTime: '2030-01-01T10:00',
    resolvedOffset: '+00:00',
    timeZone: 'UTC'
  };
  const observe = async (targetedWriterEnabled: boolean | undefined) => {
    const plan = createCatalogInitialVideoPlan(preferences, 3, Date.parse('2030-01-01T00:00:00Z'));
    plan.preferences.videoPublication = scheduled;
    const seen: unknown[] = [];
    const authority: CatalogInitialVideoAuthority = {
      ...(targetedWriterEnabled === undefined ? {} : { targetedWriterEnabled }),
      serverNow: vi.fn(),
      prepare: vi.fn(async () => ({ state: 'preparing' as const, registeredCount: 1 })),
      registerCreated: vi.fn()
    };
    await prepareCatalogInitialVideo(authority, body.videoMaterialId, plan, p => seen.push(p));
    return seen[0] as Record<string, unknown>;
  };
  expect(await observe(true)).toMatchObject({
    catalogVideoCells: 'deferred_blank',
    publicationHeld: false
  });
  expect(await observe(true)).not.toHaveProperty('providerCas');
  expect(await observe(false)).toMatchObject({ providerCas: 'unsupported' });
  expect(await observe(undefined)).toMatchObject({ providerCas: 'unsupported' });
});
