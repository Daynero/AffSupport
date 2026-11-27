// @ts-self-types="./space-storage.d.ts"
import { isRecord } from './contract.js';

/**
 * Soty spaces on R2 (057): one vocabulary for the database, the `space-storage`
 * edge function, the `space-read` Worker, the web client, the agent and the
 * analytics CLI (contracts/storage-api.md, data-model.md M1).
 *
 * Every set here is closed. A value the reader does not know is a defect of the
 * sender and parses as a failure, never as something to show. Byte counts cross
 * JSON as decimal strings and are read as `bigint`, so nothing loses precision
 * above 2^53.
 */
export const SPACE_STORAGE_CONTRACT_VERSION = 1;

/** The capability a client declares in `x-soty-capabilities` before any R2 route answers it. */
export const SPACE_STORAGE_CAPABILITY = 'storage-r2/1';
export const SPACE_STORAGE_CAPABILITY_HEADER = 'x-soty-capabilities';

export const STORAGE_BACKENDS = ['drive', 'r2'] as const;
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/** Published limits (FR-017). One place, read by every side. */
export const SPACE_STORAGE_LIMITS = {
  maxObjectBytes: 100 * GIB,
  /** S3 multipart minimum for every part but the last. */
  minPartBytes: 5 * MIB,
  defaultPartBytes: 16 * MIB,
  largePartBytes: 64 * MIB,
  /** A file strictly larger than this uses `largePartBytes`. */
  largeFileThresholdBytes: 50 * GIB,
  maxParts: 10_000,
  browserParallelParts: 8,
  agentParallelParts: 4,
  /** Signed part URLs per `/uploads/{id}/parts` call. */
  partUrlBatch: 100,
  partUrlTtlSeconds: 600,
  maxMaterialsPerSpace: 100_000,
  readGrantTtlSeconds: 600,
  /** How long the Worker may trust a cached `access_epoch` (R4). */
  epochCacheSeconds: 30,
  maxNameLength: 1024
} as const;

// States -----------------------------------------------------------------------------------

export const SPACE_UPLOAD_STATES = [
  'open',
  'completing',
  'committed',
  'aborted',
  'expired',
  'rejected'
] as const;
export type SpaceUploadState = (typeof SPACE_UPLOAD_STATES)[number];

export const SPACE_RESERVATION_STATES = ['reserved', 'committed', 'released', 'uncertain'] as const;
export type SpaceReservationState = (typeof SPACE_RESERVATION_STATES)[number];

export const SPACE_RESERVATION_PURPOSES = [
  'upload',
  'process_output',
  'catalog_generation'
] as const;
export type SpaceReservationPurpose = (typeof SPACE_RESERVATION_PURPOSES)[number];

export const SPACE_OBJECT_STATES = ['committed', 'purge_pending', 'purged'] as const;
export type SpaceObjectState = (typeof SPACE_OBJECT_STATES)[number];

/** A derivative declared with an upload. */
export const SPACE_UPLOAD_DERIVATIVE_STATES = ['declared', 'accepted', 'rejected'] as const;
export type SpaceUploadDerivativeState = (typeof SPACE_UPLOAD_DERIVATIVE_STATES)[number];

/** Agent backfill of a derivative the uploading client could not make (R5). */
export const SPACE_DERIVATIVE_JOB_STATES = [
  'pending_agent',
  'claimed',
  'ready',
  'unsupported',
  'failed'
] as const;
export type SpaceDerivativeJobState = (typeof SPACE_DERIVATIVE_JOB_STATES)[number];

export const SPACE_DERIVATIVE_JOB_REASONS = [
  'browser_unsupported',
  'missing_media_facts',
  'client_skipped'
] as const;
export type SpaceDerivativeJobReason = (typeof SPACE_DERIVATIVE_JOB_REASONS)[number];

/** Deletion of an object from the bucket (FR-048). */
export const SPACE_PURGE_STATES = ['due', 'deleted', 'failed'] as const;
export type SpacePurgeState = (typeof SPACE_PURGE_STATES)[number];

export const SPACE_PURGE_REASONS = [
  'trash_expired',
  'trash_emptied',
  'catalog_deleted',
  'space_deleted',
  'orphan'
] as const;
export type SpacePurgeReason = (typeof SPACE_PURGE_REASONS)[number];

export const SPACE_RECONCILIATION_STATES = ['running', 'done', 'failed'] as const;
export type SpaceReconciliationState = (typeof SPACE_RECONCILIATION_STATES)[number];

// Accounting -------------------------------------------------------------------------------

/**
 * Usage categories in priority order: an object referenced several times counts
 * once, in the first category of this list that references it (FR-047).
 */
