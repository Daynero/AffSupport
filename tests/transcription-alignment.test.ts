import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@video-compressor/shared';
import { alignEmbeddingUnits, E5Aligner } from '../apps/agent/src/translation/aligner.js';
import { LlamaTranslator } from '../apps/agent/src/translation/translator.js';
import { describeRequiring, requireEnvFlag } from './support/requires.js';

const unit = (start: number, end: number, text: string, tokenStart: number, tokenEnd: number) => ({
  start,
  end,
  text,
  tokenStart,
  tokenEnd
});

describe('deterministic multilingual alignment logic', () => {
  it('links reordered English → Ukrainian words by semantic vectors', () => {
    const source = [unit(0, 5, 'Hello', 0, 1), unit(6, 11, 'world', 1, 2)];
    const target = [unit(0, 4, 'світ', 0, 1), unit(5, 11, 'Привіт', 1, 2)];
    const links = alignEmbeddingUnits(
      source,
      target,
      source,
      target,
      [
        [1, 0],
        [0, 1]
      ],
      [
        [0, 1],
        [1, 0]
      ]
    );
    expect(links.map(link => [link.sourceStart, link.targetStart])).toEqual([
      [0, 5],
      [6, 0]
    ]);
    expect(links.every(link => link.confidence >= 0.8)).toBe(true);
  });

  it('expands a Turkish token to a multi-token Ukrainian phrase when measured similarity is higher', () => {
    const source = [unit(0, 7, 'yapamam', 0, 1)];
    const targetTokens = [unit(0, 2, 'не', 0, 1), unit(3, 7, 'можу', 1, 2)];
    const targetPhrases = [targetTokens[0], unit(0, 7, 'не можу', 0, 2), targetTokens[1]];
    const links = alignEmbeddingUnits(
      source,
      targetTokens,
      source,
      targetPhrases,
      [[1, 0]],
      [
        [0.8, 0.6],
        [0.99, 0.141],
        [0.2, 0.98]
      ]
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceStart: 0,
      sourceEnd: 7,
      targetStart: 0,
      targetEnd: 7
    });
  });

  it('keeps Arabic character ranges valid without relying on whitespace direction', () => {
    const source = [unit(0, 5, 'مرحبا', 0, 1)];
    const target = [unit(0, 6, 'Привіт', 0, 1)];
    const links = alignEmbeddingUnits(source, target, source, target, [[1]], [[1]]);
    expect(links[0]).toMatchObject({
      sourceStart: 0,
      sourceEnd: 5,
      targetStart: 0,
      targetEnd: 6
    });
  });
});

const realTranslationSmoke = requireEnvFlag('RUN_REAL_TRANSLATION_SMOKE');
describeRequiring(realTranslationSmoke, 'installed multilingual E5 smoke', () => {
  it('produces measured links for English, Turkish, and Arabic → Ukrainian fixtures', async () => {
    const aligner = new E5Aligner();
    expect(aligner.available()).toBe(true);
    const cases = [
      ['en', 'Hello world', 'Привіт, світе'],
      ['tr', 'Bugün eve gidiyorum', 'Сьогодні я йду додому'],
      ['ar', 'أنا ذاهب إلى المنزل', 'Я йду додому']
    ] as const;
    try {
      for (const [sourceLanguage, sourceText, translatedText] of cases) {
        const source: TranscriptSegment = {
          id: sourceLanguage,
          startMs: 0,
          endMs: 1000,
          sourceText,
          words: []
        };
        const links = await aligner.align(
          { source, translatedText, sourceLanguage, targetLanguage: 'uk' },
          new AbortController().signal
        );
        expect(links.length).toBeGreaterThan(0);
        expect(
          links.every(
            link =>
              link.sourceEnd > link.sourceStart &&
              link.targetEnd > link.targetStart &&
              link.confidence >= 0 &&
              link.confidence <= 1
          )
        ).toBe(true);
      }
    } finally {
      await aligner.close();
    }
  }, 60_000);
});

describeRequiring(realTranslationSmoke, 'installed TranslateGemma worker smoke', () => {
  it('translates two language pairs and aligns while the translator stays warm', async () => {
    const translator = new LlamaTranslator();
    const aligner = new E5Aligner();
    expect(translator.available()).toBe(true);
    try {
      const first = await translator.translate(
        {
          sourceLanguage: 'en',
          targetLanguage: 'uk',
          segments: [{ id: 'en', text: 'The meeting starts tomorrow morning.' }]
        },
        new AbortController().signal
      );
      const second = await translator.translate(
        {
          sourceLanguage: 'tr',
          targetLanguage: 'uk',
          segments: [{ id: 'tr', text: 'Bugün hava güzel.' }]
        },
        new AbortController().signal
      );
      expect(first[0].sourceSegmentId).toBe('en');
      expect(second[0].sourceSegmentId).toBe('tr');
      expect(first[0].translatedText).toMatch(/[А-Яа-яІіЇїЄєҐґ]/u);
      expect(second[0].translatedText).toMatch(/[А-Яа-яІіЇїЄєҐґ]/u);
      expect(first[0].translatedText).not.toBe('The meeting starts tomorrow morning.');
      expect(second[0].translatedText).not.toBe('Bugün hava güzel.');

      const alignmentStartedAt = Date.now();
      const links = await aligner.align(
        {
          source: {
            id: 'warm-worker',
            startMs: 0,
            endMs: 1000,
            sourceText: 'The meeting starts tomorrow morning.',
            words: []
          },
          translatedText: first[0].translatedText,
          sourceLanguage: 'en',
          targetLanguage: 'uk'
        },
        new AbortController().signal
      );
      expect(links.length).toBeGreaterThan(0);
      expect(Date.now() - alignmentStartedAt).toBeLessThan(15_000);
    } finally {
      await aligner.close();
      await translator.close();
    }
  }, 120_000);
});
