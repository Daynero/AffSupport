import { describe, expect, it, vi } from 'vitest';
import {
  pairCatalogImageRow,
  parseCatalogDrawnImage
} from '../supabase/functions/_shared/catalog-image-rows';
import {
  drawCatalogImagePool,
  assertCatalogImageContract
} from '../supabase/functions/_shared/catalog-image-draw';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';
import { planCatalogRows } from '../supabase/functions/_shared/product-catalog';

const image = (file = 'hoodie_black_001.jpg') => ({
  kind: 'r2' as const,
  publicationId: 'pub',
  poolEntryId: 'pool',
  publicUrl: 'https://media.example/a.jpg',
  classification: classifyCatalogImageName(file),
  revision: 1
});
const row = {
  title: 'Navy Cotton Hoodie Model',
  description: 'A navy hoodie for daily wear.',
  price: 99,
  imageLink: 'https://old.example/a.jpg',
  brand: 'Invented',
  quantity: 40
};
describe('R2 row pairing', () => {
  it('requires actual text for random images while allowing factual matched fallback', () => {
    const input = {
      count: 1,
      settings: { title: '', description: '', imageLink: '', priceMin: 10, priceMax: 10 },
      texts: []
    };
    const generic = image('IMG_2031.png');
    expect(
      planCatalogRows({ ...input, images: [{ link: generic.publicUrl, image: generic }] })
    ).toBeNull();
    const matched = image();
    const rows = planCatalogRows({
      ...input,
      images: [{ link: matched.publicUrl, image: matched }]
    });
    expect(rows?.[0]?.title).toContain('Hoodie');
    expect(rows?.[0]?.description).toContain('hoodie');
  });
  it('corrects only unique known tokens under image-only refresh', () => {
    expect(pairCatalogImageRow(row, image(), { allowTextGeneration: false })).toMatchObject({
      title: 'Black Cotton Hoodie Model',
      description: 'A black hoodie for daily wear.',
      price: 99,
      quantity: 40,
      color: 'black'
    });
  });
  it.each([
    { ...row, title: 'Custom product' },
    { ...row, title: 'Navy Hoodie Black Tank Top' },
    { ...row, description: 'Black and white hoodie' },
    { ...row, title: 'Navy Hoodie ' + 'x'.repeat(199) }
  ])('retains fail-safe instead of guessing for %j', source => {
    expect(() => pairCatalogImageRow(source, image(), { allowTextGeneration: false })).toThrow(
      'IMAGE_TEXT_PAIRING_CONFLICT'
    );
    expect(source.imageLink).toBe(row.imageLink);
  });
  it('uses canonical factual text only when generation permitted', () => {
    expect(
      pairCatalogImageRow({ ...row, title: 'custom' }, image('tshirt_white_001.jpg'), {
        allowTextGeneration: true
      })
    ).toMatchObject({ title: 'White T-Shirt Essential Style', color: 'white' });
  });
  it('keeps ordinary images random with no invented facts', () => {
    const result = pairCatalogImageRow(row, image('IMG_1.jpg'), { allowTextGeneration: false });
    expect(result.title).toBe(row.title);
    expect(result.pictureImage?.classification.mode).toBe('unclassified');
  });
  it('rejects malformed or unknown checkpoint shapes', () => {
    expect(parseCatalogDrawnImage({ ...image(), publicUrl: 'javascript:alert(1)' })).toBeNull();
    expect(
      parseCatalogDrawnImage({ kind: 'future', driveFileId: 'x', resourceKey: null })
    ).toBeNull();
    expect(parseCatalogDrawnImage({ driveFileId: 'drive', resourceKey: null })).toMatchObject({
      driveFileId: 'drive'
    });
  });
  it('distinguishes empty v2 dictionary from legacy mode', async () => {
    const call = vi.fn().mockResolvedValue([]);
    await expect(
      drawCatalogImagePool(call, 'team', 100, { contractVersion: 2 })
    ).rejects.toMatchObject({
      code: 'WRONG_STATE',
      details: { reason: 'settings_missing' }
    });
    expect(call).toHaveBeenCalledTimes(1);
    const legacy = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ drive_file_id: 'drive' }]);
    expect(await drawCatalogImagePool(legacy, 'team', 1, { contractVersion: 2 })).toMatchObject([
      { driveFileId: 'drive' }
    ]);
  });
  it('refuses fresh old-client writes before external mutations', async () => {
    await expect(
      assertCatalogImageContract(vi.fn().mockResolvedValue('v2'), 'team', undefined)
    ).rejects.toThrow('CATALOG_IMAGE_UPGRADE_REQUIRED');
  });
});

it('checks actual post-replacement title and description boundaries without truncation', () => {
  const prefix = 'Black Hoodie ',
    bodyPrefix = 'A black hoodie ';
  const exact = {
    ...row,
    title: prefix + 'x'.repeat(195 - prefix.length),
    description: bodyPrefix + 'x'.repeat(9994 - bodyPrefix.length)
  };
  const result = pairCatalogImageRow(exact, image('hoodie_terracotta_001.jpg'), {
    allowTextGeneration: false
  });
  expect(result.title).toHaveLength(200);
  expect(result.description).toHaveLength(9999);
  expect(() =>
    pairCatalogImageRow(
      { ...exact, title: exact.title + 'x' },
      image('hoodie_terracotta_001.jpg'),
      { allowTextGeneration: false }
    )
  ).toThrow('IMAGE_TEXT_PAIRING_CONFLICT');
  expect(() =>
    pairCatalogImageRow(
      { ...exact, description: exact.description + 'x' },
      image('hoodie_terracotta_001.jpg'),
      { allowTextGeneration: false }
    )
  ).toThrow('IMAGE_TEXT_PAIRING_CONFLICT');
});
