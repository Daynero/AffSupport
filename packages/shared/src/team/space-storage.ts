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
  'SHARE_LINK_LIMIT',
  /** The bucket did not answer or refused for a reason that is not the caller's. Retryable. */
  'STORAGE_UNAVAILABLE'
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
  SHARE_LINK_LIMIT: 429,
  STORAGE_UNAVAILABLE: 503
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

/**
 * A derivative staged under an upload (or an agent's derivative claim) before the server checked
 * it (T047). Staging keys are never readable through the files host.
 */
export function spaceStagingDerivativeKey(
  teamId: string,
  stagingId: string,
  variant: SpaceDerivativeVariant
): string {
  if (!isSpaceDerivativeVariant(variant)) throw new TypeError('Invalid key part');
  return `${spaceStagingKey(teamId, stagingId)}/${variant}`;
}

export const SPACE_KEY_PATTERN =
  /^t\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:u\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/(?:row|tile|full|poster|sprite))?|o\/[0-9a-f]{64}|d\/[0-9a-f]{64}\/[1-9][0-9]{0,3}\/(?:row|tile|full|poster|sprite))$/u;
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
  /** Where reads go: the files host's origin, or on beta the local read route (see below). */
  filesOrigin: string;
}

/**
 * The read route of `space-storage` for beta and dev, where the Supabase API listens only on
 * loopback and the `space-read` Worker cannot reach it. The server hands it out in place of
 * the files host only under a non-production config; a client accepts it only when it says so.
 */
export const SPACE_LOCAL_FILES_PATH = '/functions/v1/space-storage/files';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A base that space read URLs are built on: the files host (an exact `https:` origin), or —
 * only with `allowLocalRoute` — `<API origin>/functions/v1/space-storage/files`, where the
 * origin is `https:` or loopback `http:`. Nothing else: no credentials, query or fragment.
 */
export function isSpaceFilesBase(
  value: unknown,
  options: { allowLocalRoute?: boolean } = {}
): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:' && url.origin === value) return true;
  if (options.allowLocalRoute !== true) return false;
  const local =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  return local && value === `${url.origin}${SPACE_LOCAL_FILES_PATH}`;
}

