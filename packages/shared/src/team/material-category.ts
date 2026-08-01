import { normalizeExtension, normalizeMimeType } from './contract.js';

export const MATERIAL_CLASSIFIER_VERSION = 1;
export const MATERIAL_CATEGORIES = [
  'video',
  'image',
  'archive',
  'transcript',
  'landing',
  'other'
] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];
export type MaterialKind = 'file' | 'folder' | 'shortcut';
export type MaterialClassificationSource = 'mime' | 'extension' | 'inspected_landing' | 'fallback';

export interface MaterialClassificationInput {
  kind: MaterialKind;
  mimeType: unknown;
  fileExtension: unknown;
  /** Current immutable provider identity used to bind an inspected package proof. */
  sourceVersion?: string | null;
  landingPackageValidated?: boolean;
  landingValidationSourceVersion?: string | null;
  landingValidationFingerprint?: string | null;
}

export interface MaterialClassification {
  category: MaterialCategory | null;
  source: MaterialClassificationSource;
  version: number;
  normalizedMimeType: string | null;
  normalizedExtension: string | null;
}

const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip'
]);
const TRANSCRIPT_MIME_TYPES = new Set([
  'text/plain',
  'text/vtt',
  'application/x-subrip',
  'application/srt'
]);
const LANDING_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const GENERIC_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'application/x-download'
]);

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', 'ogv']);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'svg'
]);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'tgz', 'gz']);
const TRANSCRIPT_EXTENSIONS = new Set(['txt', 'srt', 'vtt']);
const LANDING_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);

function categoryFromMime(mimeType: string | null): MaterialCategory | null {
  if (!mimeType || GENERIC_MIME_TYPES.has(mimeType)) return null;
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (LANDING_MIME_TYPES.has(mimeType)) return 'landing';
  if (TRANSCRIPT_MIME_TYPES.has(mimeType)) return 'transcript';
  if (ARCHIVE_MIME_TYPES.has(mimeType)) return 'archive';
  return null;
}

function categoryFromExtension(extension: string | null): MaterialCategory | null {
  if (!extension) return null;
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (LANDING_EXTENSIONS.has(extension)) return 'landing';
  if (TRANSCRIPT_EXTENSIONS.has(extension)) return 'transcript';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return null;
}

export function classifyMaterial(input: MaterialClassificationInput): MaterialClassification {
  const normalizedMimeType = normalizeMimeType(input.mimeType);
  const normalizedExtension = normalizeExtension(input.fileExtension);
  const common = {
    version: MATERIAL_CLASSIFIER_VERSION,
    normalizedMimeType,
    normalizedExtension
  };

  if (input.kind === 'folder') return { ...common, category: null, source: 'fallback' };
  if (input.kind === 'shortcut') return { ...common, category: 'other', source: 'fallback' };

  const hasVersionedLandingProof =
    input.landingPackageValidated === true &&
    typeof input.sourceVersion === 'string' &&
    input.sourceVersion.length > 0 &&
    input.landingValidationSourceVersion === input.sourceVersion &&
    typeof input.landingValidationFingerprint === 'string' &&
    input.landingValidationFingerprint.length > 0;
  // Keep the original unversioned call shape compatible while all finalize
  // paths migrate to source-bound proofs. Once any identity is supplied, the
  // proof must be complete and match the current source exactly.
  const hasLegacyLandingProof =
    input.landingPackageValidated === true &&
    input.sourceVersion === undefined &&
    input.landingValidationSourceVersion === undefined &&
    input.landingValidationFingerprint === undefined;
  const landingPackageValidated = hasVersionedLandingProof || hasLegacyLandingProof;

  const mimeCategory = categoryFromMime(normalizedMimeType);
  if (mimeCategory) {
    const extensionCategory = categoryFromExtension(normalizedExtension);
    if (
      mimeCategory === 'transcript' &&
      normalizedMimeType === 'text/plain' &&
      extensionCategory !== null &&
      extensionCategory !== 'transcript'
    ) {
      return { ...common, category: extensionCategory, source: 'extension' };
    }
    if (mimeCategory === 'archive' && landingPackageValidated) {
      return { ...common, category: 'landing', source: 'inspected_landing' };
    }
    return { ...common, category: mimeCategory, source: 'mime' };
  }

  const extensionCategory = categoryFromExtension(normalizedExtension);
  if (extensionCategory) {
    if (extensionCategory === 'archive' && landingPackageValidated) {
      return { ...common, category: 'landing', source: 'inspected_landing' };
    }
    return { ...common, category: extensionCategory, source: 'extension' };
  }
  return { ...common, category: 'other', source: 'fallback' };
}
