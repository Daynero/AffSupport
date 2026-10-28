// @ts-self-types="./catalog-images.d.ts"
import { isRecord } from './contract.js';

export const CATALOG_IMAGE_CONTRACT_VERSION = 2;
export const CATALOG_IMAGE_VOCABULARY_VERSION = 'catalog-clothing-v1';
export const CATALOG_IMAGE_LIMITS = {
  maxBytes: 50_000_000,
  maxPixels: 16_000_000,
  manifestPage: 100,
  maxFiles: 1000,
  maxJobBytes: 5_000_000_000,
  pageSize: 100,
  uploadConcurrency: 2,
  grantSeconds: 300,
  sourceLifetimeSeconds: 86_400
} as const;

/** File tokens and display names are one vocabulary for importer, prompt and pairing. */
export const CATALOG_IMAGE_GARMENTS = [
  ['tshirt', 'T-Shirt'],
  ['tank-top', 'Tank Top'],
  ['polo-shirt', 'Polo Shirt'],
  ['oxford-shirt', 'Oxford Shirt'],
  ['blouse', 'Blouse'],
  ['hoodie', 'Hoodie'],
  ['sweatshirt', 'Sweatshirt'],
  ['cardigan', 'Cardigan'],
  ['sweater', 'Sweater'],
  ['turtleneck', 'Turtleneck'],
  ['crop-top', 'Crop Top'],
  ['midi-dress', 'Midi Dress'],
  ['maxi-dress', 'Maxi Dress'],
  ['wrap-dress', 'Wrap Dress'],
  ['slip-dress', 'Slip Dress'],
  ['shirt-dress', 'Shirt Dress'],
  ['jumpsuit', 'Jumpsuit'],
  ['pleated-skirt', 'Pleated Skirt'],
  ['mini-skirt', 'Mini Skirt'],
  ['chinos', 'Chinos'],
  ['cargo-pants', 'Cargo Pants'],
  ['wide-leg-jeans', 'Wide Leg Jeans'],
  ['slim-jeans', 'Slim Jeans'],
  ['joggers', 'Joggers'],
  ['shorts', 'Shorts'],
  ['leggings', 'Leggings'],
  ['bomber-jacket', 'Bomber Jacket'],
  ['denim-jacket', 'Denim Jacket'],
  ['puffer-jacket', 'Puffer Jacket'],
  ['trench-coat', 'Trench Coat'],
  ['blazer', 'Blazer'],
  ['overshirt', 'Overshirt']
] as const;
export const CATALOG_IMAGE_COLORS = [
  'black',
  'white',
  'ivory',
  'navy',
  'olive',
  'sage',
  'terracotta',
  'burgundy',
  'charcoal',
  'sand',
  'camel',
  'dusty-rose',
  'sky-blue',
  'forest-green',
  'mustard',
  'lavender',
  'cream',
  'chocolate',
  'stone-grey',
  'coral',
  'denim-blue',
  'mint',
  'rust',
  'plum'
] as const;
export type CatalogImageGarment = (typeof CATALOG_IMAGE_GARMENTS)[number][1];
export type CatalogImageClassification =
  | {
      mode: 'matched';
      garment: CatalogImageGarment;
      color: string;
      vocabularyVersion: typeof CATALOG_IMAGE_VOCABULARY_VERSION;
    }
  | {
      mode: 'unclassified';
      garment: null;
      color: null;
      reason: 'missing' | 'unknown' | 'ambiguous';
      vocabularyVersion: typeof CATALOG_IMAGE_VOCABULARY_VERSION;
    };

const normalized = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\bt[-\s]+shirt\b/gu, 'tshirt')
    .replace(/[_\s-]+/gu, ' ')
    .trim();
const hasPhrase = (text: string, phrase: string): boolean =>
  ` ${text} `.includes(` ${normalized(phrase)} `);

/** Unknown/ambiguous names are ordinary usable pictures, never guessed facts. */
export function classifyCatalogImageName(name: string): CatalogImageClassification {
  const phrase = normalized(name.replace(/\.[^.]+$/u, ''));
  const garments = CATALOG_IMAGE_GARMENTS.filter(([token]) => hasPhrase(phrase, token));
  const colors = CATALOG_IMAGE_COLORS.filter(color => hasPhrase(phrase, color));
  if (garments.length === 1 && colors.length === 1) {
    return {
      mode: 'matched',
      garment: garments[0]![1],
      color: colors[0]!.replace(/-/gu, ' '),
      vocabularyVersion: CATALOG_IMAGE_VOCABULARY_VERSION
    };
  }
  return {
    mode: 'unclassified',
    garment: null,
    color: null,
    reason: garments.length > 1 || colors.length > 1 ? 'ambiguous' : phrase ? 'unknown' : 'missing',
    vocabularyVersion: CATALOG_IMAGE_VOCABULARY_VERSION
  };
}