export const SPACE_STORAGE_CATEGORIES = [
  'materials',
  'catalogs',
  'process',
  'attachments',
  'versions',
  'trash'
] as const;
export type SpaceStorageCategory = (typeof SPACE_STORAGE_CATEGORIES)[number];

/** Who owns a reference to an object. `derivative` references are never counted. */
export const SPACE_REF_OWNER_KINDS = [
  'material',
  'task_attachment',
  'process_output',
  'derivative'
] as const;
export type SpaceRefOwnerKind = (typeof SPACE_REF_OWNER_KINDS)[number];

/** Where an upload entered the space. */
export const SPACE_INGRESS = [
  'explorer',
  'agent_output',
  'inbox',
  'mobile',
  'share_target'
] as const;
export type SpaceIngress = (typeof SPACE_INGRESS)[number];

export const SPACE_SIGNAL_KINDS = ['content', 'usage', 'derivative'] as const;
export type SpaceSignalKind = (typeof SPACE_SIGNAL_KINDS)[number];

// Derivatives ------------------------------------------------------------------------------

export const SPACE_DERIVATIVE_RECIPE_VERSION = 1;
export const SPACE_DERIVATIVE_TYPES = ['image/webp', 'image/jpeg'] as const;
export type SpaceDerivativeType = (typeof SPACE_DERIVATIVE_TYPES)[number];

/**
 * Explorer derivatives the uploading client makes (R5) and their published
 * bounds: the server checks type by magic bytes, bytes and header dimensions
 * against these and drops a derivative that does not fit.
 */
export const SPACE_DERIVATIVE_VARIANTS = {
  row: { maxWidth: 160, maxHeight: 160, maxBytes: 64 * 1024 },
  tile: { maxWidth: 480, maxHeight: 480, maxBytes: 256 * 1024 },
  full: { maxWidth: 1600, maxHeight: 1600, maxBytes: 1536 * 1024 },
  poster: { maxWidth: 1280, maxHeight: 1280, maxBytes: MIB },
  /** Hover frames of a video, several frames in one image. */
  sprite: { maxWidth: 4096, maxHeight: 4096, maxBytes: 2 * MIB }
} as const;
export type SpaceDerivativeVariant = keyof typeof SPACE_DERIVATIVE_VARIANTS;
export const SPACE_DERIVATIVE_VARIANT_NAMES = Object.keys(
  SPACE_DERIVATIVE_VARIANTS
) as readonly SpaceDerivativeVariant[];

// Codes ------------------------------------------------------------------------------------

/**
 * 057 failure codes (contracts/storage-api.md «Коди»), seeded additively by
 * `20261226100000_space_storage_error_codes.sql` in this order.
 */
export const SPACE_STORAGE_ERROR_CODES = [
  'STORAGE_BACKEND_MISMATCH',
  'R2_PILOT_REQUIRED',
  'CLIENT_UPDATE_REQUIRED',
  'STORAGE_QUOTA_EXCEEDED',
  'STORAGE_OBJECT_TOO_LARGE',
  'REVISION_CONFLICT',
  'UPLOAD_EXPIRED',
  'CHECKSUM_MISMATCH',
  'SPACE_ARCHIVED',
  'SHARE_LINK_EXPIRED',
  'SHARE_LINK_LIMIT'
] as const;
export type SpaceStorageErrorCode = (typeof SPACE_STORAGE_ERROR_CODES)[number];

/** HTTP status of each code, by the contract's rule: 403 rights/archive/pilot, 409 state, 413 size. */
export const SPACE_STORAGE_ERROR_STATUS: Readonly<Record<SpaceStorageErrorCode, number>> = {
  STORAGE_BACKEND_MISMATCH: 409,
  R2_PILOT_REQUIRED: 403,
  CLIENT_UPDATE_REQUIRED: 409,
  STORAGE_QUOTA_EXCEEDED: 409,
  STORAGE_OBJECT_TOO_LARGE: 413,
  REVISION_CONFLICT: 409,
  UPLOAD_EXPIRED: 409,
  CHECKSUM_MISMATCH: 409,
  SPACE_ARCHIVED: 403,
  SHARE_LINK_EXPIRED: 410,
  SHARE_LINK_LIMIT: 429
};

/** Journal vocabulary for `private.space_storage_journal` (T011). */
export const SPACE_STORAGE_JOURNAL_STAGES = [
  'create',
  'admit',
  'parts',
  'complete',
  'commit',
  'abort',
  'mutate',
  'trash_empty',
  'read_grant',
  'derivative',
  'purge',
  'reconcile'
] as const;
export type SpaceStorageJournalStage = (typeof SPACE_STORAGE_JOURNAL_STAGES)[number];

