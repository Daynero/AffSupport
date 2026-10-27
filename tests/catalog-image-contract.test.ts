import { expect, it } from 'vitest';
import {
  classifyCatalogImageName,
  isR2CatalogImage,
  isCatalogImageClassification,
  isCatalogImageImportEntry,
  isCatalogImageImportJob
} from '../packages/shared/src/team/catalog-images';
it('accepts optional bounded job failure codes but never provider error prose', () => {
  const job = {
    id: 'job',
    teamId: 'team',
    sourceKind: 'drive',
    state: 'failed',
    revision: 1,
    counts: { total: 0, ready: 0, reused: 0, unclassified: 0, failed: 0, expired: 0 },
    entries: [],
    hasMore: false,
    nextCursor: null
  };
  expect(isCatalogImageImportJob(job)).toBe(true);
  expect(isCatalogImageImportJob({ ...job, errorCode: null })).toBe(true);
  expect(isCatalogImageImportJob({ ...job, errorCode: 'IMAGE_SOURCE_UNAVAILABLE' })).toBe(true);
  expect(
    isCatalogImageImportJob({
      ...job,
      errorCode: 'Provider failed at https://private.example/file'
    })
  ).toBe(false);
  expect(isCatalogImageImportJob({ ...job, errorCode: 'X'.repeat(97) })).toBe(false);
});
it('rejects forged classification and credential-bearing public URL', () => {
  const classification = classifyCatalogImageName('hoodie_black_001.jpg');
  expect(isCatalogImageClassification({ ...classification, garment: 'Handbag' })).toBe(false);
  const image = {
    kind: 'r2',
    publicationId: 'publication',
    poolEntryId: 'entry',
    publicUrl: 'https://media.example/a.jpg',
    classification,
    revision: 1
  };
  expect(isR2CatalogImage(image)).toBe(true);
  expect(isR2CatalogImage({ ...image, publicUrl: 'https://media.example/a?token=secret' })).toBe(
    false
  );
  expect(isR2CatalogImage({ ...image, publicUrl: 'javascript:alert(1)' })).toBe(false);
});
it('allows expired unclassified entries as normal explicit source expiry', () => {
  expect(
    isCatalogImageImportEntry({
      id: 'entry',
      clientFileKey: 'file',
      displayName: 'IMG_1.png',
      state: 'expired',
      classification: classifyCatalogImageName('IMG_1.png'),
      errorCode: null,
      declaredSize: 1
    })
  ).toBe(true);
});
