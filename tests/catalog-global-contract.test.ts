import { describe, expect, it } from 'vitest';
import {
  GLOBAL_CATALOG_IMAGE_CONTRACT_VERSION,
  GLOBAL_CATALOG_IMAGE_LIMITS,
  GLOBAL_CATALOG_IMAGE_ERROR_CODES,
  globalImageGeneration,
  isGlobalCatalogImage,
  isGlobalImageCounter,
  isGlobalImageReadiness
} from '../packages/shared/src/team/catalog-global-images.js';
import { lookupCodeLocations } from '../scripts/analytics/code-map.js';
import { globalImageFixture } from './fixtures/catalog-global.js';

describe('global catalog image boundary', () => {
  it('keeps image use threshold separate from issued URL capacity', () => {
    expect(GLOBAL_CATALOG_IMAGE_CONTRACT_VERSION).toBe(3);
    expect(GLOBAL_CATALOG_IMAGE_LIMITS.urlCapacity).toBe(200);
    expect(GLOBAL_CATALOG_IMAGE_LIMITS.informationalThreshold).toBe(5000);
    expect([1n, 199n, 200n, 201n, 400n, 401n].map(globalImageGeneration)).toEqual([
      1, 1, 1, 2, 2, 3
    ]);
    expect(() => globalImageGeneration(0n)).toThrow();
  });
  it('preserves exact nonnegative bigint counters and rejects lossy numbers', () => {
    expect(isGlobalImageCounter('9007199254740993')).toBe(true);
    for (const value of [Number('9007199254740993'), '-1', '01', '1.0', '', '9223372036854775808'])
      expect(isGlobalImageCounter(value)).toBe(false);
  });
  it('validates the full published assignment rather than trusting URL alone', () => {
    const image = globalImageFixture();
    expect(isGlobalCatalogImage(image)).toBe(true);
    for (const invalid of [
      { ...image, imageId: 'not-an-id' },
      { ...image, issuedSlot: '201', generation: 1 },
      { ...image, publicUrl: 'https://user:secret@images.example.test/g/x.jpg' },
      { ...image, publicUrl: 'http://images.example.test/g/x.jpg' },
      { ...image, publicUrl: 'https://images.example.test/g/x.jpg?secret=1' },
      { ...image, policyEpoch: 0 },
      { ...image, classification: { mode: 'matched', garment: 'Imaginary', color: 'black' } }
    ])
      expect(isGlobalCatalogImage(invalid)).toBe(false);
  });
  it('does not equate missing readiness with an empty or ready pool', () => {
    expect(
      isGlobalImageReadiness({
        contractVersion: 3,
        policyEpoch: 1,
        state: 'active',
        usable: true,
        reason: null,
        observedAt: '2026-11-12T12:00:00.000Z'
      })
    ).toBe(true);
    expect(isGlobalImageReadiness({ contractVersion: 3, usable: true })).toBe(false);
    expect(
      isGlobalImageReadiness({
        contractVersion: 3,
        policyEpoch: 1,
        state: 'active',
        usable: true,
        reason: 'GLOBAL_IMAGE_READINESS_UNKNOWN',
        observedAt: 'invalid'
      })
    ).toBe(false);
  });
});

it('maps each global failure to a diagnostic source and user-facing location', () => {
  for (const code of GLOBAL_CATALOG_IMAGE_ERROR_CODES) {
    const entry = lookupCodeLocations(`catalog:global:${code}`);
    expect(entry?.matched).toBe(`catalog:global:${code}`);
    expect(entry?.files).toContain('apps/web/src/team/errors.ts');
  }
});
