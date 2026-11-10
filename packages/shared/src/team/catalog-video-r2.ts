// @ts-self-types="./catalog-video-r2.d.ts"
import { isRecord } from './contract.js';

/**
 * Optional publication of a catalog's video to R2 (050).
 *
 * One vocabulary for the database, the edge function, the web client and the
 * analytics CLI. Everything here is a closed set: a code the reader does not
 * know is a defect of the sender, never something to display as prose.
 */
export const CATALOG_VIDEO_R2_CONTRACT_VERSION = 1;

export const CATALOG_VIDEO_R2_LIMITS = {
  /** S3 multipart minimum part size. */
  minPartBytes: 5 * 1024 * 1024,
  defaultPartBytes: 16 * 1024 * 1024,
  maxPartBytes: 64 * 1024 * 1024,
  maxParts: 10_000,
  maxObjectBytes: 2 * 1024 * 1024 * 1024,
  teamQuotaBytes: 50 * 1024 * 1024 * 1024,
  /** Window between the last use leaving a copy and its deletion. */
  graceSeconds: 6 * 3600,
  /** One edge invocation copies parts until this budget is spent, then yields the lease. */
  invocationBudgetMs: 60_000,
  leaseSeconds: 90
} as const;

/** Public R2 Standard list prices; an estimate for the owner, never an invoice. */
export const CATALOG_VIDEO_R2_COST_MODEL = {
  storageUsdPerGbMonth: 0.015,
  /** Class A/B operations and verification reads, as a share of storage. */
  operationsOverheadRatio: 0.2,
  averageVideoBytes: 100_000_000
} as const;

export const CATALOG_VIDEO_R2_ERROR_CODES = [
  'VIDEO_R2_DISABLED',
  'VIDEO_R2_POLICY_PENDING',
  'VIDEO_R2_NOT_CONFIGURED',
  'VIDEO_R2_SOURCE_UNAVAILABLE',
  'VIDEO_R2_UNSUPPORTED_FORMAT',
  'VIDEO_R2_QUOTA_EXCEEDED',
  'VIDEO_R2_PROVIDER_UNAVAILABLE',
  'VIDEO_R2_PROVIDER_RATE_LIMITED',
  'VIDEO_R2_TIMEOUT',
  'VIDEO_R2_UPLOAD_UNKNOWN',
  'VIDEO_R2_CHECKSUM_MISMATCH',
  'VIDEO_R2_PUBLIC_UNREACHABLE',
  'VIDEO_R2_CATALOG_WRITE_FAILED',
  'VIDEO_R2_CANCELED',
  'VIDEO_R2_INTERRUPTED',
  'VIDEO_R2_CLEANUP_PARTIAL'
] as const;
export type CatalogVideoR2ErrorCode = (typeof CATALOG_VIDEO_R2_ERROR_CODES)[number];

/**
 * Closed reasons as stored on a copy, in the catalog signal and in the journal:
 * the feature's own codes plus the three shared ones it reuses verbatim.
 */
export const CATALOG_VIDEO_R2_REASONS = [
  ...CATALOG_VIDEO_R2_ERROR_CODES,
  'PERMISSION_DENIED',
  'SOURCE_CHANGED',
  'TOO_LARGE'
] as const;
export type CatalogVideoR2Reason = (typeof CATALOG_VIDEO_R2_REASONS)[number];

export const CATALOG_VIDEO_R2_COPY_STATES = [
  'planned',
  'uploading',
  'verifying',
  'ready',
  'retiring',
  'deleted',
  'failed'
] as const;
export type CatalogVideoR2CopyState = (typeof CATALOG_VIDEO_R2_COPY_STATES)[number];

export const CATALOG_VIDEO_R2_LINK_KINDS = ['drive', 'r2'] as const;
export type CatalogVideoR2LinkKind = (typeof CATALOG_VIDEO_R2_LINK_KINDS)[number];

export const CATALOG_VIDEO_R2_PART_VERIFICATIONS = ['provider_checksum', 'readback'] as const;
export type CatalogVideoR2PartVerification = (typeof CATALOG_VIDEO_R2_PART_VERIFICATIONS)[number];

export const CATALOG_VIDEO_R2_WORKER_ROUTES = ['claim', 'sweep'] as const;
export type CatalogVideoR2WorkerRoute = (typeof CATALOG_VIDEO_R2_WORKER_ROUTES)[number];

/** Journal stages, in the order a healthy copy passes through them (AD-002). */
export const CATALOG_VIDEO_R2_STAGES = [
  'configured',
  'planned',
  'uploading',
  'part_verified',
  'verifying',
  'ready',
  'confirmed',
  'retiring',
  'deleted',
  'purged',
  'failed'
] as const;
export type CatalogVideoR2Stage = (typeof CATALOG_VIDEO_R2_STAGES)[number];

export const CATALOG_VIDEO_R2_PURGE_REASONS = [
  'replaced',
  'disabled',
  'source_removed',
  'catalog_deleted',
  'team_deleted',
  'failed_upload'
] as const;
export type CatalogVideoR2PurgeReason = (typeof CATALOG_VIDEO_R2_PURGE_REASONS)[number];

export type CatalogVideoR2AvailabilityReason = Extract<
  CatalogVideoR2ErrorCode,
  'VIDEO_R2_DISABLED' | 'VIDEO_R2_NOT_CONFIGURED' | 'VIDEO_R2_POLICY_PENDING'
>;
export interface CatalogVideoR2Availability {
  available: boolean;
  reason?: CatalogVideoR2AvailabilityReason;
  canManage: boolean;
  contractVersion: typeof CATALOG_VIDEO_R2_CONTRACT_VERSION;
}