export const SPACE_STORAGE_JOURNAL_OUTCOMES = ['ok', 'rejected', 'failed', 'unknown'] as const;
export type SpaceStorageJournalOutcome = (typeof SPACE_STORAGE_JOURNAL_OUTCOMES)[number];

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);

export const isStorageBackend = oneOf(STORAGE_BACKENDS);
export const isSpaceStorageErrorCode = oneOf(SPACE_STORAGE_ERROR_CODES);
export const isSpaceUploadState = oneOf(SPACE_UPLOAD_STATES);
export const isSpaceReservationState = oneOf(SPACE_RESERVATION_STATES);
export const isSpaceObjectState = oneOf(SPACE_OBJECT_STATES);
export const isSpaceDerivativeJobState = oneOf(SPACE_DERIVATIVE_JOB_STATES);
export const isSpacePurgeReason = oneOf(SPACE_PURGE_REASONS);
export const isSpaceStorageCategory = oneOf(SPACE_STORAGE_CATEGORIES);
export const isSpaceRefOwnerKind = oneOf(SPACE_REF_OWNER_KINDS);
export const isSpaceIngress = oneOf(SPACE_INGRESS);
export const isSpaceSignalKind = oneOf(SPACE_SIGNAL_KINDS);
export const isSpaceDerivativeType = oneOf(SPACE_DERIVATIVE_TYPES);
export const isSpaceDerivativeVariant = oneOf(SPACE_DERIVATIVE_VARIANT_NAMES);
export const isSpaceStorageJournalStage = oneOf(SPACE_STORAGE_JOURNAL_STAGES);
export const isSpaceStorageJournalOutcome = oneOf(SPACE_STORAGE_JOURNAL_OUTCOMES);

/** Does a request's `x-soty-capabilities` header declare `storage-r2/1`? */
export function declaresSpaceStorage(header: string | null | undefined): boolean {
  if (typeof header !== 'string' || header.length > 1024) return false;
  return header
    .split(',')
    .map(item => item.trim())
    .includes(SPACE_STORAGE_CAPABILITY);
}

// Bytes ------------------------------------------------------------------------------------

const BIGINT_MAX = 9_223_372_036_854_775_807n;

/** A byte count as JSON carries it: a decimal string, no sign, no leading zero, ≤ Postgres bigint. */
export function parseByteCount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= BIGINT_MAX ? parsed : null;
}

export function formatByteCount(value: bigint): string {
  if (value < 0n || value > BIGINT_MAX) throw new RangeError('Byte count out of range');
  return value.toString(10);
}

// Content identity (research.md R3, 2026-11-28) ---------------------------------------------

/** Part size follows from the file size alone, so every side derives the same parts. */
export function spacePartBytes(totalBytes: number): number {
  if (!isObjectSize(totalBytes)) throw new RangeError('Object size out of range');
  return totalBytes > SPACE_STORAGE_LIMITS.largeFileThresholdBytes
    ? SPACE_STORAGE_LIMITS.largePartBytes
    : SPACE_STORAGE_LIMITS.defaultPartBytes;
}

/** An empty file is still one (empty) part. */
export function spacePartCount(totalBytes: number): number {
  const part = spacePartBytes(totalBytes);
  return Math.max(1, Math.ceil(totalBytes / part));
}

/** Inclusive byte range of one part (1-based), as a Range header or a file slice needs it. */
export function spacePartRange(
  totalBytes: number,
  partNumber: number
): { start: number; end: number; bytes: number } {
  const count = spacePartCount(totalBytes);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count)
    throw new RangeError('Part number out of range');
  const part = spacePartBytes(totalBytes);
  const start = (partNumber - 1) * part;
  const bytes = Math.min(part, totalBytes - start);
  return { start, end: start + bytes - 1, bytes };
}

function isObjectSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= SPACE_STORAGE_LIMITS.maxObjectBytes;
}

/**
 * One part ETag as R2 reports it (quoted or bare) → 32 lowercase hex, the part's
 * MD5. A multipart object ETag (`…-N`) or anything else is not a part ETag.
 */
export function normalizePartEtag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bare = /^"([0-9a-fA-F]{32})"$/u.exec(value)?.[1] ?? /^([0-9a-fA-F]{32})$/u.exec(value)?.[1];
  return bare ? bare.toLowerCase() : null;
}

export const SPACE_CONTENT_ID_SCHEME = 'soty-space-content/1';
export const SPACE_CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/u;
export const isSpaceContentId = (value: unknown): value is string =>
  typeof value === 'string' && SPACE_CONTENT_ID_PATTERN.test(value);

