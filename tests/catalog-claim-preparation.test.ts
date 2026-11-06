import { expect, it, vi } from 'vitest';
import { prepareCatalogClaims } from '../supabase/functions/catalog-updater/claim-preparation';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

const bad = '47000000-0000-4000-8000-000000000101';
const good = '47000000-0000-4000-8000-000000000102';
const attempt = '47000000-0000-4000-8000-000000000103';
const row = (id: string) => ({ team_id: 'team', catalog_material_id: id, refresh_images: true });

it.each([true, false])(
  'a missing active image attempt cannot abort its healthy sibling (parked=%s)',
  async parked => {
    const call = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
      if (name === 'service_catalog_image_mode_v2') return 'v2';
      if (name === 'service_catalog_image_update_attempt_v2')
        return parameters.p_catalog === bad ? null : attempt;
      if (name === 'service_park_catalog_update_claim') return parked;
      throw new Error('Unexpected RPC');
    });
    const result = await prepareCatalogClaims([row(bad), row(good)], 'worker', call);
    expect(result).toEqual({
      rows: [{ ...row(good), image_attempt_id: attempt }],
      quarantined: parked ? 1 : 0,
      stale: parked ? 0 : 1
    });
    expect(call).toHaveBeenCalledWith('service_park_catalog_update_claim', {
      p_item: bad,
      p_worker: 'worker'
    });
    expect(call).not.toHaveBeenCalledWith(
      'service_park_catalog_update_claim',
      expect.objectContaining({ p_item: good })
    );
  }
);

it('keeps legacy claims unchanged without inventing an image-attempt identity', async () => {
  const call = vi.fn().mockResolvedValue('legacy');
  expect(await prepareCatalogClaims([row(good)], 'worker', call)).toEqual({
    rows: [row(good)],
    quarantined: 0,
    stale: 0
  });
  expect(call).toHaveBeenCalledTimes(1);
});

it('still refuses a malformed non-null authority payload instead of using legacy fallback', async () => {
  const call = vi.fn().mockResolvedValueOnce('v2').mockResolvedValueOnce({ attempt });
  await expect(prepareCatalogClaims([row(good)], 'worker', call)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
});

it('does not disguise a shared authority outage as a bad candidate or quarantine', async () => {
  const call = vi.fn().mockRejectedValue(new TeamFunctionError('DRIVE_UNAVAILABLE'));
  await expect(prepareCatalogClaims([row(good)], 'worker', call)).rejects.toMatchObject({
    code: 'DRIVE_UNAVAILABLE'
  });
  expect(call).toHaveBeenCalledTimes(1);
});
