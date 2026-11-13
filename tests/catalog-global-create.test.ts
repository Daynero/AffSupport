import { describe, it, expect } from 'vitest';
import {
  drawCatalogImagePool,
  assertCatalogImageContract
} from '../supabase/functions/_shared/catalog-image-draw.ts';
import {
  catalogImagesInRows,
  catalogImageUrl,
  legacyImage,
  parseCatalogDrawnImage,
  pairCatalogImageRow
} from '../supabase/functions/_shared/catalog-image-rows.ts';
import { globalImageFixture, globalFixtureId } from './fixtures/catalog-global.js';

describe('global producer boundary', () => {
  it('draws a complete batch in one call and retains global assignment facts', async () => {
    const image = globalImageFixture();
    const calls: string[] = [];
    const images = await drawCatalogImagePool(
      async (name, params) => {
        calls.push(name);
        expect(params.p_catalog).toBe(globalFixtureId(1));
        return Array(200).fill(image);
      },
      globalFixtureId(2),
      200,
      { contractVersion: 3, attemptId: globalFixtureId(3), catalogId: globalFixtureId(1) }
    );
    expect(calls).toEqual(['service_draw_product_catalog_images_v3']);
    expect(images).toHaveLength(200);
    expect(legacyImage(images[0]!)).toBe(false);
    expect(catalogImageUrl(images[0]!)).toBe(image.publicUrl);
    const row = pairCatalogImageRow(
      { title: 'Generic', description: 'Item', price: 10, imageLink: '' },
      image,
      { allowTextGeneration: true }
    );
    expect(catalogImagesInRows([row])).toEqual([image]);
    expect(parseCatalogDrawnImage(image)).toEqual(image);
  });
  it('requires the current client contract after activation', async () => {
    await expect(
      assertCatalogImageContract(async () => 'global', globalFixtureId(2), 2)
    ).rejects.toMatchObject({ code: 'GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED' });
    await expect(
      assertCatalogImageContract(async () => 'global', globalFixtureId(2), 3)
    ).resolves.toBeUndefined();
  });
  it('refuses truncated or malformed global recipes instead of publishing partial rows', async () => {
    await expect(
      drawCatalogImagePool(async () => [globalImageFixture()], globalFixtureId(2), 200, {
        contractVersion: 3
      })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
it('restricts frozen words to exact garment/color facts without inventing a bucket', async () => {
  const { catalogImageRequirements } =
    await import('../supabase/functions/_shared/catalog-image-rows.ts');
  expect(
    catalogImageRequirements({
      title: 'Black Hoodie',
      description: 'A black hoodie',
      price: 10,
      imageLink: ''
    })
  ).toEqual({ garment: 'Hoodie', color: 'black' });
  expect(
    catalogImageRequirements({
      title: 'Black Hoodie',
      description: 'A red blouse',
      price: 10,
      imageLink: ''
    })
  ).toEqual({ garment: null, color: null });
  expect(
    catalogImageRequirements({
      title: 'Custom name',
      description: 'My own words',
      price: 10,
      imageLink: ''
    })
  ).toEqual({ garment: null, color: null });
});
