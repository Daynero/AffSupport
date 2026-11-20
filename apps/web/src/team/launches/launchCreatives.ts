import type { LaunchCreative, LaunchCreativeKind, LaunchDraft } from '@video-compressor/shared';

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
  return {
    materialId: first.materialId,
    creativeAlias: first.alias,
    creatives,
    creativeKind: kind ?? undefined,
    ...catalog,
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