export type SpaceContentIdResult =
  { ok: true; contentId: string } | { ok: false; reason: 'size' | 'part_count' | 'etag' };

/**
 * `content_id` = SHA-256 over the scheme, the part size, the total length and
 * the ordered part ETags (MD5 computed by R2 from the bytes it received). The
 * client computes it before uploading; the server recomputes it from R2's
 * `ListParts` and never from what the client sent. Dedup holds within one
 * space only (FR-016).
 */
export async function spaceContentId(
  totalBytes: number,
  partEtags: readonly string[],
  subtle: SubtleCrypto = crypto.subtle
): Promise<SpaceContentIdResult> {
  if (!isObjectSize(totalBytes)) return { ok: false, reason: 'size' };
  if (partEtags.length !== spacePartCount(totalBytes)) return { ok: false, reason: 'part_count' };
  const etags: string[] = [];
  for (const raw of partEtags) {
    const etag = normalizePartEtag(raw);
    if (!etag) return { ok: false, reason: 'etag' };
    etags.push(etag);
  }
  const canonical = [
    SPACE_CONTENT_ID_SCHEME,
    String(spacePartBytes(totalBytes)),
    String(totalBytes),
    ...etags
  ].join('\n');
  const digest = new Uint8Array(
    await subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  );
  return {
    ok: true,
    contentId: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
  };
}

// Keys -------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const isSpaceUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

/** Staging multipart key (data-model «Ключі R2»). */
export function spaceStagingKey(teamId: string, uploadId: string): string {
  if (!isSpaceUuid(teamId) || !isSpaceUuid(uploadId)) throw new TypeError('Invalid key part');
  return `t/${teamId}/u/${uploadId}`;
}

export function spaceObjectKey(teamId: string, contentId: string): string {
  if (!isSpaceUuid(teamId) || !isSpaceContentId(contentId)) throw new TypeError('Invalid key part');
  return `t/${teamId}/o/${contentId}`;
}

export function spaceDerivativeKey(
  teamId: string,
  contentId: string,
  recipeVersion: number,
  variant: SpaceDerivativeVariant
): string {
  if (
    !isSpaceUuid(teamId) ||
    !isSpaceContentId(contentId) ||
    !Number.isSafeInteger(recipeVersion) ||
    recipeVersion < 1 ||
    !isSpaceDerivativeVariant(variant)
  )
    throw new TypeError('Invalid key part');
  return `t/${teamId}/d/${contentId}/${recipeVersion}/${variant}`;
}

export const SPACE_KEY_PATTERN =
  /^t\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:u\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|o\/[0-9a-f]{64}|d\/[0-9a-f]{64}\/[1-9][0-9]{0,3}\/(?:row|tile|full|poster|sprite))$/u;
export const isSpaceKey = (value: unknown): value is string =>
  typeof value === 'string' && SPACE_KEY_PATTERN.test(value);

// Responses --------------------------------------------------------------------------------

export type SpaceParsed<T> = { ok: true; value: T } | { ok: false };
const fail = { ok: false } as const;
const okValue = <T>(value: T): SpaceParsed<T> => ({ ok: true, value });

const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
};

export interface SpaceCreated {
  teamId: string;
  rootMaterialId: string;
  storageBackend: 'r2';
}

export function parseSpaceCreated(value: unknown): SpaceParsed<SpaceCreated> {
  if (
    !isRecord(value) ||
    !isSpaceUuid(value.teamId) ||
    !isSpaceUuid(value.rootMaterialId) ||
    value.storageBackend !== 'r2'
  )
    return fail;
  return okValue({
    teamId: value.teamId,
    rootMaterialId: value.rootMaterialId,
    storageBackend: 'r2'
  });
}

export type SpaceAdmitResult =
  | { kind: 'exists'; materialId: string }
  | {
      kind: 'session';
      uploadId: string;
      partBytes: number;
      partCount: number;
      derivativeSlots: SpaceDerivativeVariant[];
      expiresAt: string;
    };

