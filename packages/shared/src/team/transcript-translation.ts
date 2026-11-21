/**
 * 063 — translating a finished transcript through Claude.
 *
 * One module for both ends: the browser counts what a text will cost and
 * fingerprints it to tell a stale translation from a current one, and the
 * function does the same before it reserves anything. Because the two run the
 * same code, the number a person is shown is the number they are charged.
 */
import { isRecord } from './contract.js';

/** Allowance key shared by the database, the function and the CLI. */
export const TRANSCRIPT_TRANSLATION_FEATURE = 'transcript_translation';

/**
 * A "minute" of translation is a measure of text, not of video: a one-hour
 * re-stitch with one minute of speech costs one minute. 900 characters is the
 * measured rate of the TR_25 creative (1 841 characters over 2.04 min).
 */
export const TRANSLATION_UNITS_PER_MINUTE = 900;

/** Fallback for display only; the authoritative limit comes from the server. */
export const TRANSLATION_DAILY_UNITS_DEFAULT = 9_000;

/** Bounds the function enforces on a personal (transcriber) source. */
export const TRANSLATION_MAX_SEGMENTS = 4_000;
export const TRANSLATION_MAX_SEGMENT_CHARACTERS = 4_000;

/** Upper bound of one model request; segments are never split. */
export const TRANSLATION_CHUNK_UNITS = 1_500;

/**
 * Target languages: every language the retired TranslateGemma offered, plus the
 * regional variants people ask for by name (es-MX, pt-BR, fr-CA, zh-TW).
 */
export const TRANSLATION_TARGET_LANGUAGES = [
  'uk',
  'en',
  'ru',
  'pl',
  'de',
  'fr',
  'fr-CA',
  'es',
  'es-MX',
  'pt',
  'pt-BR',
  'it',
  'tr',
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'el',
  'et',
  'fa',
  'fi',
  'fil',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'is',
  'ja',
  'kn',
  'ko',
  'lt',
  'lv',
  'ml',
  'mr',
  'nl',
  'no',
  'pa',
  'ro',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'ur',
  'vi',
  'zh',
  'zh-TW',
  'zu'
] as const;

export type TranslationTargetLanguage = (typeof TRANSLATION_TARGET_LANGUAGES)[number];

export function isTranslationTargetLanguage(value: unknown): value is TranslationTargetLanguage {
  return (
    typeof value === 'string' && (TRANSLATION_TARGET_LANGUAGES as readonly string[]).includes(value)
  );
}

/**
 * The primary subtag decides "same language": a transcript heard in `es` is
 * not offered `es` again, but `es-MX` stays available, which is a real choice.
 */
export function sameTranslationLanguage(source: string | null, target: string): boolean {
  if (!source) return false;
  return source.toLowerCase() === target.toLowerCase();
}

export const TRANSLATION_SCOPES = ['team_video', 'personal'] as const;
export type TranslationScope = (typeof TRANSLATION_SCOPES)[number];

export const TRANSLATION_STATUSES = ['processing', 'completed', 'failed'] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];

export const TRANSLATION_FAILURE_CODES = [
  'TRANSLATION_REFUSED',
  'TRANSLATION_UNAVAILABLE',
  'TRANSLATION_FAILED',
  'TRANSLATION_TIMEOUT'
] as const;
export type TranslationFailureCode = (typeof TRANSLATION_FAILURE_CODES)[number];

/** Whitespace of any kind collapses to one space; the edges are trimmed. */
export function normalizeTranslationSegment(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * What a text costs, in characters (code points). Empty segments cost nothing;
 * one space is counted between segments, as if the text were read aloud in one
 * line.
 */
export function translationUnits(segments: readonly string[]): number {
  let total = 0;
  let counted = 0;
  for (const segment of segments) {
    const normalized = normalizeTranslationSegment(segment);
    if (!normalized) continue;
    total += [...normalized].length;
    counted += 1;
  }
  return total + Math.max(0, counted - 1);
}

/** Workspace transcripts are plain text, one speech segment per line. */
export function splitTranscriptLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map(normalizeTranslationSegment)
    .filter(line => line.length > 0);
}

const FINGERPRINT_PATTERN = /^v1:[0-9a-f]{64}$/u;

export function isTranslationFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

/**
 * Identifies the text a translation was made from. Normalized first, so a
 * re-saved transcript with different spacing is still the same text; the
 * segment boundaries are part of it, because the translation is per segment.
 */
export async function translationFingerprint(
  segments: readonly string[],
  subtle: SubtleCrypto = crypto.subtle
): Promise<string> {
  const body = segments.map(normalizeTranslationSegment).join('\n');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`v1\n${body}`));
  const hex = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return `v1:${hex}`;
}

export interface TranslationChunk {
  /** Index of the first segment in the chunk (0-based). */
  start: number;
  /** One past the last segment. */
  end: number;
}

/**
 * Groups segments into requests of at most `maxUnits`, never splitting a
 * segment; a single segment longer than the bound is a chunk of its own.
 * Empty segments ride along with their neighbours.
 */
