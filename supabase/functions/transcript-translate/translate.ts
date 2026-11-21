/**
 * Translating one transcript (063): chunks in parallel, each with the whole transcript as
 * context, a retry for a malformed answer, and one escalation to a stronger model when the first
 * declines. Pure apart from the injected client and callbacks.
 */
// @deno-types="../../../packages/shared/dist/team/transcript-translation.d.ts"
import {
  chunkTranslationSegments,
  normalizeTranslationSegment,
  type TranslationChunk,
  type TranslationFailureCode
} from '../../../packages/shared/dist/team/transcript-translation.js';
import {
  callStructured,
  type ClaudeClient,
  type ClaudeEffort,
  type ClaudeModel,
  type UsageRecord
} from '../_shared/claude.ts';

export const PRIMARY: { model: ClaudeModel; effort: ClaudeEffort } = {
  model: 'claude-haiku-5-5',
  effort: 'high'
};
export const ESCALATION: { model: ClaudeModel; effort: ClaudeEffort } = {
  model: 'claude-sonnet-5-5',
  effort: 'low'
};
const CONCURRENCY = 3;
const MAX_TOKENS = 16_000;
export const TRANSLATION_BUDGET_MS = 240_000;

const SCHEMA = {
  type: 'object',
  properties: { translations: { type: 'array', items: { type: 'string' } } },
  required: ['translations'],
  additionalProperties: false
} as const;

export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/**
 * Says what the product does, truthfully: a translation shown next to the original so a reader
 * understands the video. Measured on 2026-11-21: describing the job as ad localization made models
 * decline; this description did not, and it is the accurate one.
 */
export function systemPrompt(target: string): string {
  const name = languageName(target);
  return [
    `You translate a video transcript into ${name} for a reader who does not speak the source language. The translation is shown next to the original transcript so the reader can understand exactly what the video says; it is for reading and review, not for publishing.`,
    'Rules:',
    `- Translate faithfully and completely into natural ${name}. Do not summarize, comment, soften, add or omit anything.`,
    '- The transcript is given as numbered lines. Translate only the requested lines, one output string per line, in the same order.',
    '- Keep personal names exactly as spelled in the source when the target language uses the same script; when it uses another script, transliterate them by how they are pronounced in the source language. Keep numbers, units and brand names as in the source.',
    '- Reply with JSON only: {"translations": [ ... ]}.'
  ].join('\n');
}

export function userPrompt(
  segments: readonly string[],
  chunk: TranslationChunk,
  sourceLanguage: string | null
): string {
  const lines = segments.map(
    (segment, index) => `${index + 1}. ${normalizeTranslationSegment(segment)}`
  );
  const count = chunk.end - chunk.start;
  return [
    `Source language: ${sourceLanguage ? languageName(sourceLanguage) : 'unknown — detect it'}.`,
    'Full transcript for context:',
    '<transcript>',
    ...lines,
    '</transcript>',
    `Translate lines ${chunk.start + 1}–${chunk.end} (${count} line${count === 1 ? '' : 's'}).`
  ].join('\n');
}

function translationsOf(value: unknown, expected: number): string[] | null {
  if (!value || typeof value !== 'object') return null;
  const list = (value as Record<string, unknown>).translations;
  if (!Array.isArray(list) || list.length !== expected) return null;
  if (!list.every(item => typeof item === 'string')) return null;
  return (list as string[]).map(item => item.trim());
}

export type TranslationResult =
  | { ok: true; segments: string[]; model: ClaudeModel }
  | { ok: false; code: TranslationFailureCode };

export interface TranslateInput {
  client: ClaudeClient;
  segments: readonly string[];
  sourceLanguage: string | null;
  targetLanguage: string;
  record: (entry: UsageRecord) => Promise<void>;
  onProgress: (completedSegments: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  chunkUnits?: number;
}

class Stop extends Error {
  constructor(readonly code: TranslationFailureCode) {
    super(code);
  }
}

export async function translateTranscript(input: TranslateInput): Promise<TranslationResult> {
  const now = input.now ?? Date.now;
  const deadline = now() + TRANSLATION_BUDGET_MS;
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), TRANSLATION_BUDGET_MS);
  input.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const system = systemPrompt(input.targetLanguage);
  const output: (string | null)[] = input.segments.map(segment =>
    normalizeTranslationSegment(segment) ? null : ''
  );
  let usedModel: ClaudeModel = PRIMARY.model;
  let completed = output.filter(value => value === '').length;

  const runChunk = async (chunk: TranslationChunk, depth: number): Promise<void> => {
    const expected = chunk.end - chunk.start;
    const ask = (tier: { model: ClaudeModel; effort: ClaudeEffort }) =>
      callStructured(
        input.client,
        {
          model: tier.model,
          effort: tier.effort,
          system,
          user: userPrompt(input.segments, chunk, input.sourceLanguage),
          schema: SCHEMA,
          maxTokens: MAX_TOKENS
        },
        { signal: controller.signal, record: input.record, now }
      );
    let outcome = await ask(PRIMARY);
    let tier = PRIMARY;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (controller.signal.aborted || now() > deadline) throw new Stop('TRANSLATION_TIMEOUT');
      if (outcome.ok) {
        const lines = translationsOf(outcome.value, expected);
        if (lines) {
          lines.forEach((line, index) => {
            const at = chunk.start + index;
            if (output[at] === null) completed += 1;
            output[at] = output[at] === '' ? '' : line;
          });
          if (tier.model !== PRIMARY.model) usedModel = tier.model;
          await input.onProgress(completed);
          return;
        }
        if (attempt === 0) {
          outcome = await ask(tier);
          continue;
        }
        throw new Stop('TRANSLATION_FAILED');
      }
      switch (outcome.reason) {
        case 'refused':
          if (tier.model === PRIMARY.model) {
            tier = ESCALATION;
            outcome = await ask(ESCALATION);
            attempt -= 1;
            continue;
          }
          throw new Stop('TRANSLATION_REFUSED');
        case 'unavailable':
          throw new Stop(
            controller.signal.aborted ? 'TRANSLATION_TIMEOUT' : 'TRANSLATION_UNAVAILABLE'
          );
        case 'truncated':
          if (depth === 0 && expected >= 2) {
            const middle = chunk.start + Math.floor(expected / 2);
            await runChunk({ start: chunk.start, end: middle }, 1);
            await runChunk({ start: middle, end: chunk.end }, 1);
            return;
          }
          throw new Stop('TRANSLATION_FAILED');
        case 'invalid_output':
          if (attempt === 0) {
            outcome = await ask(tier);
            continue;
          }
          throw new Stop('TRANSLATION_FAILED');
      }
    }
    throw new Stop('TRANSLATION_FAILED');
  };

  const pending = chunkTranslationSegments(input.segments, input.chunkUnits).filter(chunk =>
    input.segments
      .slice(chunk.start, chunk.end)
      .some(segment => normalizeTranslationSegment(segment))
  );
  let failure: TranslationFailureCode | null = null;
  const worker = async () => {
    while (pending.length > 0 && failure === null) {
      const chunk = pending.shift()!;
      try {
        await runChunk(chunk, 0);
      } catch (error) {
        failure ??= error instanceof Stop ? error.code : 'TRANSLATION_FAILED';
        controller.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  } finally {
    clearTimeout(budget);
  }
  if (failure) return { ok: false, code: failure };
  if (output.some(value => value === null)) return { ok: false, code: 'TRANSLATION_FAILED' };
  return { ok: true, segments: output as string[], model: usedModel };
}
