/**
 * transcript-translate (063): `start` a translation and `watch` it until it is done.
 *
 * Pure: every dependency arrives through `TranslateDeps`, so vitest drives it with a fake model
 * and a fake database. The rules:
 *   - a space's text is read by the server, with the caller's own rights, never taken from the
 *     browser; a transcriber's text arrives with the request because it lives on the person's disk;
 *   - the same text in the same language is never paid for twice;
 *   - the allowance is reserved before the model is called and given back on any failure.
 */
// @deno-types="../../../packages/shared/dist/team/transcript-translation.d.ts"
import {
  groupTranslationUnits,
  isTranslationTargetLanguage,
  parseTranscriptTranslation,
  sameTranslationLanguage,
  splitTranscriptLines,
  TRANSCRIPT_TRANSLATION_FEATURE,
  TRANSLATION_MAX_SEGMENT_CHARACTERS,
  TRANSLATION_MAX_SEGMENTS,
  translationFingerprint,
  translationUnits,
  type TranscriptTranslation,
  type TranslationAllowance,
  type TranslationStreamEvent
} from '../../../packages/shared/dist/team/transcript-translation.js';
// @deno-types="../../../packages/shared/dist/team/ai-credits.d.ts"
import {
  AI_CREDIT_USD,
  AI_PRICE_VERSION,
  translationPrice
} from '../../../packages/shared/dist/team/ai-credits.js';
import { recordModelUsage, type Rpc } from '../_shared/ai-allowance.ts';
import { creditRefusal, translationUpperUsd } from '../_shared/ai-credits.ts';
import type { ClaudeClient } from '../_shared/claude.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { translateTranscript } from './translate.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DOCUMENT_KEY = /^[A-Za-z0-9_-]{1,80}$/u;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

export type TranslateSource =
  | { scope: 'team_video'; teamId: string; videoId: string }
  | {
      scope: 'personal';
      documentKey: string;
      sourceLanguage: string | null;
      segments: string[];
    };

export type TranslateCommand =
  | {
      action: 'start';
      targetLanguage: string;
      source: TranslateSource;
      /** 064: the price the button showed; absent from a client older than credits. */
      expectedPrice: number | null;
      priceVersion: string | null;
    }
  | { action: 'watch'; translationId: string };

function invalid(): never {
  throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
}

export function parseTranslateCommand(body: unknown): TranslateCommand {
  if (!isRecord(body)) invalid();
  if (body.action === 'watch') {
    if (typeof body.translationId !== 'string' || !UUID.test(body.translationId)) invalid();
    return { action: 'watch', translationId: body.translationId.toLowerCase() };
  }
  if (body.action !== 'start' || !isTranslationTargetLanguage(body.targetLanguage)) invalid();
  const expectedPrice =
    typeof body.expectedPrice === 'number' &&
    Number.isInteger(body.expectedPrice) &&
    body.expectedPrice > 0
      ? body.expectedPrice
      : null;
  const priceVersion = typeof body.priceVersion === 'string' ? body.priceVersion : null;
  const source = body.source;
  if (!isRecord(source)) invalid();
  if (source.scope === 'team_video') {
    if (
      typeof source.teamId !== 'string' ||
      !UUID.test(source.teamId) ||
      typeof source.videoId !== 'string' ||
      !UUID.test(source.videoId)
    ) {
      invalid();
    }
    return {
      action: 'start',
      targetLanguage: body.targetLanguage,
      source: { scope: 'team_video', teamId: source.teamId, videoId: source.videoId },
      expectedPrice,
      priceVersion
    };
  }
  if (source.scope === 'personal') {
    const { documentKey, sourceLanguage, segments } = source;
    if (
      typeof documentKey !== 'string' ||
      !DOCUMENT_KEY.test(documentKey) ||
      (sourceLanguage !== null &&
        (typeof sourceLanguage !== 'string' || !LANGUAGE.test(sourceLanguage))) ||
      !Array.isArray(segments) ||
      segments.length < 1 ||
      segments.length > TRANSLATION_MAX_SEGMENTS ||
      !segments.every(
        segment =>
          typeof segment === 'string' && segment.length <= TRANSLATION_MAX_SEGMENT_CHARACTERS
      )
    ) {
      invalid();
    }
    return {
      action: 'start',
      targetLanguage: body.targetLanguage,
      source: {
        scope: 'personal',
        documentKey,
        sourceLanguage: (sourceLanguage as string | null) ?? null,
        segments: segments as string[]
      },
      expectedPrice,
      priceVersion
    };
  }
  invalid();
}

