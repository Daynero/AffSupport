/**
 * The provider-thumbnail cache (011): one bucket, one path formula, shared by
 * the relay that serves a thumbnail and the worker that prepares one ahead of
 * time. The path is a digest of team, material, source version and mime, so a
 * new version of the file is a new object and a stale one is never served.
 */
export const THUMBNAIL_CACHE_BUCKET = 'team-thumbnail-cache';
export const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
export const THUMBNAIL_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
]);

export function validThumbnail(mimeType: string, contentLength: number): boolean {
  return (
    THUMBNAIL_MIME_TYPES.has(mimeType) &&
    Number.isSafeInteger(contentLength) &&
    contentLength >= 1 &&
    contentLength <= MAX_THUMBNAIL_BYTES
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function thumbnailCachePath(input: {
  teamId: string;
  materialId: string;
  sourceIdentity: string | null;
  mimeType: string | null;
}): Promise<string | null> {
  if (!input.sourceIdentity) return null;
  const digest = await sha256Hex(
    `${input.teamId}\u0000${input.materialId}\u0000${input.sourceIdentity}\u0000${input.mimeType ?? ''}`
  );
  return `${digest.slice(0, 2)}/${digest}.thumbnail`;
}

export type ThumbnailUnavailableReason =
  'unsupported' | 'protected' | 'too_large' | 'provider_missing';

export function classifyThumbnailResponse(input: {
  status: number;
  mimeType: string;
  contentLength: number;
}): { state: 'ready' } | { state: 'unavailable'; reason: ThumbnailUnavailableReason } {
  if (input.status === 401 || input.status === 403) {
    return { state: 'unavailable', reason: 'protected' };
  }
  if (input.status < 200 || input.status >= 300) {
    return { state: 'unavailable', reason: 'provider_missing' };
  }
  if (!THUMBNAIL_MIME_TYPES.has(input.mimeType)) {
    return { state: 'unavailable', reason: 'unsupported' };
  }
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
    return { state: 'unavailable', reason: 'provider_missing' };
  }
  if (input.contentLength > MAX_THUMBNAIL_BYTES) {
    return { state: 'unavailable', reason: 'too_large' };
  }
  return { state: 'ready' };
}
