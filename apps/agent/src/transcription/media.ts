import path from 'node:path';

/**
 * Content types for the media endpoint. The transcriber accepts more
 * containers than a browser can necessarily play; unknown types fall back to a
 * generic octet-stream so the client can decide whether to request a proxy.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff'
};

export function mediaMimeType(fileName: string): string {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/** A resolved, inclusive byte range `[start, end]` within a file of `size`. */
export interface ByteRange {
  start: number;
  end: number;
}

export type RangeResolution =
  { kind: 'full' } | { kind: 'partial'; range: ByteRange } | { kind: 'unsatisfiable' };

/**
 * Parses a single HTTP `Range` header against a known file size. Supports the
 * common `bytes=start-end`, open-ended `bytes=start-`, and suffix `bytes=-n`
 * forms — enough for a media element's seek requests, which is all this serves.
 * Multiple ranges are treated as a full response rather than multipart.
 */
export function resolveByteRange(rangeHeader: string | undefined, size: number): RangeResolution {
  if (!rangeHeader) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return { kind: 'full' };
  if (size <= 0) return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;
  if (!match[1]) {
    // Suffix range: the final N bytes.
    const suffix = Number(match[2]);
    if (suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: 'unsatisfiable' };
  if (start > end || start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', range: { start, end: Math.min(end, size - 1) } };
}
