import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@video-compressor/shared';
import { mergeRanges } from '../apps/web/src/transcription/text-ranges.js';
import { activeWordIndex, flattenWords } from '../apps/web/src/transcription/karaoke.js';
import { isRtlLanguage } from '../apps/web/src/transcription/language.js';

describe('translation language defaults and direction', () => {
  it('applies RTL only to RTL language columns, including regional tags', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('ar-EG')).toBe(true);
    expect(isRtlLanguage('ur_PK')).toBe(true);
    expect(isRtlLanguage('uk')).toBe(false);
    expect(isRtlLanguage('en-US')).toBe(false);
  });
});

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
    // A short gap between words keeps the previous word lit; a long one clears it.
    expect(activeWordIndex(words, 550)).toBe(0);
    expect(activeWordIndex([{ ...words[0], startMs: 0, endMs: 100 }], 401)).toBe(-1);
    expect(activeWordIndex([{ ...words[0], startMs: 0, endMs: 100 }], 300)).toBe(0);
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