export const CATALOG_IMAGE_ERROR_CODES = [
  'CATALOG_IMAGE_UPGRADE_REQUIRED',
  'CATALOG_IMAGE_IMPORT_DISABLED',
  'IMAGE_QUOTA_EXCEEDED',
  'IMAGE_UPLOAD_CAPACITY_BUSY',
  'IMAGE_MANIFEST_INCOMPLETE',
  'IMAGE_SOURCE_UNAVAILABLE',
  'IMAGE_SOURCE_CHANGED',
  'IMAGE_LOCAL_SOURCE_REQUIRED',
  'IMAGE_UNSUPPORTED_FORMAT',
  'IMAGE_TOO_LARGE',
  'IMAGE_DIMENSIONS_INVALID',
  'IMAGE_ANIMATED_UNSUPPORTED',
  'IMAGE_ORIENTATION_UNSUPPORTED',
  'IMAGE_CONTENT_INVALID',
  'IMAGE_CLASSIFICATION_CONFLICT',
  'IMAGE_TEXT_PAIRING_CONFLICT',
  'IMAGE_PROVIDER_UNAVAILABLE',
  'IMAGE_PROVIDER_RATE_LIMITED',
  'IMAGE_PUBLIC_VERIFICATION_FAILED',
  'IMAGE_WRITE_UNCERTAIN',
  'IMAGE_DICTIONARY_COMMIT_FAILED',
  'IMAGE_PUBLICATION_REVOKED',
  'IMAGE_CLIPBOARD_UNAVAILABLE',
  'IDEMPOTENCY_CONFLICT'
] as const;
export type CatalogImageErrorCode = (typeof CATALOG_IMAGE_ERROR_CODES)[number];

export interface R2CatalogImage {
  kind: 'r2';
  publicationId: string;
  poolEntryId: string;
  publicUrl: string;
  classification: CatalogImageClassification;
  revision: number;
}
export interface LegacyCatalogImage {
  kind: 'legacy_drive';
  materialId?: string;
  driveFileId: string;
  resourceKey: string | null;
  name?: string | null;
}
export type CatalogImage = R2CatalogImage | LegacyCatalogImage;
export type CatalogImageImportState =
  | 'collecting'
  | 'enumerating'
  | 'sealed'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'awaiting_reconciliation';
export type CatalogImageEntryState =
  | 'waiting_source'
  | 'staged'
  | 'validating'
  | 'deduplicating'
  | 'publishing'
  | 'verifying_origin'
  | 'verifying_public'
  | 'committing'
  | 'ready'
  | 'reused'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'awaiting_reconciliation';
export interface CatalogImageImportEntry {
  id: string;
  clientFileKey: string | null;
  displayName: string;
  state: CatalogImageEntryState;
  grantGeneration?: number;
  classification: CatalogImageClassification;
  errorCode: string | null;
  declaredSize: number;
}
export interface CatalogImageImportCounts {
  total: number;
  ready: number;
  reused: number;
  unclassified: number;
  failed: number;
  expired: number;
  cancelled?: number;
}
export interface CatalogImageImportJob {
  id: string;
  teamId: string;
  sourceKind: 'local' | 'drive';
  state: CatalogImageImportState;
  revision: number;
  counts: CatalogImageImportCounts;
  entries: CatalogImageImportEntry[];
  hasMore: boolean;
  nextCursor: string | null;
  hasMoreSources?: boolean;
  /** Bounded machine code for a job failure before an entry could be admitted. */
  errorCode?: string | null;
}
export interface CatalogImageImportList {
  items: CatalogImageImportJob[];
  hasMore: boolean;
  nextCursor: string | null;
}
export interface CatalogImageGrant {
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  generation: number;
}
export interface CatalogImageDictionaryEntry {
  id: string;
  publicationId: string;
  publicUrl: string;
  classification: CatalogImageClassification;
  revision: number;
}
export interface CatalogImageDictionaryPage {
  items: CatalogImageDictionaryEntry[];
  total: number;
  revision: number;
  hasMore: boolean;
  nextCursor: string | null;
}
/** Charged bytes include reservations and retained copies across the current owner's spaces. */
export interface CatalogImageStorage {
  limitBytes: number;
  limitImages: number;
  usedBytes: number;
  reservedBytes: number;
  pendingDeletionBytes: number;
  retainedBytes: number;
  libraryBytes: number;
  totalImages: number;
  availableBytes: number;
  teamBytes: number;
  otherTeamBytes: number;
}
export interface CatalogImageLibraryEntry extends CatalogImageDictionaryEntry {
  sizeBytes: number;
  active: boolean;
  inUse: boolean;
  publicationState: 'ready' | 'revoking' | 'purge_unknown' | 'purging';
}
export interface CatalogImageLibraryPage extends Omit<CatalogImageDictionaryPage, 'items'> {
  items: CatalogImageLibraryEntry[];
}
export interface CatalogImageInventory {
  revision: number;
  pairs: Array<{ garment: CatalogImageGarment; color: string; count: number }>;
  unclassified: number;
  total: number;
}
export interface CatalogImageCapabilities {
  enabled: boolean;
  importEnabled: boolean;
  canManage: boolean;
  contractVersion: 2;
  mode: 'legacy' | 'v2';
}

const boundedInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const short = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255;
const cursor = (v: unknown): v is string | null => v === null || short(v);
const garment = (v: unknown): v is CatalogImageGarment =>
  CATALOG_IMAGE_GARMENTS.some(([, name]) => name === v);
const color = (v: unknown): v is string =>
  typeof v === 'string' && CATALOG_IMAGE_COLORS.some(c => c.replace(/-/gu, ' ') === v);
const httpUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 8192) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
};
export function isCatalogImageClassification(v: unknown): v is CatalogImageClassification {
  if (!isRecord(v) || v.vocabularyVersion !== CATALOG_IMAGE_VOCABULARY_VERSION) return false;
  return v.mode === 'matched'
    ? garment(v.garment) && color(v.color)
    : v.mode === 'unclassified' &&
        v.garment === null &&
        v.color === null &&
        (v.reason === 'missing' || v.reason === 'unknown' || v.reason === 'ambiguous');
}
export function isR2CatalogImage(v: unknown): v is R2CatalogImage {
  return (
    isRecord(v) &&
    v.kind === 'r2' &&
    short(v.publicationId) &&
    short(v.poolEntryId) &&
    httpUrl(v.publicUrl) &&
    !new URL(v.publicUrl).search &&
    isCatalogImageClassification(v.classification) &&
    boundedInteger(v.revision)
  );
}
export function isCatalogImageImportEntry(v: unknown): v is CatalogImageImportEntry {
  const states: readonly string[] = [
    'waiting_source',
    'staged',
    'validating',
    'deduplicating',
    'publishing',
    'verifying_origin',
    'verifying_public',
    'committing',
    'ready',
    'reused',
    'failed',
    'cancelled',
    'expired',
    'awaiting_reconciliation'
  ];
  return (
    isRecord(v) &&
    short(v.id) &&
    cursor(v.clientFileKey) &&
    typeof v.displayName === 'string' &&
    v.displayName.length <= 255 &&
    typeof v.state === 'string' &&
    states.includes(v.state) &&
    isCatalogImageClassification(v.classification) &&
    cursor(v.errorCode) &&
    boundedInteger(v.declaredSize, CATALOG_IMAGE_LIMITS.maxBytes) &&
    (v.grantGeneration === undefined || boundedInteger(v.grantGeneration))
  );
}
export function isCatalogImageImportCounts(v: unknown): v is CatalogImageImportCounts {
  return (
    isRecord(v) &&
    ['total', 'ready', 'reused', 'unclassified', 'failed', 'expired'].every(key =>
      boundedInteger(v[key])
    ) &&
    (v.cancelled === undefined || boundedInteger(v.cancelled))
  );
}
export function isCatalogImageImportJob(v: unknown): v is CatalogImageImportJob {
  const states: readonly string[] = [
    'collecting',
    'enumerating',
    'sealed',
    'running',
    'completed',
    'partial',
    'failed',
    'cancelled',
    'expired',
    'awaiting_reconciliation'
  ];
  return (
    isRecord(v) &&
    short(v.id) &&
    short(v.teamId) &&
    (v.sourceKind === 'local' || v.sourceKind === 'drive') &&
    typeof v.state === 'string' &&
    states.includes(v.state) &&
    boundedInteger(v.revision) &&
    isCatalogImageImportCounts(v.counts) &&
    (v.errorCode === undefined ||
      v.errorCode === null ||
      (typeof v.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(v.errorCode))) &&
    Array.isArray(v.entries) &&
    v.entries.length <= CATALOG_IMAGE_LIMITS.pageSize &&
    v.entries.every(isCatalogImageImportEntry) &&
    typeof v.hasMore === 'boolean' &&
    cursor(v.nextCursor)
  );
}
export function isCatalogImageImportList(v: unknown): v is CatalogImageImportList {
  return (
    isRecord(v) &&
    Array.isArray(v.items) &&
    v.items.length <= 20 &&
    v.items.every(isCatalogImageImportJob) &&
    typeof v.hasMore === 'boolean' &&
    cursor(v.nextCursor)
  );
}
export function isCatalogImageGrant(v: unknown): v is CatalogImageGrant {
  return (
    isRecord(v) &&
    httpUrl(v.url) &&
    isRecord(v.headers) &&
    Object.entries(v.headers).length <= 10 &&
    Object.entries(v.headers).every(
      ([k, x]) => k.length <= 100 && typeof x === 'string' && x.length <= 1024
    ) &&
    typeof v.expiresAt === 'string' &&
    Number.isFinite(Date.parse(v.expiresAt)) &&
    boundedInteger(v.generation)
  );
}
export function isCatalogImageDictionaryEntry(v: unknown): v is CatalogImageDictionaryEntry {
  return (
    isRecord(v) &&
    short(v.id) &&
    short(v.publicationId) &&
    httpUrl(v.publicUrl) &&
    !new URL(v.publicUrl).search &&
    isCatalogImageClassification(v.classification) &&
    boundedInteger(v.revision)
  );
}
export function isCatalogImageDictionaryPage(v: unknown): v is CatalogImageDictionaryPage {
  return (
    isRecord(v) &&
    Array.isArray(v.items) &&
    v.items.length <= 100 &&
    v.items.every(isCatalogImageDictionaryEntry) &&
    boundedInteger(v.total) &&
    boundedInteger(v.revision) &&
    typeof v.hasMore === 'boolean' &&
    cursor(v.nextCursor)
  );
}
export function isCatalogImageStorage(v: unknown): v is CatalogImageStorage {
  return (
    isRecord(v) &&
    [
      'limitBytes',
      'limitImages',
      'usedBytes',
      'reservedBytes',
      'pendingDeletionBytes',
      'retainedBytes',
      'libraryBytes',
      'totalImages',
      'availableBytes',
      'teamBytes',
      'otherTeamBytes'
    ].every(key => boundedInteger(v[key]))
  );
}
export function isCatalogImageLibraryEntry(v: unknown): v is CatalogImageLibraryEntry {
  return (
    isCatalogImageDictionaryEntry(v) &&
    isRecord(v) &&
    boundedInteger(v.sizeBytes, CATALOG_IMAGE_LIMITS.maxBytes) &&
    v.sizeBytes > 0 &&
    typeof v.active === 'boolean' &&
    typeof v.inUse === 'boolean' &&
    typeof v.publicationState === 'string' &&
    ['ready', 'revoking', 'purge_unknown', 'purging'].includes(v.publicationState)
  );
}
export function isCatalogImageLibraryPage(v: unknown): v is CatalogImageLibraryPage {
  return isCatalogImageDictionaryPage(v) && v.items.every(isCatalogImageLibraryEntry);
}
export function isCatalogImageInventory(v: unknown): v is CatalogImageInventory {
  return (
    isRecord(v) &&
    boundedInteger(v.revision) &&
    boundedInteger(v.unclassified) &&
    boundedInteger(v.total) &&
    Array.isArray(v.pairs) &&
    v.pairs.length <= 768 &&
    v.pairs.every(
      p => isRecord(p) && garment(p.garment) && color(p.color) && boundedInteger(p.count)
    )
  );
}
export function isCatalogImageCapabilities(v: unknown): v is CatalogImageCapabilities {
  return (
    isRecord(v) &&
    typeof v.enabled === 'boolean' &&
    typeof v.importEnabled === 'boolean' &&
    typeof v.canManage === 'boolean' &&
    v.contractVersion === 2 &&
    (v.mode === 'legacy' || v.mode === 'v2')
  );
}