export interface CatalogVideoR2CopySummary {
  state: CatalogVideoR2CopyState;
  readyAt: string | null;
  fullHashVerified: boolean;
}

/** What a member sees for one catalog: source of the issued link and why (FR-016). */
export interface CatalogVideoR2State {
  catalogMaterialId: string;
  enabled: boolean;
  link: CatalogVideoR2LinkKind;
  lastSuccessfulUpdateAt: string | null;
  copy: CatalogVideoR2CopySummary | null;
  reason: CatalogVideoR2Reason | null;
  usedBytes: number;
  quotaBytes: number;
  canManage: boolean;
  revision: number;
}

export interface CatalogVideoR2PreferenceReceipt {
  enabled: boolean;
  revision: number;
  updatedAt: string;
}

/** Space-level usage for the tariff page (SC-007). */
export interface CatalogVideoR2Usage {
  usedBytes: number;
  quotaBytes: number;
  readyCopies: number;
  retiringCopies: number;
  enabledCatalogs: number;
}

const boundedInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const short = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255;
const timestamp = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)));
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (values as readonly string[]).includes(v);

export const isCatalogVideoR2ErrorCode = oneOf(CATALOG_VIDEO_R2_ERROR_CODES);
export const isCatalogVideoR2Reason = oneOf(CATALOG_VIDEO_R2_REASONS);
export const isCatalogVideoR2CopyState = oneOf(CATALOG_VIDEO_R2_COPY_STATES);
export const isCatalogVideoR2LinkKind = oneOf(CATALOG_VIDEO_R2_LINK_KINDS);
export const isCatalogVideoR2PartVerification = oneOf(CATALOG_VIDEO_R2_PART_VERIFICATIONS);
export const isCatalogVideoR2Stage = oneOf(CATALOG_VIDEO_R2_STAGES);
export const isCatalogVideoR2PurgeReason = oneOf(CATALOG_VIDEO_R2_PURGE_REASONS);

export function parseCatalogVideoR2WorkerRoute(value: unknown): CatalogVideoR2WorkerRoute | null {
  if (!isRecord(value)) return null;
  const route = value.route;
  return typeof route === 'string' &&
    (CATALOG_VIDEO_R2_WORKER_ROUTES as readonly string[]).includes(route)
    ? (route as CatalogVideoR2WorkerRoute)
    : null;
}

export function isCatalogVideoR2Availability(v: unknown): v is CatalogVideoR2Availability {
  if (
    !isRecord(v) ||
    typeof v.available !== 'boolean' ||
    typeof v.canManage !== 'boolean' ||
    v.contractVersion !== CATALOG_VIDEO_R2_CONTRACT_VERSION
  )
    return false;
  if (v.available) return v.reason === undefined;
  return (
    v.reason === 'VIDEO_R2_DISABLED' ||
    v.reason === 'VIDEO_R2_NOT_CONFIGURED' ||
    v.reason === 'VIDEO_R2_POLICY_PENDING'
  );
}

export function isCatalogVideoR2CopySummary(v: unknown): v is CatalogVideoR2CopySummary {
  return (
    isRecord(v) &&
    isCatalogVideoR2CopyState(v.state) &&
    timestamp(v.readyAt) &&
    typeof v.fullHashVerified === 'boolean'
  );
}

export function isCatalogVideoR2State(v: unknown): v is CatalogVideoR2State {
  return (
    isRecord(v) &&
    short(v.catalogMaterialId) &&
    typeof v.enabled === 'boolean' &&
    isCatalogVideoR2LinkKind(v.link) &&
    timestamp(v.lastSuccessfulUpdateAt) &&
    (v.copy === null || isCatalogVideoR2CopySummary(v.copy)) &&
    (v.reason === null || isCatalogVideoR2Reason(v.reason)) &&
    boundedInteger(v.usedBytes) &&
    boundedInteger(v.quotaBytes) &&
    typeof v.canManage === 'boolean' &&
    boundedInteger(v.revision)
  );
}

export function isCatalogVideoR2PreferenceReceipt(
  v: unknown
): v is CatalogVideoR2PreferenceReceipt {
  return (
    isRecord(v) &&
    typeof v.enabled === 'boolean' &&
    boundedInteger(v.revision) &&
    typeof v.updatedAt === 'string' &&
    timestamp(v.updatedAt)
  );
}

export function isCatalogVideoR2Usage(v: unknown): v is CatalogVideoR2Usage {
  return (
    isRecord(v) &&
    boundedInteger(v.usedBytes) &&
    boundedInteger(v.quotaBytes) &&
    boundedInteger(v.readyCopies) &&
    boundedInteger(v.retiringCopies) &&
    boundedInteger(v.enabledCatalogs)
  );
}

/**
 * A public video URL as the catalog may carry it: HTTPS, no credentials, no
 * query, no fragment, an opaque `/v/<32 hex>.mp4` path. Anything else is not
 * one of ours and must never be written into a catalog cell as R2.
 */
export function isCatalogVideoR2PublicUrl(value: unknown, origin?: string): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/v\/[0-9a-f]{32}\.mp4$/u.test(url.pathname) &&
    (origin === undefined || url.origin === origin)
  );
}

/** Monthly cost range in USD for the given stored bytes; `null` when nothing is stored. */
export function estimateCatalogVideoR2MonthlyUsd(
  usedBytes: number
): { low: number; high: number } | null {
  if (!boundedInteger(usedBytes) || usedBytes === 0) return null;
  const storage = (usedBytes / 1_000_000_000) * CATALOG_VIDEO_R2_COST_MODEL.storageUsdPerGbMonth;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    low: round(storage),
    high: round(storage * (1 + CATALOG_VIDEO_R2_COST_MODEL.operationsOverheadRatio))
  };
}
