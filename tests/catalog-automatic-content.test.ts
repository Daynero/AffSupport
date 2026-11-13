import { describe, expect, it } from 'vitest';
import { CATALOG_IMAGE_GARMENTS } from '../packages/shared/src/team/catalog-images';
import {
  AUTOMATIC_CATALOG_CONTENT_VERSION,
  CATALOG_CONTENT_VARIANT_COUNT,
  catalogPriceBand,
  createCatalogContentDraw
} from '../packages/shared/src/team/catalog-content';

const seeded = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};

describe('automatic catalog content', () => {
  it('provides exactly 2000 unique shared variants before safely cycling', () => {
    expect(CATALOG_CONTENT_VARIANT_COUNT).toBe(2000);
    const draw = createCatalogContentDraw(seeded(7));
    const rows = Array.from({ length: 2000 }, () => draw({ garment: 'T-Shirt', color: 'black' }));
    expect(new Set(rows.map(row => row.variantId)).size).toBe(2000);
    expect(new Set(rows.map(row => row.title)).size).toBe(2000);
    expect(new Set(rows.map(row => row.description)).size).toBe(2000);
    const next = Array.from({ length: 2000 }, () => draw({ garment: 'T-Shirt', color: 'black' }));
    expect(new Set(next.map(row => row.variantId)).size).toBe(2000);
    expect(next.map(row => row.variantId).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 2000 }, (_, index) => index)
    );
  });

  it.each(CATALOG_IMAGE_GARMENTS)(
    'matches %s facts and its inclusive category price band',
    (_, garment) => {
      const band = catalogPriceBand(garment);
      expect(Number.isSafeInteger(band.min) && Number.isSafeInteger(band.max)).toBe(true);
      expect(band.min).toBeGreaterThan(0);
      expect(band.max).toBeGreaterThanOrEqual(band.min);
      for (const random of [() => 0, () => 1 - Number.EPSILON]) {
        const row = createCatalogContentDraw(random)({ garment, color: 'dusty rose' });
        expect(row.policyVersion).toBe(AUTOMATIC_CATALOG_CONTENT_VERSION);
        expect(row.title.toLowerCase()).toContain(garment.toLowerCase());
        expect(row.title.toLowerCase()).toContain('dusty rose');
        expect(row.description.toLowerCase()).toContain(garment.toLowerCase());
        expect(row.description.toLowerCase()).toContain('dusty rose');
        expect(row.title.length).toBeLessThanOrEqual(200);
        expect(row.description.length).toBeLessThanOrEqual(9999);
        expect(row.price).toBe(random() === 0 ? band.min : band.max);
        expect(row.description).not.toMatch(
          /cotton|silk|wool|sizes|machine wash|dry clean|made from/iu
        );
      }
    }
  );

  it('prices dresses and jackets above basic T-shirts', () => {
    const shirt = catalogPriceBand('T-Shirt');
    for (const garment of [
      'Midi Dress',
      'Maxi Dress',
      'Wrap Dress',
      'Bomber Jacket',
      'Puffer Jacket'
    ])
      expect(catalogPriceBand(garment).min).toBeGreaterThan(shirt.max);
  });

  it('keeps unknown or malicious facts neutral instead of echoing unsupported input', () => {
    for (const facts of [
      { garment: null, color: null },
      { garment: 'Sneakers', color: 'black' },
      { garment: '<script>dress</script>', color: 'secret' }
    ]) {
      const row = createCatalogContentDraw(() => 0)(facts);
      expect(row.price).toBe(catalogPriceBand(null).min);
      expect(row.title + row.description).not.toMatch(/Sneakers|black|script|secret|dress/iu);
      expect(row.title).toContain('Catalog Item');
    }
    const invalidColor = createCatalogContentDraw(() => 0)({ garment: 'T-Shirt', color: 'secret' });
    expect(invalidColor.title + invalidColor.description).not.toContain('secret');
    expect(invalidColor.title).toContain('T-Shirt');
  });

  it('normalizes vocabulary color spelling without interpreting arbitrary content', () => {
    const row = createCatalogContentDraw(() => 0)({ garment: 'Hoodie', color: 'Sky-Blue' });
    expect(row.title).toContain('Sky Blue Hoodie');
  });

  it('can reproduce a selection stream without any cross-call shared cursor', () => {
    const left = createCatalogContentDraw(seeded(42));
    const right = createCatalogContentDraw(seeded(42));
    const other = createCatalogContentDraw(seeded(88));
    for (let index = 0; index < 300; index++) {
      other({ garment: 'Blouse', color: 'ivory' });
      expect(left({ garment: 'Wrap Dress', color: 'coral' })).toEqual(
        right({ garment: 'Wrap Dress', color: 'coral' })
      );
    }
  });

  it.each([NaN, Infinity, -Infinity, -1, 1, 2])(
    'bounds malformed random value %s without looping',
    value => {
      const draw = createCatalogContentDraw(() => value);
      const rows = Array.from({ length: 2001 }, () => draw({ garment: 'T-Shirt', color: 'white' }));
      expect(
        rows.every(
          row => Number.isInteger(row.variantId) && row.variantId >= 0 && row.variantId < 2000
        )
      ).toBe(true);
      expect(rows.every(row => row.price >= 12 && row.price <= 24)).toBe(true);
      expect(new Set(rows.slice(0, 2000).map(row => row.variantId)).size).toBe(2000);
    }
  );
});
