import { describe, expect, it } from 'vitest';
import {
  launchCampaignName,
  launchCreativeIdPrefix,
  launchCreativeLabel,
  launchPreview,
  parseLaunchConfig,
  parseLaunchDraft,
  parseLaunchSources,
  type LaunchConfig,
  type LaunchCreative
} from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';

const video = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const creative = (n: number, copies: number, pinned: number | null = null): LaunchCreative => ({
  materialId: video(n),
  alias: `creo_${n}`,
  copies,
  pinned
});
const multi = (
  creatives: LaunchCreative[],
  overrides: Partial<LaunchConfig> = {},
  catalog: Partial<LaunchConfig['catalog']> = {}
): LaunchConfig =>
  launchConfig({
    method: 'catalog',
    materialId: creatives[0]!.materialId,
    creativeAlias: creatives[0]!.alias,
    creativeKind: 'video',
    creatives,
    ...overrides,
    catalog: {
      productCount: creatives.reduce((sum, c) => sum + c.copies, 0),
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null,
      ...catalog
    }
  });
const four = () => [creative(1, 40, 1), creative(2, 30, 2), creative(3, 20), creative(4, 10)];
const errorOf = (raw: unknown) => {
  const parsed = parseLaunchConfig(raw);
  return parsed.ok ? null : parsed.errors.creatives;
};

describe('parseLaunchConfig with creatives', () => {
  it('keeps the list, kind and typed marks', () => {
    const parsed = parseLaunchConfig(multi(four()));
    if (!parsed.ok) throw new Error(`refused: ${JSON.stringify(parsed.errors)}`);
    expect(parsed.value.creativeKind).toBe('video');
    expect(parsed.value.creatives).toEqual(four());
  });
  it('reads a legacy config unchanged (no creatives field)', () => {
    const parsed = parseLaunchConfig(launchConfig());
    expect(parsed.ok && 'creatives' in parsed.value).toBe(false);
  });
  it('refuses shares that do not add up to the product count', () => {
    expect(errorOf(multi(four(), {}, { productCount: 99 }))).toBe('DISTRIBUTION_INVALID');
  });
  it('refuses a creative with no products', () => {
    expect(errorOf(multi([creative(1, 100), creative(2, 0)], {}, { productCount: 100 }))).toBe(
      'DISTRIBUTION_INVALID'
    );
  });
  it('refuses the same material twice', () => {
    expect(errorOf(multi([creative(1, 50), creative(1, 50)]))).toBe('CREATIVE_DUPLICATE');
  });
  it('refuses a list whose first creative is not the mirrored one', () => {
    expect(errorOf(multi(four(), { materialId: video(2) }))).toBe('INVALID_INPUT');
    expect(errorOf(multi(four(), { creativeAlias: 'other' }))).toBe('INVALID_INPUT');
  });
  it('keeps the other method to one creative', () => {
    expect(errorOf(multi([creative(1, 50), creative(2, 50)], { method: 'other' }))).toBe(
      'CREATIVES_LIMIT'
    );
  });
  it('has no creative limit below the 400-product ceiling', () => {
    const many = Array.from({ length: 400 }, (_, index) => creative(index + 1, 1));
    expect(parseLaunchConfig(multi(many)).ok).toBe(true);
  });
  it('refuses restitch for images', () => {
    expect(
      errorOf(
        multi(
          four(),
          { creativeKind: 'image' },
          {
            restitchEnabled: true,
            finalDurationMode: 'random-30-40'
          }
        )
      )
    ).toBe('INVALID_INPUT');
  });
  it('needs at least one variation per video and no more than the products', () => {
    const restitch = (videoVariationCount: number) =>
      multi(
        four(),
        {},
        {
          restitchEnabled: true,
          catalogVideoProtocolVersion: 1,
          videoVariationCount,
          videoPublication: { mode: 'immediate' }
        }
      );
    expect(errorOf(restitch(3))).toBe('VARIATIONS_RANGE');
    expect(parseLaunchConfig(restitch(4)).ok).toBe(true);
    expect(parseLaunchConfig(restitch(100)).ok).toBe(true);
    expect(parseLaunchConfig(restitch(101)).ok).toBe(false);
  });
});

describe('drafts and sources', () => {
  it('round-trips creatives through a draft', () => {
    const draft = parseLaunchDraft(multi(four()));
    expect(draft?.creatives).toEqual(four());
    expect(draft?.creativeKind).toBe('video');
  });
  it('parses every creative material in order', () => {
    const parsed = parseLaunchSources({
      schemaVersion: 1,
      accountId: '55555555-5555-4555-8555-555555555555',
      agentRowId: '11111111-1111-4111-8111-111111111111',
      offerId: '22222222-2222-4222-8222-222222222222',
      buyerId: '33333333-3333-4333-8333-333333333333',
      materialId: video(1),
      social: 'g1',
      agentId: '1234567892',
      offer: 'Offer',
      buyer: 'buyer',
      materialType: 'video',
      materialVersion: '1',
      catalogSettingsVersion: null,
      materials: [
        { materialId: video(1), type: 'video', version: '1' },
        { materialId: video(2), type: 'video', version: '3' }
      ]
    });
    expect(parsed?.materials?.map(m => m.version)).toEqual(['1', '3']);
  });
});

describe('preview', () => {
  const sources = (types: Array<'video' | 'image'>) => ({
    ...launchSources,
    materialType: types[0]!,
    materials: types.map((type, index) => ({
      materialId: video(index + 1),
      type,
      version: '1'
    }))
  });
  it('accepts images as catalog creatives', () => {
    const config = multi([creative(1, 50), creative(2, 50)], { creativeKind: 'image' });
    expect(launchPreview(config, sources(['image', 'image'])).ok).toBe(true);
  });
  it('refuses a mixed set', () => {
    const config = multi([creative(1, 50), creative(2, 50)]);
    const result = launchPreview(config, sources(['video', 'image']));
    expect(result.ok ? null : result.errors.creatives).toBe('CREATIVES_MIXED');
  });
  it('keeps a legacy catalog launch video-only', () => {
    const config = launchConfig({ method: 'catalog' });
    expect(launchPreview(config, { ...launchSources, materialType: 'image' }).ok).toBe(false);
  });
});

describe('naming', () => {
  it('labels several creatives as first +N', () => {
    expect(launchCreativeLabel(multi(four()))).toBe('creo_1+3');
    expect(launchCreativeLabel(launchConfig())).toBe('v5');
    const name = launchCampaignName(multi(four()), launchSources, {
      ordinal: 1,
      budget: 10,
      adStart: 1,
      adEnd: 3
    });
    expect(name.startsWith('[g1-892-creo_1+3-c]')).toBe(true);
  });
  it('cuts an ID prefix to 40 characters', () => {
    expect(launchCreativeIdPrefix('a'.repeat(60))).toHaveLength(40);
  });
});
