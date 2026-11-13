// @ts-self-types="./catalog-global-images.d.ts"
import {
  isCatalogImageClassification,
  isR2CatalogImage,
  type CatalogImageClassification,
  type R2CatalogImage
} from './catalog-images.js';
import { isRecord } from './contract.js';

export const GLOBAL_CATALOG_IMAGE_CONTRACT_VERSION = 3;
export const GLOBAL_CATALOG_IMAGE_LIMITS = {
  urlCapacity: 200,
  informationalThreshold: 5000,
  batchRows: 400,
  statusPage: 100,
  defaultStatusPage: 50,
  readyAhead: 2,
  contentProofMs: 86_400_000,
  servingHealthMs: 120_000,
  probeIntervalMs: 60_000,
  allocationDeadlineMs: 1000,
  allocationLockMs: 50,
  allocationStatementMs: 750,
  retirementMs: 30 * 86_400_000,
  cursorMs: 60_000
} as const;

export const GLOBAL_CATALOG_IMAGE_ERROR_CODES = [
  'GLOBAL_IMAGE_POOL_UNAVAILABLE',
  'GLOBAL_IMAGE_READINESS_UNKNOWN',
  'GLOBAL_IMAGE_ALLOCATION_UNKNOWN',
  'GLOBAL_IMAGE_SETTINGS_RETIRED',
  'GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED',
  'GLOBAL_IMAGE_POLICY_CONFLICT',
  'GLOBAL_IMAGE_CLEANUP_UNKNOWN'
] as const;
export type GlobalCatalogImageErrorCode = (typeof GLOBAL_CATALOG_IMAGE_ERROR_CODES)[number];
export type GlobalImagePolicyState =
  'prepared' | 'draining' | 'active' | 'cleanup_due' | 'cleanup_running' | 'cleanup_complete';
export interface GlobalCatalogImage {
  kind: 'global';
  imageId: string;
  assignmentId: string;
  aliasId: string;
  publicUrl: string;
  generation: number;
  issuedSlot: string;
  policyEpoch: number;
  classification: CatalogImageClassification;
}
export type PublishedCatalogImage = R2CatalogImage | GlobalCatalogImage;
export interface GlobalImageReadiness {
  contractVersion: 3;
  policyEpoch: number;
  state: GlobalImagePolicyState;
  usable: boolean;
  reason: GlobalCatalogImageErrorCode | null;
  observedAt: string;
}
export interface GlobalImagePolicy {
  epoch: number;
  state: GlobalImagePolicyState;
  activatedAt: string | null;
  deleteAfter: string | null;
}

const MAX_COUNTER = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const isGlobalImageId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

export function globalImageGeneration(slot: bigint): number {
  if (slot < 1n || slot > MAX_COUNTER) throw new RangeError('Invalid image slot');
  const generation = (slot - 1n) / BigInt(GLOBAL_CATALOG_IMAGE_LIMITS.urlCapacity) + 1n;
  if (generation > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Image generation overflow');
  return Number(generation);
}

export function isGlobalImageCounter(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9][0-9]{0,18})$/u.test(value) &&
    BigInt(value) <= MAX_COUNTER
  );
}

export function isGlobalImagePublicUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/g\/[a-zA-Z0-9_-]{1,512}\.(?:jpg|png)$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isGlobalCatalogImage(value: unknown): value is GlobalCatalogImage {
  if (
    !isRecord(value) ||
    value.kind !== 'global' ||
    !isGlobalImageId(value.imageId) ||
    !isGlobalImageId(value.assignmentId) ||
    !isGlobalImageId(value.aliasId) ||
    !isGlobalImagePublicUrl(value.publicUrl) ||
    !isGlobalImageCounter(value.issuedSlot) ||
    value.issuedSlot === '0' ||
    !Number.isSafeInteger(value.generation) ||
    !Number.isSafeInteger(value.policyEpoch) ||
    typeof value.policyEpoch !== 'number' ||
    value.policyEpoch < 1 ||
    !isCatalogImageClassification(value.classification)
  )
    return false;
  try {
    return value.generation === globalImageGeneration(BigInt(value.issuedSlot));
  } catch {
    return false;
  }
}

export function isGlobalImageReadiness(value: unknown): value is GlobalImageReadiness {
  if (
    !isRecord(value) ||
    value.contractVersion !== 3 ||
    typeof value.policyEpoch !== 'number' ||
    !Number.isSafeInteger(value.policyEpoch) ||
    value.policyEpoch < 0 ||
    typeof value.state !== 'string' ||
    ![
      'prepared',
      'draining',
      'active',
      'cleanup_due',
      'cleanup_running',
      'cleanup_complete'
    ].includes(value.state) ||
    typeof value.usable !== 'boolean' ||
    !(
      value.reason === null || GLOBAL_CATALOG_IMAGE_ERROR_CODES.some(code => code === value.reason)
    ) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    return false;
  return (
    !value.usable ||
    (value.reason === null &&
      value.policyEpoch > 0 &&
      !['prepared', 'draining'].includes(value.state))
  );
}

export function isPublishedCatalogImage(value: unknown): value is PublishedCatalogImage {
  return isR2CatalogImage(value) || isGlobalCatalogImage(value);
}

export const GLOBAL_IMAGE_LIFECYCLE_STAGES = [
  'import_collecting',
  'import_sealed',
  'import_running',
  'import_completed',
  'import_partial',
  'import_failed',
  'import_cancelled',
  'import_unknown',
  'waiting_source',
  'staged',
  'validating',
  'publishing',
  'verifying',
  'ready',
  'reused',
  'failed',
  'cancelled',
  'unknown',
  'serving_probe',
  'allocated',
  'confirmed',
  'activated',
  'retirement_pending',
  'retirement_verified',
  'external_untouched'
] as const;
export type GlobalImageLifecycleStage = (typeof GLOBAL_IMAGE_LIFECYCLE_STAGES)[number];
export interface GlobalImageDiagnosticMetadata {
  flowId: string;
  attemptId?: string;
  catalogId?: string;
  imageId?: string;
  aliasId?: string;
  policyEpoch?: number;
  stage: GlobalImageLifecycleStage;
  code?: GlobalCatalogImageErrorCode;
  rows?: number;
}
/** Closed metadata only; never forward arbitrary objects, URLs or content. */
export function sanitizeGlobalImageMetadata(value: unknown): GlobalImageDiagnosticMetadata | null {
  if (
    !isRecord(value) ||
    !isGlobalImageId(value.flowId) ||
    !GLOBAL_IMAGE_LIFECYCLE_STAGES.some(stage => stage === value.stage)
  )
    return null;
  const result: GlobalImageDiagnosticMetadata = {
    flowId: value.flowId,
    stage: value.stage as GlobalImageLifecycleStage
  };
  for (const key of ['attemptId', 'catalogId', 'imageId', 'aliasId'] as const)
    if (isGlobalImageId(value[key])) result[key] = value[key];
  if (
    typeof value.policyEpoch === 'number' &&
    Number.isSafeInteger(value.policyEpoch) &&
    value.policyEpoch > 0
  )
    result.policyEpoch = value.policyEpoch;
  if (
    typeof value.rows === 'number' &&
    Number.isInteger(value.rows) &&
    value.rows >= 0 &&
    value.rows <= 400
  )
    result.rows = value.rows;
  if (GLOBAL_CATALOG_IMAGE_ERROR_CODES.some(code => code === value.code))
    result.code = value.code as GlobalCatalogImageErrorCode;
  return result;
}