export function parseSpaceReadGrantResult(
  value: unknown,
  options: { allowLocalRoute?: boolean } = {}
): SpaceParsed<SpaceReadGrantResult> {
  if (
    !isRecord(value) ||
    typeof value.grant !== 'string' ||
    !/^[A-Za-z0-9_-]{16,256}$/u.test(value.grant) ||
    !timestamp(value.expiresAt) ||
    !isSpaceFilesBase(value.filesOrigin, options)
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
  /**
   * Pictures of the platform's pool the space's catalogs show (052, T053): shown beside the
   * scale, never part of `usedBytes` — the space neither stores nor frees them. Zero when absent.
   */
  poolBytes: bigint;
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
  const poolBytes = value.poolBytes === undefined ? 0n : parseByteCount(value.poolBytes);
  if (poolBytes === null) return fail;
  return okValue({
    capacityBytes,
    usedBytes,
    reservedBytes,
    segments,
    revision: value.revision,
    poolBytes
  });
}

/**
 * How full a space is, as the scale and every place that adds bytes say it (US9.4): a warning
 * from 80 %, a stronger one from 95 %, and full at 100 % — reserved bytes included, because they
 * are already promised to an upload or a generation under way.
 */
export type SpaceStorageLevel = 'ok' | 'warning' | 'critical' | 'full';
export const SPACE_STORAGE_THRESHOLDS = { warning: 0.8, critical: 0.95 } as const;

export function spaceStorageLevel(input: {
  usedBytes: bigint;
  reservedBytes: bigint;
  capacityBytes: bigint;
  /** What the action about to run would add. */
  addBytes?: bigint;
}): SpaceStorageLevel {
  if (input.capacityBytes <= 0n) return 'full';
  const taken = input.usedBytes + input.reservedBytes + (input.addBytes ?? 0n);
  if (taken >= input.capacityBytes) return 'full';
  // Integer arithmetic: a share of a bigint, compared in thousandths.
  const permille = (taken * 1000n) / input.capacityBytes;
  if (permille >= BigInt(Math.round(SPACE_STORAGE_THRESHOLDS.critical * 1000))) return 'critical';
  if (permille >= BigInt(Math.round(SPACE_STORAGE_THRESHOLDS.warning * 1000))) return 'warning';
  return 'ok';
}

/** One thing of a category, as `list_space_storage_items` lists it (US9.2). */
export interface SpaceStorageItem {
  kind: 'file' | 'catalog' | 'library';
  /** The material (a file, or a catalog's companion); null for the library. */
  id: string | null;
  name: string | null;
  bytes: bigint;
  /** What stays when this thing is deleted (another reference, catalog, the library). */
  sharedBytes: bigint;
  /** Exactly what deleting it gives back. */
  freedBytes: bigint;
  authorId: string | null;
  authorName: string | null;
  at: string | null;
  parentFolderId: string | null;
  materialKind: string | null;
  mimeType: string | null;
  trashed: boolean;
}

export interface SpaceStorageItemsPage {
  category: SpaceStorageCategory;
  items: SpaceStorageItem[];
  total: number;
  nextCursor: string | null;
}

export const SPACE_STORAGE_ITEM_SORTS = ['size', 'date', 'author'] as const;
export type SpaceStorageItemSort = (typeof SPACE_STORAGE_ITEM_SORTS)[number];

const nullableText = (value: unknown, max = 1024): value is string | null =>
  value === null || value === undefined || (typeof value === 'string' && value.length <= max);

function parseSpaceStorageItem(value: unknown): SpaceStorageItem | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'file' && value.kind !== 'catalog' && value.kind !== 'library') return null;
  const bytes = parseByteCount(value.bytes);
  const sharedBytes = parseByteCount(value.sharedBytes);
  const freedBytes = parseByteCount(value.freedBytes);
  if (bytes === null || sharedBytes === null || freedBytes === null) return null;
  if (sharedBytes > bytes || freedBytes > bytes) return null;
  const id = value.id ?? null;
  if (id !== null && !isSpaceUuid(id)) return null;
  if (value.kind !== 'library' && id === null) return null;
  const authorId = value.authorId ?? null;
  if (authorId !== null && !isSpaceUuid(authorId)) return null;
  if (
    !nullableText(value.name) ||
    !nullableText(value.authorName, 240) ||
    !nullableText(value.parentFolderId, 128) ||
    !nullableText(value.materialKind, 64) ||
    !nullableText(value.mimeType, 255) ||
    (value.at !== null && value.at !== undefined && !timestamp(value.at)) ||
    (value.trashed !== undefined && typeof value.trashed !== 'boolean')
  )
    return null;
  return {
    kind: value.kind,
    id,
    name: (value.name as string | null | undefined) ?? null,
    bytes,
    sharedBytes,
    freedBytes,
    authorId,
    authorName: (value.authorName as string | null | undefined) ?? null,
    at: (value.at as string | null | undefined) ?? null,
    parentFolderId: (value.parentFolderId as string | null | undefined) ?? null,
    materialKind: (value.materialKind as string | null | undefined) ?? null,
    mimeType: (value.mimeType as string | null | undefined) ?? null,
    trashed: value.trashed === true
  };
}

export function parseSpaceStorageItemsPage(value: unknown): SpaceParsed<SpaceStorageItemsPage> {
  if (
    !isRecord(value) ||
    !isSpaceStorageCategory(value.category) ||
    !Array.isArray(value.items) ||
    !count(value.total) ||
    !(
      value.nextCursor === null ||
      value.nextCursor === undefined ||
      (typeof value.nextCursor === 'string' && /^[0-9]{1,6}$/u.test(value.nextCursor))
    )
  )
    return fail;
  const items: SpaceStorageItem[] = [];
  for (const item of value.items) {
    const parsed = parseSpaceStorageItem(item);
    if (!parsed) return fail;
    items.push(parsed);
  }
  return okValue({
    category: value.category,
    items,
    total: value.total,
    nextCursor: (value.nextCursor as string | null | undefined) ?? null
  });
}