export interface TranslateDeps {
  userId: string;
  /** PostgREST calls made with the caller's own token (their rights). */
  callerRpc: Rpc;
  /** Service-role calls: begin/progress/complete/fail and the ledger. */
  serviceRpc: Rpc;
  /** null when no model is configured: nothing is reserved, the answer is UNAVAILABLE. */
  client: ClaudeClient | null;
  /** Keeps the background translation alive after the response (EdgeRuntime.waitUntil). */
  background: (work: Promise<void>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  watchPollMs?: number;
  watchLimitMs?: number;
}

function rpcCode(error: { message?: string; code?: string } | null): string | null {
  if (!error) return null;
  const text = `${error.message ?? ''} ${error.code ?? ''}`;
  return text.match(/[A-Z][A-Z0-9_]{3,}/u)?.[0] ?? null;
}

function failFromRpc(error: { message?: string; code?: string } | null): never {
  const code = rpcCode(error);
  if (code === 'PERMISSION_DENIED' || code === 'NOT_A_MEMBER') {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  if (code === 'NOT_FOUND') throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  if (code === 'AUTH_REQUIRED') throw new TeamFunctionError('AUTH_REQUIRED', { retryable: false });
  if (code === 'INVALID_INPUT') invalid();
  throw new TeamFunctionError('TRANSLATION_UNAVAILABLE', { retryable: true });
}

interface ResolvedSource {
  scope: 'team_video' | 'personal';
  teamId: string | null;
  videoId: string | null;
  documentKey: string | null;
  sourceLanguage: string | null;
  segments: string[];
}

async function resolveSource(
  source: TranslateSource,
  deps: TranslateDeps
): Promise<ResolvedSource> {
  if (source.scope === 'personal') {
    return {
      scope: 'personal',
      teamId: null,
      videoId: null,
      documentKey: source.documentKey,
      sourceLanguage: source.sourceLanguage,
      segments: source.segments
    };
  }
  const { data, error } = await deps.callerRpc('list_video_text_variants', {
    p_team: source.teamId,
    p_video: source.videoId
  });
  if (error) failFromRpc(error);
  const variants = isRecord(data) && Array.isArray(data.variants) ? data.variants : [];
  const original = variants.find(
    variant =>
      isRecord(variant) &&
      variant.kind === 'original' &&
      variant.ingestState === 'full' &&
      variant.truncated === false &&
      typeof variant.text === 'string'
  ) as Record<string, unknown> | undefined;
  const segments = original ? splitTranscriptLines(original.text as string) : [];
  if (segments.length === 0 || segments.length > TRANSLATION_MAX_SEGMENTS) {
    throw new TeamFunctionError('TRANSLATION_SOURCE_UNAVAILABLE', { retryable: false });
  }
  const language =
    typeof original?.language === 'string' && LANGUAGE.test(original.language)
      ? original.language
      : null;
  return {
    scope: 'team_video',
    teamId: source.teamId,
    videoId: source.videoId,
    documentKey: null,
    sourceLanguage: language,
    segments
  };
}

export interface StartResult {
  translationId: string;
  status: 'processing' | 'completed';
  reused: boolean;
  units: number;
  allowance: TranslationAllowance | null;
  /** 064: the credits charged (0 when joining a translation already started) and the balance. */
  price?: number;
  credits?: unknown;
}

export async function startTranslation(
  command: Extract<TranslateCommand, { action: 'start' }>,
  deps: TranslateDeps
): Promise<StartResult> {
  const source = await resolveSource(command.source, deps);
  if (sameTranslationLanguage(source.sourceLanguage, command.targetLanguage)) invalid();
  const units = translationUnits(source.segments);
  if (units <= 0)
    throw new TeamFunctionError('TRANSLATION_SOURCE_UNAVAILABLE', { retryable: false });
  const fingerprint = await translationFingerprint(source.segments);
  // Checked before anything is charged: without a model there is nothing to pay for.
  if (!deps.client) throw new TeamFunctionError('TRANSLATION_UNAVAILABLE', { retryable: true });
  // 064: the price is the one the button showed, or nothing is charged and nothing runs.
  const price = translationPrice(units, command.targetLanguage);
  if (command.expectedPrice === null)
    throw new TeamFunctionError('CLIENT_UPGRADE', { retryable: false });
  if (command.expectedPrice !== price || command.priceVersion !== AI_PRICE_VERSION) {
    throw new TeamFunctionError('PRICE_CHANGED', {
      retryable: false,
      details: { price, priceVersion: AI_PRICE_VERSION }
    });
  }
  const credited = await deps.serviceRpc('service_transcript_translation_begin_credits', {
    p_scope: source.scope,
    p_team: source.teamId,
    p_video: source.videoId,
    p_owner: source.scope === 'personal' ? deps.userId : null,
    p_document_key: source.documentKey,
    p_fingerprint: fingerprint,
    p_source_language: source.sourceLanguage,
    p_target_language: command.targetLanguage,
    p_total_segments: groupTranslationUnits(source.segments).length,
    p_units: units,
    p_requested_by: deps.userId,
    p_price: price,
    p_price_version: AI_PRICE_VERSION,
    p_usd_upper: Number(translationUpperUsd(price, AI_CREDIT_USD).toFixed(8))
  });
  if (credited.error) {
    const refusal = creditRefusal(credited.error);
    if (refusal && refusal.code !== 'KEY_REUSED') {
      const details: Record<string, string | number | boolean | null> = { price };
      for (const [key, value] of Object.entries(refusal.details))
        if (['string', 'number', 'boolean'].includes(typeof value))
          details[key] = value as string | number | boolean;
      throw new TeamFunctionError(refusal.code, { retryable: false, details });
    }
    failFromRpc(credited.error);
  }
  const begun = credited.data;
  if (!isRecord(begun) || typeof begun.id !== 'string' || !UUID.test(begun.id)) {
    throw new TeamFunctionError('TRANSLATION_UNAVAILABLE', { retryable: true });
  }
  const reusedCredit = begun.reused === true;
  if (!reusedCredit) {
    deps.background(
      runTranslation(
        begun.id,
        source,
        command.targetLanguage,
        deps,
        typeof begun.opKey === 'string' ? begun.opKey : null
      )
    );
  }
  return {
    translationId: begun.id,
    status: begun.status === 'completed' ? 'completed' : 'processing',
    reused: reusedCredit,
    units,
    allowance: null,
    price: reusedCredit ? 0 : price,
    credits: begun.credits ?? null
  };
}

async function runTranslation(
  translationId: string,
  source: ResolvedSource,
  targetLanguage: string,
  deps: TranslateDeps,
  opKey: string | null = null
): Promise<void> {
  try {
    const result = await translateTranscript({
      client: deps.client!,
      segments: source.segments,
      sourceLanguage: source.sourceLanguage,
      targetLanguage,
      now: deps.now,
      record: entry =>
        recordModelUsage(deps.serviceRpc, {
          feature: TRANSCRIPT_TRANSLATION_FEATURE,
          userId: deps.userId,
          subjectId: translationId,
          entry,
          opKey
        }),
      onProgress: async completed => {
        await deps.serviceRpc('service_transcript_translation_progress', {
          p_id: translationId,
          p_completed: completed
        });
      }
    });
    if (result.ok) {
      const { error } = await deps.serviceRpc('service_transcript_translation_complete', {
        p_id: translationId,
        p_segments: result.segments,
        p_model: result.model
      });
      if (!error) return;
      console.error('translation complete failed', rpcCode(error) ?? 'unknown');
      await deps.serviceRpc('service_transcript_translation_fail', {
        p_id: translationId,
        p_code: 'TRANSLATION_FAILED'
      });
      return;
    }
    await deps.serviceRpc('service_transcript_translation_fail', {
      p_id: translationId,
      p_code: result.code
    });
  } catch (error) {
    console.error('translation run failed', error instanceof Error ? error.name : 'unknown');
    await deps.serviceRpc('service_transcript_translation_fail', {
      p_id: translationId,
      p_code: 'TRANSLATION_FAILED'
    });
  }
}

async function readTranslation(id: string, deps: TranslateDeps): Promise<TranscriptTranslation> {
  const { data, error } = await deps.callerRpc('get_transcript_translation', { p_id: id });
  if (error) failFromRpc(error);
  const parsed = parseTranscriptTranslation(data);
  if (!parsed) throw new TeamFunctionError('TRANSLATION_UNAVAILABLE', { retryable: true });
  return parsed;
}

/**
 * Lines of NDJSON until the attempt ends or the watch limit passes. The first read happens
 * before the stream opens, so a foreign or missing id is an ordinary error response.
 */
export async function watchTranslation(
  command: Extract<TranslateCommand, { action: 'watch' }>,
  deps: TranslateDeps
): Promise<ReadableStream<Uint8Array>> {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollMs = deps.watchPollMs ?? 750;
  const limitMs = deps.watchLimitMs ?? 330_000;
  const first = await readTranslation(command.translationId, deps);
  const encoder = new TextEncoder();
  const line = (event: TranslationStreamEvent) => encoder.encode(`${JSON.stringify(event)}\n`);
  const terminal = (translation: TranscriptTranslation): TranslationStreamEvent | null =>
    translation.status === 'completed'
      ? { type: 'done', translation }
      : translation.status === 'failed' && translation.failureCode
        ? { type: 'failed', code: translation.failureCode }
        : null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const deadline = now() + limitMs;
      let current = first;
      let lastCompleted = -1;
      try {
        while (!cancelled) {
          const end = terminal(current);
          if (end) {
            controller.enqueue(line(end));
            break;
          }
          if (current.completedSegments !== lastCompleted) {
            lastCompleted = current.completedSegments;
            controller.enqueue(
              line({
                type: 'progress',
                status: 'processing',
                completedSegments: current.completedSegments,
                totalSegments: current.totalSegments
              })
            );
          }
          if (now() >= deadline) break;
          await sleep(pollMs);
          if (cancelled) break;
          current = await readTranslation(command.translationId, deps);
        }
      } catch {
        // The reader reconnects; a failed read is not the translation's failure.
      }
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    }
  });
}
