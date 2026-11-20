import { describe, expect, it } from 'vitest';
import {
  launchCreativeAnalytics,
  parseCatalogCreativeDiagnostics
} from '../packages/shared/src/team/launches/lifecycle';
import { sanitizeTeamAnalyticsProperties } from '../packages/shared/src/team/analytics';

/** 062 (T074): the typed creative properties — kinds, counts and ordinals, nothing else. */
const catalog = (overrides: Record<string, unknown> = {}) => ({
  productCount: 100,
  restitchEnabled: true,
  videoVariationCount: 30,
  ...overrides
});

describe('launchCreativeAnalytics', () => {
  it('describes four videos sharing evenly with thirty variations', () => {
    expect(
      launchCreativeAnalytics({
        method: 'catalog',
        creativeKind: 'video',
        creatives: [25, 25, 25, 25].map(copies => ({ copies })),
        catalog: catalog()
      })
    ).toEqual({
      creative_kind: 'video',
      creative_count: 4,
      product_count: 100,
      variation_count: 30,
      custom_distribution: false
    });
  });
  it('marks a hand-made share and images without variations', () => {
    expect(
      launchCreativeAnalytics({
        method: 'catalog',
        creativeKind: 'image',
        creatives: [40, 30, 20, 10].map(copies => ({ copies })),
        catalog: catalog({ restitchEnabled: false })
      })
    ).toMatchObject({ creative_kind: 'image', variation_count: 0, custom_distribution: true });
  });
  it('reads a config from before as one video, and nothing for the other method', () => {
    expect(
      launchCreativeAnalytics({ method: 'catalog', catalog: catalog({ restitchEnabled: false }) })
    ).toMatchObject({ creative_count: 1, custom_distribution: false, variation_count: 0 });
    expect(launchCreativeAnalytics({ method: 'other', catalog: catalog() })).toBeNull();
  });
  it('passes the client sanitizer within the server bounds', () => {
    const props = {
      creative_kind: 'image',
      creative_count: 4,
      product_count: 100,
      variation_count: 0,
      custom_distribution: true,
      creative_ordinal: 3,
      failed_ordinal: 2
    };
    expect(sanitizeTeamAnalyticsProperties(props)).toMatchObject(props);
    const out = sanitizeTeamAnalyticsProperties({
      creative_kind: 'audio',
      creative_count: 401,
      creative_ordinal: 400
    });
    expect(out).not.toHaveProperty('creative_kind');
    expect(out).not.toHaveProperty('creative_count');
    expect(out).not.toHaveProperty('creative_ordinal');
  });
});

describe('parseCatalogCreativeDiagnostics', () => {
  const base = {
    creativeKind: 'video',
    creativeCount: 2,
    productCount: 10,
    variationCount: 4,
    customDistribution: false,
    images: [],
    failedOrdinal: 1
  };
  it('reads the typed shape and refuses anything else', () => {
    expect(parseCatalogCreativeDiagnostics(base)).toEqual(base);
    expect(parseCatalogCreativeDiagnostics({ ...base, failedOrdinal: 400 })).toBeNull();
    expect(
      parseCatalogCreativeDiagnostics({
        ...base,
        images: [{ creativeOrdinal: 0, stage: 'creative_image.sent', attemptId: null }]
      })
    ).toBeNull();
  });
  it('closes an unknown code to UNKNOWN', () => {
    expect(
      parseCatalogCreativeDiagnostics({
        ...base,
        images: [
          {
            creativeOrdinal: 0,
            stage: 'creative_image.failed',
            attemptId: null,
            code: 'https://leak.example'
          }
        ]
      })?.images[0]?.code
    ).toBe('UNKNOWN');
  });
});