export const CATALOG_STORAGE_PARTS = ['feed', 'videos', 'variations', 'pictures', 'pool'] as const;
export type CatalogStoragePart = (typeof CATALOG_STORAGE_PARTS)[number];

/** `get_catalog_storage_breakdown` (US9.3): what it takes, what stays, what deleting it frees. */
export interface CatalogStorageBreakdown {
  catalogId: string;
  totalBytes: bigint;
  sharedBytes: bigint;
  freedBytes: bigint;
  parts: { kind: CatalogStoragePart; bytes: bigint; sharedBytes: bigint; count: number }[];
}

export function parseCatalogStorageBreakdown(value: unknown): SpaceParsed<CatalogStorageBreakdown> {
  if (!isRecord(value) || !isSpaceUuid(value.catalogId) || !Array.isArray(value.parts)) return fail;
  const totalBytes = parseByteCount(value.totalBytes);
  const sharedBytes = parseByteCount(value.sharedBytes);
  const freedBytes = parseByteCount(value.freedBytes);
  if (totalBytes === null || sharedBytes === null || freedBytes === null) return fail;
  if (sharedBytes + freedBytes !== totalBytes) return fail;
  const parts: CatalogStorageBreakdown['parts'] = [];
  for (const part of value.parts) {
    if (
      !isRecord(part) ||
      !(CATALOG_STORAGE_PARTS as readonly unknown[]).includes(part.kind) ||
      !count(part.count)
    )
      return fail;
    const bytes = parseByteCount(part.bytes);
    const shared = parseByteCount(part.sharedBytes);
    if (bytes === null || shared === null || shared > bytes) return fail;
    parts.push({
      kind: part.kind as CatalogStoragePart,
      bytes,
      sharedBytes: shared,
      count: part.count
    });
  }
  if (parts.reduce((sum, part) => sum + part.bytes, 0n) !== totalBytes) return fail;
  return okValue({ catalogId: value.catalogId, totalBytes, sharedBytes, freedBytes, parts });
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

// Materials and mutations (T023, T025) -------------------------------------------------------

export const SPACE_MUTATION_ACTIONS = [
  'rename',
  'move',
  'create_folder',
  'trash',
  'restore',
  'copy'
] as const;
export type SpaceMutationAction = (typeof SPACE_MUTATION_ACTIONS)[number];
export const isSpaceMutationAction = oneOf(SPACE_MUTATION_ACTIONS);

/** Materials one `/materials/mutate` call may name. */
export const SPACE_MUTATION_BATCH = 100;

/** The folder every task drop lands in, made on first use (T031). */
export const SPACE_TASK_DROP_FOLDER_NAME = 'Task attachments';

/**
 * One R2 material as `space-storage` returns it after a commit or a mutation. Revisions and
 * bytes are decimal strings. `contentId` names the original's bytes (null for a folder).
 */
export interface SpaceMaterialSnapshot {
  id: string;
  teamId: string;
  parentMaterialId: string | null;
  name: string;
  kind: 'file' | 'folder';
  lifecycle: 'active' | 'trashed';
  materialRevision: string;
  contentId: string | null;
  sizeBytes: string | null;
  mimeType: string | null;
}

const decimal = (value: unknown): value is string => parseByteCount(value) !== null;

export function parseSpaceMaterialSnapshot(value: unknown): SpaceParsed<SpaceMaterialSnapshot> {
  if (
    !isRecord(value) ||
    !isSpaceUuid(value.id) ||
    !isSpaceUuid(value.teamId) ||
    (value.parentMaterialId !== null && !isSpaceUuid(value.parentMaterialId)) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > SPACE_STORAGE_LIMITS.maxNameLength ||
    (value.kind !== 'file' && value.kind !== 'folder') ||
    (value.lifecycle !== 'active' && value.lifecycle !== 'trashed') ||
    !decimal(value.materialRevision) ||
    (value.kind === 'folder'
      ? value.contentId !== null || value.sizeBytes !== null
      : !isSpaceContentId(value.contentId) || !decimal(value.sizeBytes)) ||
    (value.mimeType !== null && (typeof value.mimeType !== 'string' || value.mimeType.length > 255))
  )
    return fail;
  return okValue({
    id: value.id,
    teamId: value.teamId,
    parentMaterialId: value.parentMaterialId as string | null,
    name: value.name,
    kind: value.kind,
    lifecycle: value.lifecycle,
    materialRevision: value.materialRevision as string,
    contentId: value.contentId as string | null,
    sizeBytes: value.sizeBytes as string | null,
    mimeType: value.mimeType as string | null
  });
}

export interface SpaceMutationResult {
  materials: SpaceMaterialSnapshot[];
  contentRevision: string;
  /** `create_folder` with `ensure`: whether the folder was made by this call. */
  created?: boolean;
}

export function parseSpaceMutationResult(value: unknown): SpaceParsed<SpaceMutationResult> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.materials) ||
    value.materials.length > SPACE_MUTATION_BATCH * 2 ||
    !decimal(value.contentRevision) ||
    (value.created !== undefined && typeof value.created !== 'boolean')
  )
    return fail;
  const materials: SpaceMaterialSnapshot[] = [];
  for (const item of value.materials) {
    const parsed = parseSpaceMaterialSnapshot(item);
    if (!parsed.ok) return fail;
    materials.push(parsed.value);
  }
  return okValue({
    materials,
    contentRevision: value.contentRevision as string,
    ...(value.created === undefined ? {} : { created: value.created })
  });
}

