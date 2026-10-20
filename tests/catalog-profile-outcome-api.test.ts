import { afterEach, expect, it, vi } from 'vitest';
const rpc = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
afterEach(() => rpc.mockReset());
const profile = {
  catalog_material_id: 'catalog',
  refresh_images: true,
  refresh_texts: true,
  grow_products: false,
  random_link_variation: true,
  restitch: false,
  version: 1,
  updated_at: '2026-10-18T10:00:00Z'
};
it('retains partial outcome independently of the last verified full success', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: [
      {
        ...profile,
        last_result: 'partial',
        latest_attempt_at: '2026-10-18T10:00:00Z',
        last_successful_at: '2026-10-17T10:00:00Z'
      }
    ]
  });
  expect(await teamApi.listCatalogUpdateProfiles('team')).toEqual([
    expect.objectContaining({
      lastResult: 'partial',
      latestAttemptAt: '2026-10-18T10:00:00Z',
      lastSuccessfulAt: '2026-10-17T10:00:00Z'
    })
  ]);
});
it('distinguishes legacy missing evidence from known absence of attempts and success', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: [
      profile,
      { ...profile, last_result: null, latest_attempt_at: null, last_successful_at: null }
    ]
  });
  const [legacy, known] = await teamApi.listCatalogUpdateProfiles('team');
  expect(legacy.lastResult).toBeUndefined();
  expect(legacy.lastSuccessfulAt).toBeUndefined();
  expect(known.lastResult).toBeNull();
  expect(known.latestAttemptAt).toBeNull();
  expect(known.lastSuccessfulAt).toBeNull();
});
it('never turns invalid outcome evidence into success or a usable timestamp', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: [
      {
        ...profile,
        last_result: 'made-up-success',
        latest_attempt_at: 'invalid',
        last_successful_at: 123
      }
    ]
  });
  expect(await teamApi.listCatalogUpdateProfiles('team')).toEqual([
    expect.objectContaining({
      lastResult: 'unknown',
      latestAttemptAt: undefined,
      lastSuccessfulAt: undefined
    })
  ]);
});

it('retains the precise calendar schedule from the profile list and patch response', async () => {
  const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' };
  rpc.mockResolvedValue({ error: null, data: [{ ...profile, schedule }] });
  expect((await teamApi.listCatalogUpdateProfiles('team'))[0].schedule).toEqual(schedule);
  rpc.mockResolvedValue({
    error: null,
    data: {
      catalogId: 'catalog',
      refreshImages: true,
      refreshTexts: true,
      growProducts: false,
      randomLinkVariation: true,
      restitch: false,
      version: 2,
      updatedAt: profile.updated_at,
      schedule
    }
  });
  expect(
    (
      await teamApi.patchCatalogUpdateProfile('team', 'catalog', 1, {
        updateInterval: '1w',
        schedule
      })
    ).schedule
  ).toEqual(schedule);
});
