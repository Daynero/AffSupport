import type { LaunchDraft } from '@video-compressor/shared';
import { CATALOG_DEFERRED_PUBLICATION_AVAILABLE } from '../product-catalog/CatalogPublicationSchedule';

/**
 * The catalog video fields a generation always sends.
 *
 * A draft saved before these fields existed, or one whose catalog fields were never
 * touched, lacks them; the generation fills them in. The editor must hold the same
 * filled-in config it generated from, or the next autosave writes the shorter shape
 * back over the draft and the result looks out of date the moment it lands.
 */
export function withCatalogGenerationDefaults<T extends LaunchDraft>(config: T): T {
  if (config.method !== 'catalog' || !config.catalog) return config;
  return {
    ...config,
    catalog: {
      ...config.catalog,
      catalogVideoProtocolVersion: 1,
      videoVariationCount: config.catalog.videoVariationCount ?? 1,
      videoPublication: CATALOG_DEFERRED_PUBLICATION_AVAILABLE
        ? (config.catalog.videoPublication ?? { mode: 'immediate' })
        : { mode: 'immediate' }
    }
  };
}

/**
 * For "do these settings still match the result": an absent catalog video field means
 * its default, on either side, so a draft and a revision that differ only in spelling
 * the default compare equal.
 */
export function catalogComparable<T extends LaunchDraft>(config: T): T {
  if (config.method !== 'catalog' || !config.catalog) return config;
  return {
    ...config,
    catalog: {
      ...config.catalog,
      catalogVideoProtocolVersion: config.catalog.catalogVideoProtocolVersion ?? 1,
      copyVideoToR2: config.catalog.copyVideoToR2 ?? false,
      videoVariationCount: config.catalog.restitchEnabled
        ? (config.catalog.videoVariationCount ?? 1)
        : 1,
      videoPublication: config.catalog.videoPublication ?? { mode: 'immediate' }
    }
  };
}
