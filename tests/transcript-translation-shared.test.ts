import { describe, expect, it } from 'vitest';
import {
  chunkTranslationSegments,
  groupTranslationUnits,
  isTranslationTargetLanguage,
  parseTranscriptTranslation,
  parseTranscriptTranslationList,
  parseTranslationAllowance,
  parseTranslationStreamEvent,
  sameTranslationLanguage,
  splitTranscriptLines,
  translationFingerprint,
  translationUnits,
  TRANSLATION_TARGET_LANGUAGES,
  TRANSLATION_UNITS_PER_MINUTE
} from '../packages/shared/src/team/transcript-translation.js';

/**
 * 063: what a text costs and which text a translation was made from. The browser and the
 * function both run this module, so a person is charged the number they were shown.
 */

const TR25 = [
  'Penisin artık ölü, hiçbir hareket yok, hiçbir kıvılcım yok, sadece tamamen boşluk.',
  'Ve sen hala bu aşağılayıcı işlemlere katlanıyor, haplar yutuyor ve her şeyin kendiliğinden geçmesini umuyorsun.',
  'Sabah bir tablet ve 24 saat içinde ağırlık hissinin kaybolduğunu hissedeceksin.'
];

const completed = {
  id: '11111111-1111-4111-8111-111111111111',
  scope: 'team_video',
  targetLanguage: 'uk',
  sourceLanguage: 'tr',
  sourceFingerprint: `v1:${'a'.repeat(64)}`,
  status: 'completed',
  failureCode: null,
  segments: ['один', 'два'],
  totalSegments: 2,
  completedSegments: 2,
  units: 12,
  model: 'claude-haiku-5-5',
  createdAt: '2026-11-21T10:00:00Z',
  completedAt: '2026-11-21T10:00:20Z'
};

describe('translation units', () => {
  it('counts characters of the text, not the video, with one space between segments', () => {
    expect(translationUnits(['abc', 'de'])).toBe(6);
    expect(translationUnits(['  a \n b\t', '', '   '])).toBe(3);
    expect(translationUnits([])).toBe(0);
  });

  it('counts code points, so Cyrillic and emoji cost a character each', () => {
    expect(translationUnits(['привіт'])).toBe(6);
    expect(translationUnits(['🙂'])).toBe(1);
  });

  it('prices a minute at 900 characters', () => {
    expect(TRANSLATION_UNITS_PER_MINUTE).toBe(900);
    const units = translationUnits(TR25);
    expect(units).toBeGreaterThan(200);
    expect(units).toBe(TR25.join(' ').length);
  });
});

describe('translation fingerprint', () => {
  it('ignores spacing but not wording or segment boundaries', async () => {
    const base = await translationFingerprint(['one two', 'three']);
    expect(base).toMatch(/^v1:[0-9a-f]{64}$/u);
    expect(await translationFingerprint(['  one   two ', 'three\n'])).toBe(base);
    expect(await translationFingerprint(['one two three'])).not.toBe(base);
    expect(await translationFingerprint(['one two', 'four'])).not.toBe(base);
  });
});

describe('chunks', () => {
  it('never splits a segment and keeps every chunk within the bound', () => {
    const segments = Array.from({ length: 40 }, (_, index) => 'x'.repeat(100 + index));
    const chunks = chunkTranslationSegments(segments, 1_500);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(segments.length);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index]!.start).toBe(chunks[index - 1]!.end);
    }
    for (const chunk of chunks) {
      const units = segments.slice(chunk.start, chunk.end).reduce((sum, s) => sum + s.length, 0);
      expect(units <= 1_500 || chunk.end - chunk.start === 1).toBe(true);
    }
  });

  it('gives an oversized segment a chunk of its own', () => {
    expect(chunkTranslationSegments(['a', 'b'.repeat(2_000), 'c'], 1_500)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 }
    ]);
  });
});

