import type {
  LaunchCatalogConfig,
  LaunchCreative,
  LaunchCreativeKind,
  LaunchDraft
} from '@video-compressor/shared';

/**
 * A catalog that carries a variation count. The count belongs to the v1 catalog video protocol
 * and is read only together with it and a publication: a count alone makes the stored draft
 * unreadable — «Сервер відповів несподівано» on every open (next, 2026-11-21). The variations
 * field writes the same three together.
 */
export function withVariationCount(
  catalog: LaunchCatalogConfig,
  videoVariationCount: number
): LaunchCatalogConfig {
  return {
    ...catalog,
    catalogVideoProtocolVersion: 1,
    videoVariationCount,
    videoPublication: catalog.videoPublication ?? { mode: 'immediate' }
  };
}

/** The creatives a draft names; an older single-creative draft reads as one. */
export function draftCreatives(config: LaunchDraft): LaunchCreative[] {
  if (Array.isArray(config.creatives) && config.creatives.length > 0) return config.creatives;
  if (!config.materialId) return [];
  return [
    {
      materialId: config.materialId,
      alias: config.creativeAlias ?? '',
      copies: config.catalog?.productCount ?? 1,
      pinned: null
    }
  ];
}

/** The patch that stores `creatives` and keeps the first one mirrored. */
export function creativesPatch(
  config: LaunchDraft,
  creatives: LaunchCreative[],
  kind: LaunchCreativeKind | null,
  productCount = config.catalog?.productCount
): LaunchDraft {
  const first = creatives[0];
  const catalog =
    config.catalog && productCount !== undefined && productCount !== config.catalog.productCount
      ? { catalog: { ...config.catalog, productCount } }
      : {};
  if (!first)
    return {
      materialId: undefined,
      creativeAlias: undefined,
      creatives: undefined,
      creativeKind: undefined,
      ...catalog
    };
  // A video added while restitch is on needs a variation of its own: one per video is the
  // least the launch accepts, so the count follows instead of turning into an error.
  const variations = config.catalog?.videoVariationCount ?? 1;
  const followCount =
    kind !== 'image' &&
    config.catalog?.restitchEnabled === true &&
    creatives.length > 1 &&
    variations < creatives.length
      ? Math.min(creatives.length, productCount ?? creatives.length)
      : undefined;
  return {
    materialId: first.materialId,
    creativeAlias: first.alias,
    creatives,
    creativeKind: kind ?? undefined,
    ...catalog,
    ...(followCount !== undefined && config.catalog
      ? {
          catalog: withVariationCount(
            { ...config.catalog, ...(productCount !== undefined ? { productCount } : {}) },
            followCount
          )
        }
      : {}),
    ...(kind === 'image' && config.catalog?.restitchEnabled
      ? {
          catalog: {
            ...config.catalog,
            ...(productCount !== undefined ? { productCount } : {}),
            restitchEnabled: false,
            ...(config.catalog.catalogVideoProtocolVersion === 1 ? { videoVariationCount: 1 } : {})
          }
        }
      : {})
  };
}
