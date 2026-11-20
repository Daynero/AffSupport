import { GLOBAL_CATALOG_IMAGE_ERROR_CODES } from '../catalog-global-images.js';
import { STITCH_ERROR_CODES } from '../../stitch-errors.js';
import { CATALOG_IMAGE_ERROR_CODES } from '../catalog-images.js';
/** Closed diagnostic vocabulary: user configuration and output never enter telemetry. */
export const LAUNCH_ANALYTICS_EVENTS = [
  'team_launch_intent',
  'team_launch_stage',
  'team_launch_terminal',
  'team_launch_visible',
  'team_launch_action'
] as const;
export const LAUNCH_ANALYTICS_STAGES = [
  'validation',
  'draft_saved',
  'accepted',
  'preparing',
  'restitch_preparing',
  'restitch_processing',
  'restitch_uploading',
  'catalog_planning',
  'catalog_creating',
  'catalog_sharing',
  'catalog_registering',
  'result_committing',
  'result_committed',
  'cancel',
  'cleanup'
] as const;
export const LAUNCH_ANALYTICS_ACTIONS = [
  'generate',
  'retry',
  'cancel',
  'save_draft',
  'refresh_sources',
  'save_overrides',
  'restore_config',
  'save_defaults',
  'copy_launch',
  'archive_launch',
  'assign_account',
  'release_account',
  'copy_field',
  'rename_dictionary',
  'archive_dictionary',
  'restore_dictionary'
] as const;
export const LAUNCH_ANALYTICS_FIELDS = [
  'advertising_url',
  'catalog_name',
  'catalog_url',
  'campaign_name',
  'budget',
  'ad_range',
  'sub1',
  'sub2',
  'sub3'
] as const;
export const LAUNCH_ANALYTICS_CODES = [
  ...STITCH_ERROR_CODES,
  'PROCESS_RESULT_UNCERTAIN',
  ...CATALOG_IMAGE_ERROR_CODES,
  ...GLOBAL_CATALOG_IMAGE_ERROR_CODES,
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'SOURCE_CHANGED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'SPACE_BLOCKED',
  'LAUNCH_BUSY',
  'LAUNCH_VERSION_CONFLICT',
  'LAUNCH_URL_INVALID',
  'LAUNCH_SUB_INVALID',
  'LAUNCH_BUDGET_INVALID',
  'LAUNCH_RESULT_UNCERTAIN',
  'LEASE_MISMATCH',
  'DRIVE_UNAVAILABLE',
  'DRIVE_FILE_MISSING',
  'AGENT_UPDATE_REQUIRED',
  'AGENT_REQUIRED',
  'NEEDS_REAUTH',
  'RESTITCH_INVALID',
  'RESTITCH_NO_SCREENS',
  'RESTITCH_POOL_EMPTY',
  'RESTITCH_SOURCE_FORBIDDEN',
  'RESTITCH_SOURCES_INVALID',
  'RESTITCH_CLIENT_OUTDATED',
  'PROCESS_FAILED',
  'PROCESS_CANCELED',
  'WRONG_STATE',
  'LAUNCH_INTERNAL_ERROR',
  'SHARE_NOT_ALLOWED',
  'NO_WORK',
  // 062 — several creatives and image creatives.
  'CREATIVES_MIXED',
  'CREATIVES_LIMIT',
  'CREATIVE_DUPLICATE',
  'DISTRIBUTION_INVALID',
  'VARIATIONS_RANGE',
  'CREATIVE_IMAGE_FORMAT',
  'CREATIVE_IMAGE_TOO_LARGE',
  'PUBLIC_READ_UNVERIFIED',
  'MULTI_CREATIVE_UNSUPPORTED',
  'UNKNOWN'
] as const;
export type LaunchAnalyticsStage = (typeof LAUNCH_ANALYTICS_STAGES)[number];
export type LaunchAnalyticsAction = (typeof LAUNCH_ANALYTICS_ACTIONS)[number];
export type LaunchAnalyticsField = (typeof LAUNCH_ANALYTICS_FIELDS)[number];
export type LaunchAnalyticsCode = (typeof LAUNCH_ANALYTICS_CODES)[number];
export function safeLaunchAnalyticsCode(value: unknown): LaunchAnalyticsCode {
  return LAUNCH_ANALYTICS_CODES.find(code => code === value) ?? 'UNKNOWN';
}