export interface SpaceTrashEmptied {
  deleted: number;
  purgesQueued: number;
  contentRevision: string;
}

export function parseSpaceTrashEmptied(value: unknown): SpaceParsed<SpaceTrashEmptied> {
  if (
    !isRecord(value) ||
    !count(value.deleted) ||
    !count(value.purgesQueued) ||
    !decimal(value.contentRevision)
  )
    return fail;
  return okValue({
    deleted: value.deleted,
    purgesQueued: value.purgesQueued,
    contentRevision: value.contentRevision as string
  });
}

/**
 * A read URL on the files host (`space-read` Worker) or, on beta, on the local read route: the
 * original, or one derivative, of one object, with the read grant in `g`. `download` adds `dl`,
 * which makes the reader answer `Content-Disposition: attachment` with a safe name. The base
 * comes from a grant the caller has already parsed. The grant must never be logged.
 */
export function spaceFilesUrl(input: {
  filesOrigin: string;
  teamId: string;
  contentId: string;
  grant: string;
  derivative?: { recipeVersion: number; variant: SpaceDerivativeVariant };
  download?: string;
}): string {
  const path = input.derivative
    ? spaceDerivativeKey(
        input.teamId,
        input.contentId,
        input.derivative.recipeVersion,
        input.derivative.variant
      )
    : spaceObjectKey(input.teamId, input.contentId);
  if (!isSpaceFilesBase(input.filesOrigin, { allowLocalRoute: true }))
    throw new TypeError('Invalid files origin');
  const url = new URL(`${input.filesOrigin}/${path}`);
  url.searchParams.set('g', input.grant);
  if (input.download !== undefined) url.searchParams.set('dl', input.download);
  return url.toString();
}

// Derivatives made by the uploading client (T047, research R5) -----------------------------

/**
 * What the server asks the uploading client to make, by the material's category. An image gets
 * the three explorer sizes; a video also gets its poster and the hover frames. Anything else
 * gets none: its picture, if any, comes from an agent (PDF first page) or never.
 */
export function spaceDerivativeSlotsFor(category: string | null): SpaceDerivativeVariant[] {
  if (category === 'image') return ['row', 'tile', 'full'];
  if (category === 'video') return ['row', 'tile', 'full', 'poster', 'sprite'];
  return [];
}

/**
 * Hover frames of a video: `frames` evenly spaced frames, `columns` to a row, each at most
 * `frameMaxEdge` on its long side, in one image. A reader finds a frame's cell from the
 * sprite's own width and height, so the layout is all it needs.
 */
