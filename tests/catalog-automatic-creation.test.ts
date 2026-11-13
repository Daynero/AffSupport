import { describe, expect, it } from 'vitest';
import {
  planCatalogRows,
  parseCatalogRowRecipe
} from '../supabase/functions/_shared/product-catalog';
import { automaticCatalogImageFacts } from '../supabase/functions/_shared/catalog-image-rows';
import { globalImageFixture } from './fixtures/catalog-global';

const settings = {
  contentPolicyVersion: 1 as const,
  title: null,
  description: null,
  imageLink: null,
  priceMin: 1,
  priceMax: 1
};
describe('automatic catalog row planning', () => {
  it('renders 400 unique rows from final image facts without saved text or price settings', () => {
    const image = globalImageFixture();
    const rows = planCatalogRows({
      settings,
      count: 400,
      texts: [],
      images: [{ link: image.publicUrl, image }],
      random: () => 0.1
    })!;
    expect(rows).toHaveLength(400);
    expect(new Set(rows.map(row => row.title)).size).toBe(400);
    for (const row of rows) {
      expect(row).toMatchObject({
        contentPolicyVersion: 1,
        pictureImage: image,
        material: '',
        size: '',
        pattern: '',
        style: '',
        gender: '',
        shippingWeight: '',
        shipping: '',
        color: 'black'
      });
      expect(row.title).toMatch(/black.*hoodie/iu);
      expect(row.price).toBeGreaterThanOrEqual(28);
      expect(row.price).toBeLessThanOrEqual(55);
      expect(row.description).not.toMatch(/cotton|polyester|washable|sleeve|size/iu);
    }
    expect(parseCatalogRowRecipe(rows)).toEqual(rows);
  });
  it('uses an authoritative published classification over a misleading display filename', () => {
    expect(
      automaticCatalogImageFacts({
        pictureImage: globalImageFixture(),
        pictureName: 'wrap-dress_coral_001.png'
      })
    ).toEqual({ garment: 'Hoodie', color: 'black' });
  });
  it.each(['IMG_001.png', 'hoodie-black_blouse-coral.png', 'tshirt.png'])(
    'does not invent facts for %s',
    name => {
      const row = planCatalogRows({
        settings,
        count: 1,
        texts: [],
        images: [{ link: 'https://image.invalid/a', name }],
        random: () => 0
      })![0]!;
      expect(row).toMatchObject({
        color: '',
        material: '',
        size: '',
        pattern: '',
        googleCategory: '',
        fbCategory: '',
        price: 20
      });
      expect(row.title).not.toMatch(/hoodie|t-shirt|blouse|dress/iu);
    }
  );
  it('classifies complete legacy filenames and prices dresses above basic tops', () => {
    const rows = planCatalogRows({
      settings,
      count: 2,
      texts: [],
      images: [
        { link: 'https://image.invalid/a', name: 'wrap-dress_coral_002.png' },
        { link: 'https://image.invalid/b', name: 'tshirt_black_002.png' }
      ],
      random: () => 0
    })!;
    expect(rows[0]!.title).toMatch(/coral.*wrap dress/iu);
    expect(rows[1]!.title).toMatch(/black.*t-shirt/iu);
    expect(rows[0]!.price).toBeGreaterThan(rows[1]!.price);
  });
  it('keeps unmarked legacy settings behavior and rejects malformed automatic metadata', () => {
    const row = planCatalogRows({
      settings: {
        title: 'My item',
        description: 'My description',
        imageLink: 'https://image.invalid/a',
        priceMin: 9,
        priceMax: 9
      },
      count: 1,
      texts: [],
      images: []
    })![0]!;
    expect(row).toMatchObject({ title: 'My item', description: 'My description', price: 9 });
    expect(row.contentPolicyVersion).toBeUndefined();
    expect(
      parseCatalogRowRecipe([{ ...row, contentPolicyVersion: 1, contentVariantId: 2000 }])
    ).toBeNull();
    expect(
      parseCatalogRowRecipe([{ ...row, contentPolicyVersion: 2, contentVariantId: 0 }])
    ).toBeNull();
    expect(parseCatalogRowRecipe([{ ...row, contentVariantId: 0 }])).toBeNull();
  });
});