describe('languages', () => {
  it('offers regional variants people ask for', () => {
    for (const code of ['uk', 'es-MX', 'pt-BR', 'zh-TW']) {
      expect(isTranslationTargetLanguage(code)).toBe(true);
    }
    expect(isTranslationTargetLanguage('klingon')).toBe(false);
    expect(new Set(TRANSLATION_TARGET_LANGUAGES).size).toBe(TRANSLATION_TARGET_LANGUAGES.length);
  });

  it('treats es and es-MX as different targets', () => {
    expect(sameTranslationLanguage('es', 'es')).toBe(true);
    expect(sameTranslationLanguage('es', 'es-MX')).toBe(false);
    expect(sameTranslationLanguage(null, 'uk')).toBe(false);
  });

  it('splits a space transcript into its non-empty lines', () => {
    expect(splitTranscriptLines('one\r\n\n  two  \n')).toEqual(['one', 'two']);
  });
});

describe('parsers', () => {
  it('accepts a finished translation and rejects a segment count that does not match', () => {
    expect(parseTranscriptTranslation(completed)?.segments).toEqual(['один', 'два']);
    expect(parseTranscriptTranslation({ ...completed, segments: ['один'] })).toBeNull();
    expect(parseTranscriptTranslation({ ...completed, model: 'gpt-5' })).toBeNull();
  });

  it('requires a failure code exactly when failed', () => {
    const failed = {
      ...completed,
      status: 'failed',
      segments: null,
      failureCode: 'TRANSLATION_REFUSED'
    };
    expect(parseTranscriptTranslation(failed)?.failureCode).toBe('TRANSLATION_REFUSED');
    expect(parseTranscriptTranslation({ ...failed, failureCode: null })).toBeNull();
    expect(
      parseTranscriptTranslation({ ...completed, failureCode: 'TRANSLATION_FAILED' })
    ).toBeNull();
  });

  it('reads a list, the allowance and stream events', () => {
    expect(parseTranscriptTranslationList({ translations: [completed] })).toHaveLength(1);
    expect(parseTranscriptTranslationList({ translations: [{}] })).toBeNull();
    expect(
      parseTranslationAllowance({
        feature: 'transcript_translation',
        limitUnits: 9000,
        usedUnits: 100,
        day: '2026-11-21',
        resetsAt: '2026-11-21T22:00:00Z'
      })?.limitUnits
    ).toBe(9000);
    expect(
      parseTranslationStreamEvent({
        type: 'progress',
        status: 'processing',
        completedSegments: 3,
        totalSegments: 2
      })
    ).toBeNull();
    expect(parseTranslationStreamEvent({ type: 'done', translation: completed })?.type).toBe(
      'done'
    );
    expect(parseTranslationStreamEvent({ type: 'failed', code: 'TRANSLATION_TIMEOUT' })).toEqual({
      type: 'failed',
      code: 'TRANSLATION_TIMEOUT'
    });
  });
});

describe('sentence units', () => {
  it('joins recognizer pieces until a sentence ends and covers every segment', () => {
    const units = groupTranslationUnits([
      'Що це за елемент і де',
      'можна його отримати? У 70 чи 80',
      '',
      'років ви навіть.',
      'Дайте мені 30 секунд!',
      ''
    ]);
    expect(units.map(unit => unit.text)).toEqual([
      'Що це за елемент і де можна його отримати? У 70 чи 80 років ви навіть.',
      'Дайте мені 30 секунд!'
    ]);
    expect(units.map(unit => [unit.start, unit.end])).toEqual([
      [0, 4],
      [4, 6]
    ]);
  });

  it('bounds a transcript without punctuation', () => {
    const units = groupTranslationUnits(Array.from({ length: 20 }, () => 'no punctuation here'));
    expect(units.every(unit => unit.end - unit.start <= 8)).toBe(true);
    expect(units.at(-1)!.end).toBe(20);
  });
});