export const SPACE_DERIVATIVE_SPRITE = { frames: 10, columns: 5, frameMaxEdge: 320 } as const;

/** The variant the explorer tile shows; a material counts as having a picture once it is in. */
export const SPACE_TILE_VARIANT: SpaceDerivativeVariant = 'tile';

/** `provider_thumbnail_version` of an R2 material whose tile is in (the column needs one). */
export const spaceThumbnailVersion = (recipeVersion: number = SPACE_DERIVATIVE_RECIPE_VERSION) =>
  `r2:${recipeVersion}`;

/** How long an agent holds a derivative job, and how often one is tried before `failed`. */
export const SPACE_DERIVATIVE_JOB_LIMITS = {
  leaseSeconds: 600,
  maxAttempts: 3,
  /** The first bytes the server reads of a staged derivative to check its type and size. */
  sniffBytes: 64 * 1024
} as const;

export interface SpaceDerivativeDeclaration {
  variant: SpaceDerivativeVariant;
  contentType: SpaceDerivativeType;
  bytes: number;
  width: number;
  height: number;
  /** MD5 of the bytes, 32 lowercase hex: the PUT is signed with it. */
  md5: string;
}

const MD5_HEX = /^[0-9a-f]{32}$/u;

/** A derivative as declared: of a known variant, type and within that variant's bounds. */
export function isSpaceDerivativeDeclaration(value: unknown): value is SpaceDerivativeDeclaration {
  if (!isRecord(value) || !isSpaceDerivativeVariant(value.variant)) return false;
  const limit = SPACE_DERIVATIVE_VARIANTS[value.variant];
  return (
    isSpaceDerivativeType(value.contentType) &&
    count(value.bytes, limit.maxBytes) &&
    value.bytes >= 1 &&
    count(value.width, limit.maxWidth) &&
    value.width >= 1 &&
    count(value.height, limit.maxHeight) &&
    value.height >= 1 &&
    typeof value.md5 === 'string' &&
    MD5_HEX.test(value.md5)
  );
}

/** Media facts of an original. The browser knows duration and size; codec and fps come from an agent. */
export interface SpaceMediaFacts {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  fps: number | null;
}

const MAX_DURATION_MS = 7 * 24 * 3600 * 1000;

export function parseSpaceMediaFacts(value: unknown): SpaceParsed<SpaceMediaFacts> {
  if (value === undefined || value === null)
    return okValue({ durationMs: null, width: null, height: null, codec: null, fps: null });
  if (!isRecord(value)) return fail;
  const optional = (item: unknown, max: number, min = 0) =>
    item === undefined || item === null || (count(item, max) && (item as number) >= min);
  if (
    !optional(value.durationMs, MAX_DURATION_MS) ||
    !optional(value.width, 65_535, 1) ||
    !optional(value.height, 65_535, 1) ||
    (value.codec !== undefined &&
      value.codec !== null &&
      (typeof value.codec !== 'string' || !/^[a-z0-9._-]{1,32}$/u.test(value.codec))) ||
    (value.fps !== undefined &&
      value.fps !== null &&
      (typeof value.fps !== 'number' ||
        !Number.isFinite(value.fps) ||
        value.fps <= 0 ||
        value.fps > 1000))
  )
    return fail;
  const or = <T>(item: unknown): T | null => (item === undefined ? null : (item as T | null));
  return okValue({
    durationMs: or<number>(value.durationMs),
    width: or<number>(value.width),
    height: or<number>(value.height),
    codec: or<string>(value.codec),
    fps: value.fps === undefined || value.fps === null ? null : Math.round(value.fps * 1000) / 1000
  });
}

export interface SpaceDerivativeUrl {
  variant: SpaceDerivativeVariant;
  url: string;
  /** The exact headers the PUT must carry: both are inside the signature. */
  contentMd5: string;
  contentType: SpaceDerivativeType;
  expiresAt: string;
}

