import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CATALOG_IMAGE_GARMENTS,
  CATALOG_IMAGE_COLORS,
  classifyCatalogImageName
} from '../packages/shared/src/team/catalog-images';
import { pictureFacts } from '../supabase/functions/_shared/product-details';
import { clothesInPictures } from '../apps/web/src/team/product-catalog/apparelTexts';

describe('catalog image classification', () => {
  it('keeps all 768 prompt names compatible with both legacy readers', () => {
    const guide = readFileSync('specs/045-catalog-r2-images/image-guide.md', 'utf8');
    expect(guide.match(/^ТИПИ: (.+)$/m)?.[1]?.split(', ')).toEqual(
      CATALOG_IMAGE_GARMENTS.map(x => x[0])
    );
    expect(guide.match(/^КОЛЬОРИ: (.+)$/m)?.[1]?.split(', ')).toEqual(CATALOG_IMAGE_COLORS);
    for (const [token, name] of CATALOG_IMAGE_GARMENTS)
      for (const color of CATALOG_IMAGE_COLORS) {
        const file = `${token}_${color}_001.jpg`;
        const result = classifyCatalogImageName(file);
        expect(result).toMatchObject({
          mode: 'matched',
          garment: name,
          color: color.replace(/-/g, ' ')
        });
        expect(pictureFacts(file).garment?.name).toBe(name);
        expect(clothesInPictures([file]).garments).toEqual([name]);
      }
  });
  it.each([
    'IMG_2031.png',
    'hoodie_001.jpg',
    'hoodie_black_white_01.jpg',
    'hoodie_jeans_tshirt_black.jpg',
    'blackhoodie.png'
  ])('keeps ordinary or ambiguous %s usable without inventing facts', name => {
    expect(classifyCatalogImageName(name)).toMatchObject({
      mode: 'unclassified',
      garment: null,
      color: null
    });
  });
  it('recognizes exact word boundaries and normalized case', () => {
    expect(classifyCatalogImageName('OXFORD-SHIRT_STONE-GREY_001.PNG')).toMatchObject({
      mode: 'matched',
      garment: 'Oxford Shirt',
      color: 'stone grey'
    });
    expect(classifyCatalogImageName('hoodie_black_white_001.png')).toMatchObject({
      mode: 'unclassified',
      reason: 'ambiguous'
    });
  });
});
