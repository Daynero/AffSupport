import { LIBRARY_VIDEO_THUMBNAIL_TARGET_MS } from '@video-compressor/shared';

/** Exact 1,000 ms target, or the last available instant for a shorter clip. */
export function resolveVideoThumbnailTimeMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(LIBRARY_VIDEO_THUMBNAIL_TARGET_MS, Math.max(0, Math.round(durationMs)));
}

export function videoThumbnailSeekTargetSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return resolveVideoThumbnailTimeMs(durationSeconds * 1_000) / 1_000;
}

export interface VideoThumbnailMetadata {
  targetTimeMs: number;
  width: number | null;
  height: number | null;
  sourceVersion: string;
}

export function createVideoThumbnailMetadata(input: {
  durationMs: number;
  width?: number | null;
  height?: number | null;
  sourceVersion: string;
}): VideoThumbnailMetadata {
  return {
    targetTimeMs: resolveVideoThumbnailTimeMs(input.durationMs),
    width: validDimension(input.width),
    height: validDimension(input.height),
    sourceVersion: input.sourceVersion
  };
}

function validDimension(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 16_384
    ? value
    : null;
}