export function chunkTranslationSegments(
  segments: readonly string[],
  maxUnits: number = TRANSLATION_CHUNK_UNITS
): TranslationChunk[] {
  const chunks: TranslationChunk[] = [];
  let start = 0;
  let units = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const cost = [...normalizeTranslationSegment(segments[index] ?? '')].length;
    if (index > start && units + cost > maxUnits) {
      chunks.push({ start, end: index });
      start = index;
      units = 0;
    }
    units += cost;
  }
  if (segments.length > start) chunks.push({ start, end: segments.length });
  return chunks;
}

export interface TranscriptTranslation {
  id: string;
  scope: TranslationScope;
  targetLanguage: string;
  sourceLanguage: string | null;
  sourceFingerprint: string;
  status: TranslationStatus;
  failureCode: TranslationFailureCode | null;
  /** Present only when `completed`; one string per source segment. */
  segments: string[] | null;
  totalSegments: number;
  completedSegments: number;
  units: number;
  model: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TranslationAllowance {
  feature: string;
  limitUnits: number;
  usedUnits: number;
  day: string;
  resetsAt: string;
}

export type TranslationStreamEvent =
  | {
      type: 'progress';
      status: 'processing';
      completedSegments: number;
      totalSegments: number;
    }
  | { type: 'done'; translation: TranscriptTranslation }
  | { type: 'failed'; code: TranslationFailureCode };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const MODEL_PATTERN = /^claude-[a-z0-9-]{3,40}$/u;

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function parseTranscriptTranslation(value: unknown): TranscriptTranslation | null {
  if (!isRecord(value)) return null;
  const {
    id,
    scope,
    targetLanguage,
    sourceLanguage,
    sourceFingerprint,
    status,
    failureCode,
    segments,
    totalSegments,
    completedSegments,
    units,
    model,
    createdAt,
    completedAt
  } = value;
  if (
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id) ||
    !includes(TRANSLATION_SCOPES, scope) ||
    typeof targetLanguage !== 'string' ||
    !LANGUAGE_PATTERN.test(targetLanguage) ||
    (sourceLanguage !== null &&
      (typeof sourceLanguage !== 'string' || !LANGUAGE_PATTERN.test(sourceLanguage))) ||
    !isTranslationFingerprint(sourceFingerprint) ||
    !includes(TRANSLATION_STATUSES, status) ||
    !isCount(totalSegments, TRANSLATION_MAX_SEGMENTS) ||
    totalSegments < 1 ||
    !isCount(completedSegments, totalSegments) ||
    !isCount(units, 10_000_000) ||
    (model !== null && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) ||
    !isTimestamp(createdAt) ||
    (completedAt !== null && !isTimestamp(completedAt))
  ) {
    return null;
  }
  if (status === 'failed' ? !includes(TRANSLATION_FAILURE_CODES, failureCode) : failureCode !== null) {
    return null;
  }
  let parsedSegments: string[] | null = null;
  if (status === 'completed') {
    if (
      !Array.isArray(segments) ||
      segments.length !== totalSegments ||
      !segments.every(segment => typeof segment === 'string')
    ) {
      return null;
    }
    parsedSegments = segments as string[];
  } else if (segments !== null && segments !== undefined) {
    return null;
  }
  return {
    id,
    scope,
    targetLanguage,
    sourceLanguage: sourceLanguage as string | null,
    sourceFingerprint,
    status,
    failureCode: (failureCode ?? null) as TranslationFailureCode | null,
    segments: parsedSegments,
    totalSegments,
    completedSegments,
    units,
    model: model as string | null,
    createdAt,
    completedAt: completedAt as string | null
  };
}

export function parseTranscriptTranslationList(value: unknown): TranscriptTranslation[] | null {
  if (!isRecord(value) || !Array.isArray(value.translations) || value.translations.length > 200) {
    return null;
  }
  const parsed: TranscriptTranslation[] = [];
  for (const raw of value.translations) {
    const translation = parseTranscriptTranslation(raw);
    if (!translation) return null;
    parsed.push(translation);
  }
  return parsed;
}

export function parseTranslationAllowance(value: unknown): TranslationAllowance | null {
  if (!isRecord(value)) return null;
  const { feature, limitUnits, usedUnits, day, resetsAt } = value;
  if (
    typeof feature !== 'string' ||
    !isCount(limitUnits, 100_000_000) ||
    !isCount(usedUnits, 100_000_000) ||
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    !isTimestamp(resetsAt)
  ) {
    return null;
  }
  return { feature, limitUnits, usedUnits, day, resetsAt };
}

export function parseTranslationStreamEvent(value: unknown): TranslationStreamEvent | null {
  if (!isRecord(value)) return null;
  if (value.type === 'progress') {
    const { completedSegments, totalSegments } = value;
    if (
      value.status !== 'processing' ||
      !isCount(totalSegments, TRANSLATION_MAX_SEGMENTS) ||
      !isCount(completedSegments, totalSegments)
    ) {
      return null;
    }
    return { type: 'progress', status: 'processing', completedSegments, totalSegments };
  }
  if (value.type === 'done') {
    const translation = parseTranscriptTranslation(value.translation);
    return translation && translation.status === 'completed' ? { type: 'done', translation } : null;
  }
  if (value.type === 'failed') {
    return includes(TRANSLATION_FAILURE_CODES, value.code)
      ? { type: 'failed', code: value.code }
      : null;
  }
  return null;
}