/** 062: the stages one image creative's publication passes, as diagnosis names them. */
export const CREATIVE_IMAGE_STAGES = [
  'creative_image.accepted',
  'creative_image.published',
  'creative_image.verified',
  'creative_image.failed'
] as const;
export type CreativeImageStage = (typeof CREATIVE_IMAGE_STAGES)[number];

/** 062: what a catalog Launch's creatives look like to analytics — counts and kinds only. */
export interface LaunchCreativeAnalytics {
  creative_kind: 'video' | 'image';
  creative_count: number;
  product_count: number;
  variation_count: number;
  custom_distribution: boolean;
}

interface CreativeConfigShape {
  method: 'catalog' | 'other';
  creativeKind?: 'video' | 'image';
  creatives?: ReadonlyArray<{ copies: number }>;
  catalog: { productCount: number; restitchEnabled: boolean; videoVariationCount?: number };
}

/**
 * The typed launch admission/generation properties of 062. A config from before has one
 * video holding every product. The distribution is custom when it is not the even share
 * (⌊n/k⌋ each, the remainder to the first). Never a name, alias, material ID or link.
 */
export function launchCreativeAnalytics(
  config: CreativeConfigShape
): LaunchCreativeAnalytics | null {
  if (config.method !== 'catalog') return null;
  const n = config.catalog.productCount;
  const copies = config.creatives?.map(creative => creative.copies) ?? [n];
  const k = copies.length;
  const base = Math.floor(n / k);
  const even = copies.every((value, index) => value === base + (index < n - base * k ? 1 : 0));
  const kind = config.creativeKind ?? 'video';
  return {
    creative_kind: kind,
    creative_count: Math.min(400, Math.max(1, k)),
    product_count: Math.min(400, Math.max(1, n)),
    variation_count:
      kind === 'video' && config.catalog.restitchEnabled
        ? Math.min(400, Math.max(0, config.catalog.videoVariationCount ?? 1))
        : 0,
    custom_distribution: !even
  };
}

/** 062: one image creative's last observed stage in a catalog generation. */
export interface CatalogCreativeImageDiagnostic {
  creativeOrdinal: number;
  stage: CreativeImageStage;
  /** The publication attempt (`launch_creative_images.attempt_id`); a random UUID. */
  attemptId: string | null;
  code?: LaunchAnalyticsCode;
}
/** 062: the `creativeDiagnostics` checkpoint of a catalog generation. */
export interface CatalogCreativeDiagnostics {
  creativeKind: 'video' | 'image';
  creativeCount: number;
  productCount: number;
  variationCount: number;
  customDistribution: boolean;
  images: CatalogCreativeImageDiagnostic[];
  /** The first segment whose restitch set could not be proven. */
  failedOrdinal?: number;
}

const DIAGNOSTIC_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const bounded = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;

/** Strict reader for producer and CLI alike: anything else is null, never partially trusted. */
export function parseCatalogCreativeDiagnostics(value: unknown): CatalogCreativeDiagnostics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    (v.creativeKind !== 'video' && v.creativeKind !== 'image') ||
    !bounded(v.creativeCount, 1, 400) ||
    !bounded(v.productCount, 1, 400) ||
    !bounded(v.variationCount, 0, 400) ||
    typeof v.customDistribution !== 'boolean' ||
    !Array.isArray(v.images) ||
    v.images.length > 400 ||
    (v.failedOrdinal !== undefined && !bounded(v.failedOrdinal, 0, 399))
  )
    return null;
  const images: CatalogCreativeImageDiagnostic[] = [];
  for (const raw of v.images) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const image = raw as Record<string, unknown>;
    const stage = CREATIVE_IMAGE_STAGES.find(known => known === image.stage);
    if (
      !bounded(image.creativeOrdinal, 0, 399) ||
      !stage ||
      (image.attemptId !== null &&
        (typeof image.attemptId !== 'string' || !DIAGNOSTIC_UUID.test(image.attemptId))) ||
      (image.code !== undefined && typeof image.code !== 'string')
    )
      return null;
    images.push({
      creativeOrdinal: image.creativeOrdinal,
      stage,
      attemptId: image.attemptId as string | null,
      ...(image.code !== undefined ? { code: safeLaunchAnalyticsCode(image.code) } : {})
    });
  }
  return {
    creativeKind: v.creativeKind,
    creativeCount: v.creativeCount,
    productCount: v.productCount,
    variationCount: v.variationCount,
    customDistribution: v.customDistribution,
    images,
    ...(v.failedOrdinal !== undefined ? { failedOrdinal: v.failedOrdinal as number } : {})
  };
}
