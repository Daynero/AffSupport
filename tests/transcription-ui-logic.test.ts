import { describe, expect, it } from 'vitest';
import type { AlignmentLink, TranscriptWord } from '@video-compressor/shared';
import {
  confidenceColor,
  confidenceGrade,
  mergeRanges,
  resolveMirroredSelection,
  selectionConfidence
} from '../apps/web/src/transcription/alignment.js';
import { activeWordIndex, flattenWords } from '../apps/web/src/transcription/karaoke.js';
import { defaultTranslationTarget, isRtlLanguage } from '../apps/web/src/transcription/language.js';

describe('translation language defaults and direction', () => {
  it('defaults to the Wishly UI language when it differs from the source', () => {
    expect(defaultTranslationTarget('en-US', 'uk')).toBe('uk');
    expect(defaultTranslationTarget('uk-UA', 'en')).toBe('en');
  });

  it('retains the last distinct target and otherwise avoids a same-language request', () => {
    expect(defaultTranslationTarget('en-US', 'en', 'tr')).toBe('tr');
    expect(defaultTranslationTarget('uk-UA', 'uk', 'ar')).toBe('ar');
    expect(defaultTranslationTarget('en', 'en')).toBe('uk');
    expect(defaultTranslationTarget('uk', 'uk')).toBe('en');
  });

  it('applies RTL only to RTL language columns, including regional tags', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('ar-EG')).toBe(true);
    expect(isRtlLanguage('ur_PK')).toBe(true);
    expect(isRtlLanguage('uk')).toBe(false);
    expect(isRtlLanguage('en-US')).toBe(false);
  });
});

const link = (
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
  confidence: number
): AlignmentLink => ({ sourceStart, sourceEnd, targetStart, targetEnd, confidence });

describe('alignment ranges', () => {
  it('merges overlapping and adjacent ranges', () => {
    expect(
      mergeRanges([
        { start: 0, end: 5 },
        { start: 5, end: 8 },
        { start: 20, end: 25 },
        { start: 22, end: 30 }
      ])
    ).toEqual([
      { start: 0, end: 8 },
      { start: 20, end: 30 }
    ]);
  });

  it('resolves a source selection to many target ranges (one-to-many)', () => {
    const links = [link(0, 5, 10, 15, 0.9), link(0, 5, 40, 45, 0.8)];
    const result = resolveMirroredSelection({ start: 0, end: 5 }, links, 'source', 60);
    expect(result.usedFallback).toBe(false);
    expect(result.ranges).toEqual([
      { start: 10, end: 15 },
      { start: 40, end: 45 }
    ]);
    expect(result.confidence).toBeGreaterThan(0.55);
  });

  it('falls back to the whole opposite side with a capped confidence', () => {
    const result = resolveMirroredSelection({ start: 100, end: 110 }, [], 'source', 42);
    expect(result.usedFallback).toBe(true);
    expect(result.ranges).toEqual([{ start: 0, end: 42 }]);
    expect(result.confidence).toBe(0.5);
  });

  it('penalizes selections only partly covered by alignment', () => {
    // Selection spans 0–20 but only 0–5 is aligned → low coverage → low score.
    const links = [link(0, 5, 0, 5, 1)];
    const full = selectionConfidence({ start: 0, end: 5 }, links, 'source');
    const partial = selectionConfidence({ start: 0, end: 20 }, links, 'source');
    expect(full).toBeCloseTo(1, 5);
    expect(partial).toBeLessThan(full);
    expect(partial).toBeLessThanOrEqual(0.25); // unaligned grammatical coverage is penalized
  });

  it('penalizes an incomplete grammatical unit in a many-to-one alignment', () => {
    const links = [
      link(0, 3, 0, 3, 0.96), // "the" → shared "кіт" phrase
      link(4, 7, 0, 3, 0.96) // "cat" → shared "кіт" phrase
    ];
    const complete = resolveMirroredSelection({ start: 0, end: 7 }, links, 'source', 3);
    const incomplete = resolveMirroredSelection({ start: 4, end: 7 }, links, 'source', 3);
    expect(complete.confidence).toBeGreaterThan(incomplete.confidence);
    expect(incomplete.confidence).toBeLessThan(0.9);
  });

  it('pins an identical surface form (e.g. "25" → "25") to full confidence', () => {
    // The aligner scored the link at 0.9, but the selected and mirrored text are
    // byte-identical, so the match is exact.
    const links = [link(0, 2, 0, 2, 0.9)];
    const noisy = resolveMirroredSelection({ start: 0, end: 2 }, links, 'source', 2);
    const exact = resolveMirroredSelection({ start: 0, end: 2 }, links, 'source', 2, {
      origin: '25 people',
      opposite: '25 osib'
    });
    expect(noisy.confidence).toBeLessThan(1);
    expect(exact.confidence).toBe(1);
  });

  it('does not fake confidence when the surface forms differ', () => {
    const links = [link(0, 3, 0, 4, 0.9)];
    const result = resolveMirroredSelection({ start: 0, end: 3 }, links, 'source', 4, {
      origin: 'cat',
      opposite: 'кіт'
    });
    expect(result.confidence).toBeLessThan(1);
  });

  it('grades and colors on a green→yellow scale, never red', () => {
    expect(confidenceGrade(0.95)).toBe('exact');
    expect(confidenceGrade(0.7)).toBe('high');
    expect(confidenceGrade(0.4)).toBe('approx');
    expect(confidenceColor(1)).toContain('var(--color-success) 100%');
    expect(confidenceColor(0.3)).toContain('var(--color-success) 0%');
    expect(confidenceColor(0.3)).toContain('var(--color-warning)');
    expect(confidenceColor(0.3)).not.toContain('red');
  });
});

const word = (startMs: number, endMs: number): TranscriptWord => ({
  id: `w-${startMs}`,
  text: 'x',
  startMs,
  endMs,
  confidence: null,
  sourceStart: 0,
  sourceEnd: 1
});

describe('karaoke active word', () => {
  const words = [word(0, 500), word(600, 1000), word(1000, 1500)];

  it('finds the active word and returns -1 in gaps / out of range', () => {
    expect(activeWordIndex(words, -1)).toBe(-1);
    expect(activeWordIndex(words, 0)).toBe(0);
    expect(activeWordIndex(words, 500)).toBe(0);
    expect(activeWordIndex(words, 550)).toBe(-1); // gap between word 0 and 1
    expect(activeWordIndex(words, 600)).toBe(1);
    expect(activeWordIndex(words, 1000)).toBe(2); // boundary favors the later word
    expect(activeWordIndex(words, 5000)).toBe(-1);
    expect(activeWordIndex([], 100)).toBe(-1);
  });

  it('flattens segment words preserving order + segment ids', () => {
    const flat = flattenWords([
      { id: 's0', words: [word(0, 100)] },
      { id: 's1', words: [word(200, 300), word(300, 400)] }
    ]);
    expect(flat.map(entry => entry.segmentId)).toEqual(['s0', 's1', 's1']);
    expect(flat).toHaveLength(3);
  });
});
