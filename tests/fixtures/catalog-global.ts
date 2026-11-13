import type { GlobalCatalogImage } from '../../packages/shared/src/team/catalog-global-images.js';
import { CATALOG_IMAGE_VOCABULARY_VERSION } from '../../packages/shared/src/team/catalog-images.js';

export const GLOBAL_FIXTURE_TIME = '2026-11-12T12:00:00.000Z';
export const globalFixtureId = (n: number): string =>
  `52000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export function globalImageFixture(n = 1): GlobalCatalogImage {
  return {
    kind: 'global',
    imageId: globalFixtureId(n),
    assignmentId: globalFixtureId(n + 10_000),
    aliasId: globalFixtureId(n + 20_000),
    publicUrl: `https://images.example.test/g/fixture-${n}.jpg`,
    generation: 1,
    issuedSlot: '1',
    policyEpoch: 1,
    classification: {
      mode: 'matched',
      garment: 'Hoodie',
      color: 'black',
      vocabularyVersion: CATALOG_IMAGE_VOCABULARY_VERSION
    }
  };
}

export const globalImageFixtures = (count = 2000): GlobalCatalogImage[] =>
  Array.from({ length: count }, (_, n) => globalImageFixture(n + 1));

export function globalFixtureClock(at = GLOBAL_FIXTURE_TIME) {
  let ms = Date.parse(at);
  return {
    now: () => ms,
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
    set: (iso: string) => {
      ms = Date.parse(iso);
    }
  };
}

export const GLOBAL_PROTECTED_FIXTURES = Object.freeze({
  legacy: 'v1/52000000-0000-4000-8000-000000000001',
  global: 'g1/52000000-0000-4000-8000-000000000002',
  video: 'catalog-video/52000000-0000-4000-8000-000000000003',
  restitch: 'screens/52000000-0000-4000-8000-000000000004',
  original: 'external-drive-original'
});
