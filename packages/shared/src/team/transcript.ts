import {
  TRANSCRIPT_INDEX_MAX_BYTES,
  type TranscriptIngestState,
  normalizeExtension
} from './contract.js';

export const TRANSCRIPT_EXTENSIONS = ['txt', 'srt', 'vtt'] as const;
export type TranscriptExtension = (typeof TRANSCRIPT_EXTENSIONS)[number];

export interface TranscriptIngestOptions {
  extension: unknown;
  totalBytes?: number | null;
}

export interface TranscriptIngestResult {
  state: TranscriptIngestState;
  text: string | null;
  truncated: boolean;
  indexedBytes: number;
  errorCode: 'INVALID_UTF8' | 'NUL_BYTE' | 'UNSUPPORTED_FORMAT' | null;
}

export type TranscriptEditorEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'unsupported_format' | 'too_large' | 'truncated' | 'invalid_encoding' | 'unavailable';
    };

function isTranscriptExtension(value: string | null): value is TranscriptExtension {
  return value !== null && (TRANSCRIPT_EXTENSIONS as readonly string[]).includes(value);
}

function decodeAtUtf8Boundary(bytes: Uint8Array): { text: string; byteLength: number } | null {
  try {
    // Streaming decode permits only an unfinished code point at the trailing
    // fetch boundary. It still throws for malformed sequences inside the
    // buffer, unlike blindly trimming bytes until a prefix happens to decode.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return { text, byteLength: new TextEncoder().encode(text).byteLength };
  } catch {
    return null;
  }
}

function extractCueText(input: string, extension: TranscriptExtension): string {
  if (extension === 'txt') return input;
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let skipBlock = false;
  for (const original of lines) {
    const line = original.trim();
    if (!line) {
      skipBlock = false;
      continue;
    }
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) {
      skipBlock = true;
      continue;
    }
    if (skipBlock || /^WEBVTT(?:\s|$)/i.test(line) || /^\d+$/.test(line)) continue;
    if (/^(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+/.test(line)) continue;
    const sanitized = line.replace(/<[^>]*>/g, '').trim();
    if (sanitized) output.push(sanitized);
  }
  return output.join('\n');
}

export function ingestTranscript(
  input: Uint8Array,
  options: TranscriptIngestOptions
): TranscriptIngestResult {
  const extension = normalizeExtension(options.extension);
  if (!isTranscriptExtension(extension)) {
    return {
      state: 'not_applicable',
      text: null,
      truncated: false,
      indexedBytes: 0,
      errorCode: 'UNSUPPORTED_FORMAT'
    };
  }

  const hasBom =
    input.byteLength >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf;
  const content = hasBom ? input.subarray(3) : input;
  const declaredBytes =
    typeof options.totalBytes === 'number' && Number.isSafeInteger(options.totalBytes)
      ? Math.max(0, options.totalBytes - (hasBom ? 3 : 0))
      : content.byteLength;
  const bounded = content.subarray(0, Math.min(content.byteLength, TRANSCRIPT_INDEX_MAX_BYTES));
  if (bounded.includes(0)) {
    return {
      state: 'invalid_encoding',
      text: null,
      truncated: declaredBytes > TRANSCRIPT_INDEX_MAX_BYTES,
      indexedBytes: 0,
      errorCode: 'NUL_BYTE'
    };
  }

  const decoded = decodeAtUtf8Boundary(bounded);
  if (!decoded) {
    return {
      state: 'invalid_encoding',
      text: null,
      truncated: declaredBytes > TRANSCRIPT_INDEX_MAX_BYTES,
      indexedBytes: 0,
      errorCode: 'INVALID_UTF8'
    };
  }
  const truncated = declaredBytes > decoded.byteLength || content.byteLength > decoded.byteLength;
  return {
    state: truncated ? 'truncated' : 'full',
    text: extractCueText(decoded.text, extension),
    truncated,
    indexedBytes: decoded.byteLength,
    errorCode: null
  };
}

export function transcriptEditorEligibility(input: {
  extension: unknown;
  sizeBytes: number | null;
  ingestState: TranscriptIngestState;
}): TranscriptEditorEligibility {
  if (normalizeExtension(input.extension) !== 'txt') {
    return { eligible: false, reason: 'unsupported_format' };
  }
  if (input.sizeBytes === null || input.sizeBytes > TRANSCRIPT_INDEX_MAX_BYTES) {
    return { eligible: false, reason: 'too_large' };
  }
  if (input.ingestState === 'truncated') return { eligible: false, reason: 'truncated' };
  if (input.ingestState === 'invalid_encoding') {
    return { eligible: false, reason: 'invalid_encoding' };
  }
  if (input.ingestState !== 'full') return { eligible: false, reason: 'unavailable' };
  return { eligible: true };
}