export function parseSpaceAdmitResult(value: unknown): SpaceParsed<SpaceAdmitResult> {
  if (!isRecord(value)) return fail;
  if (value.kind === 'exists')
    return isSpaceUuid(value.materialId)
      ? okValue({ kind: 'exists', materialId: value.materialId })
      : fail;
  if (value.kind !== 'session') return fail;
  const slots = value.derivativeSlots;
  if (
    !isSpaceUuid(value.uploadId) ||
    (value.partBytes !== SPACE_STORAGE_LIMITS.defaultPartBytes &&
      value.partBytes !== SPACE_STORAGE_LIMITS.largePartBytes) ||
    !count(value.partCount, SPACE_STORAGE_LIMITS.maxParts) ||
    value.partCount < 1 ||
    !Array.isArray(slots) ||
    slots.length > SPACE_DERIVATIVE_VARIANT_NAMES.length ||
    !slots.every(isSpaceDerivativeVariant) ||
    new Set(slots).size !== slots.length ||
    !timestamp(value.expiresAt)
  )
    return fail;
  return okValue({
    kind: 'session',
    uploadId: value.uploadId,
    partBytes: value.partBytes,
    partCount: value.partCount,
    derivativeSlots: [...slots],
    expiresAt: value.expiresAt
  });
}

export interface SpacePartUrl {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export function parseSpacePartUrls(value: unknown): SpaceParsed<SpacePartUrl[]> {
  if (!isRecord(value) || !Array.isArray(value.parts)) return fail;
  if (value.parts.length < 1 || value.parts.length > SPACE_STORAGE_LIMITS.partUrlBatch) return fail;
  const parts: SpacePartUrl[] = [];
  for (const part of value.parts) {
    if (
      !isRecord(part) ||
      !count(part.partNumber, SPACE_STORAGE_LIMITS.maxParts) ||
      part.partNumber < 1 ||
      !httpsUrl(part.url) ||
      !timestamp(part.expiresAt)
    )
      return fail;
    parts.push({ partNumber: part.partNumber, url: part.url, expiresAt: part.expiresAt });
  }
  return new Set(parts.map(part => part.partNumber)).size === parts.length ? okValue(parts) : fail;
}

export interface SpaceReadGrantResult {
  grant: string;
  expiresAt: string;
  filesOrigin: string;
}

export function parseSpaceReadGrantResult(value: unknown): SpaceParsed<SpaceReadGrantResult> {
  if (
    !isRecord(value) ||
    typeof value.grant !== 'string' ||
    !/^[A-Za-z0-9_-]{16,256}$/u.test(value.grant) ||
    !timestamp(value.expiresAt) ||
    !httpsUrl(value.filesOrigin) ||
    new URL(value.filesOrigin).origin !== value.filesOrigin
  )
    return fail;
  return okValue({
    grant: value.grant,
    expiresAt: value.expiresAt,
    filesOrigin: value.filesOrigin
  });
}

export interface SpaceStorageSegment {
  category: SpaceStorageCategory;
  bytes: bigint;
  objects: number;
  sharedBytes: bigint;
}

export interface SpaceStorageSummary {
  capacityBytes: bigint;
  usedBytes: bigint;
  reservedBytes: bigint;
  segments: SpaceStorageSegment[];
  revision: number;
}

/** `get_space_storage_summary`: the segments must add up to `usedBytes`, each category once. */
export function parseSpaceStorageSummary(value: unknown): SpaceParsed<SpaceStorageSummary> {
  if (!isRecord(value) || !Array.isArray(value.segments)) return fail;
  const capacityBytes = parseByteCount(value.capacityBytes);
  const usedBytes = parseByteCount(value.usedBytes);
  const reservedBytes = parseByteCount(value.reservedBytes);
  if (capacityBytes === null || usedBytes === null || reservedBytes === null) return fail;
  if (!count(value.revision)) return fail;
  const segments: SpaceStorageSegment[] = [];
  for (const segment of value.segments) {
    if (!isRecord(segment) || !isSpaceStorageCategory(segment.category) || !count(segment.objects))
      return fail;
    const bytes = parseByteCount(segment.bytes);
    const sharedBytes = parseByteCount(segment.sharedBytes);
    if (bytes === null || sharedBytes === null || sharedBytes > bytes) return fail;
    segments.push({ category: segment.category, bytes, objects: segment.objects, sharedBytes });
  }
  if (new Set(segments.map(segment => segment.category)).size !== segments.length) return fail;
  if (segments.reduce((sum, segment) => sum + segment.bytes, 0n) !== usedBytes) return fail;
  return okValue({ capacityBytes, usedBytes, reservedBytes, segments, revision: value.revision });
}

/** `STORAGE_QUOTA_EXCEEDED` details: how much the upload needs and how much is free. */
export function parseSpaceQuotaDetails(
  value: unknown
): SpaceParsed<{ needBytes: bigint; freeBytes: bigint }> {
  if (!isRecord(value)) return fail;
  const needBytes = parseByteCount(value.needBytes);
  const freeBytes = parseByteCount(value.freeBytes);
  return needBytes === null || freeBytes === null ? fail : okValue({ needBytes, freeBytes });
}