/** `/uploads/{id}/derivatives` and the agent's `/agent/derivatives/stage`: one URL per variant. */
export function parseSpaceDerivativeUrls(value: unknown): SpaceParsed<SpaceDerivativeUrl[]> {
  if (!isRecord(value) || !Array.isArray(value.derivatives)) return fail;
  if (value.derivatives.length > SPACE_DERIVATIVE_VARIANT_NAMES.length) return fail;
  const out: SpaceDerivativeUrl[] = [];
  for (const item of value.derivatives) {
    if (
      !isRecord(item) ||
      !isSpaceDerivativeVariant(item.variant) ||
      !httpsUrl(item.url) ||
      typeof item.contentMd5 !== 'string' ||
      !/^[A-Za-z0-9+/]{22}==$/u.test(item.contentMd5) ||
      !isSpaceDerivativeType(item.contentType) ||
      !timestamp(item.expiresAt)
    )
      return fail;
    out.push({
      variant: item.variant,
      url: item.url,
      contentMd5: item.contentMd5,
      contentType: item.contentType,
      expiresAt: item.expiresAt
    });
  }
  return new Set(out.map(item => item.variant)).size === out.length ? okValue(out) : fail;
}

/**
 * The type and pixel size of a derivative from its first bytes (WebP: VP8, VP8L, VP8X; JPEG: the
 * first SOF marker). The server checks a staged derivative with this, never with what the client
 * declared; null is «not a picture of an allowed type».
 */
export function sniffSpaceDerivative(
  bytes: Uint8Array
): { contentType: SpaceDerivativeType; width: number; height: number } | null {
  const at = (offset: number) => bytes[offset] ?? -1;
  const ascii = (offset: number, text: string) =>
    [...text].every((char, index) => at(offset + index) === char.charCodeAt(0));
  const u16le = (offset: number) => at(offset) | (at(offset + 1) << 8);
  const u24le = (offset: number) => u16le(offset) | (at(offset + 2) << 16);
  if (bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ')) {
      // Key frame start code, then 14-bit width and height.
      if (at(23) !== 0x9d || at(24) !== 0x01 || at(25) !== 0x2a) return null;
      return picture('image/webp', u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    }
    if (ascii(12, 'VP8L')) {
      if (at(20) !== 0x2f) return null;
      const bits = (at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24)) >>> 0;
      return picture('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, 'VP8X')) return picture('image/webp', u24le(24) + 1, u24le(27) + 1);
    return null;
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (at(offset) !== 0xff) return null;
      const marker = at(offset + 1);
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const length = (at(offset + 2) << 8) | at(offset + 3);
      // SOF0..SOF15, but not DHT (C4), JPG (C8) or DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return picture(
          'image/jpeg',
          (at(offset + 7) << 8) | at(offset + 8),
          (at(offset + 5) << 8) | at(offset + 6)
        );
      if (marker === 0xd9 || marker === 0xda || length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

function picture(contentType: SpaceDerivativeType, width: number, height: number) {
  return width >= 1 && height >= 1 ? { contentType, width, height } : null;
}

/** The checks the server makes of one staged derivative against its declaration. */
export function checkSpaceDerivative(
  declared: Pick<
    SpaceDerivativeDeclaration,
    'variant' | 'contentType' | 'bytes' | 'width' | 'height'
  >,
  stored: { bytes: number; head: Uint8Array }
): { ok: true } | { ok: false; reason: 'type' | 'size' | 'dimensions' } {
  const limit = SPACE_DERIVATIVE_VARIANTS[declared.variant];
  if (stored.bytes !== declared.bytes || stored.bytes < 1 || stored.bytes > limit.maxBytes)
    return { ok: false, reason: 'size' };
  const sniffed = sniffSpaceDerivative(stored.head);
  if (!sniffed || sniffed.contentType !== declared.contentType)
    return { ok: false, reason: 'type' };
  if (
    sniffed.width !== declared.width ||
    sniffed.height !== declared.height ||
    sniffed.width > limit.maxWidth ||
    sniffed.height > limit.maxHeight
  )
    return { ok: false, reason: 'dimensions' };
  return { ok: true };
}
