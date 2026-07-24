import { describe, expect, it } from 'vitest';
import {
  buildSegmentsFromWords,
  mergeChunkWords,
  parseWhisperFullJson,
  type WhisperWord
} from '../apps/agent/src/whisper/words.js';

const FULL_JSON = JSON.stringify({
  transcription: [
    {
      offsets: { from: 0, to: 1200 },
      text: ' Hello world.',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.5 },
        { text: ' Hello', offsets: { from: 0, to: 500 }, p: 0.9 },
        { text: ' wor', offsets: { from: 500, to: 800 }, p: 0.8 },
        { text: 'ld', offsets: { from: 800, to: 1000 }, p: 0.7 },
        { text: '.', offsets: { from: 1000, to: 1100 }, p: 0.95 },
        { text: '<|endoftext|>', offsets: { from: 1100, to: 1100 }, p: 0.99 }
      ]
    }
  ]
});

describe('parseWhisperFullJson', () => {
  it('merges sub-word tokens into words, applies the chunk offset, skips specials', () => {
    const words = parseWhisperFullJson(FULL_JSON, 10_000);
    expect(words).toHaveLength(2);
    expect(words[0]).toMatchObject({
      text: 'Hello',
      leadingSpace: true,
      startMs: 10_000,
      endMs: 10_500
    });
    expect(words[0].confidence).toBeCloseTo(0.9, 5);
    // " wor" + "ld" + "." collapse into one visible word with a spanning time.
    expect(words[1]).toMatchObject({
      text: 'world.',
      leadingSpace: true,
      startMs: 10_500,
      endMs: 11_100
    });
    expect(words[1].confidence).toBeCloseTo((0.8 + 0.7 + 0.95) / 3, 5);
  });

  it('is tolerant of malformed JSON and missing offsets', () => {
    expect(parseWhisperFullJson('not json', 0)).toEqual([]);
    expect(parseWhisperFullJson(JSON.stringify({ transcription: 'nope' }), 0)).toEqual([]);
    const noOffsets = JSON.stringify({
      transcription: [{ tokens: [{ text: ' hi' }, { text: ' there', offsets: {} }] }]
    });
    expect(parseWhisperFullJson(noOffsets, 0)).toEqual([]);
  });

  it('keeps no-space script tokens separately timestamped for smooth CJK karaoke', () => {
    const words = parseWhisperFullJson(
      JSON.stringify({
        transcription: [
          {
            tokens: [
              { text: '今日', offsets: { from: 0, to: 300 }, p: 0.9 },
              { text: '天気', offsets: { from: 300, to: 650 }, p: 0.85 },
              { text: '。', offsets: { from: 650, to: 700 }, p: 0.95 }
            ]
          }
        ]
      }),
      2_000
    );
    expect(words.map(word => [word.text, word.startMs, word.endMs])).toEqual([
      ['今日', 2_000, 2_300],
      ['天気。', 2_300, 2_700]
    ]);
  });

  it('preserves Arabic punctuation, spacing, confidence, and monotonic offsets', () => {
    const words = parseWhisperFullJson(
      JSON.stringify({
        transcription: [
          {
            tokens: [
              { text: ' مرحبًا', offsets: { from: 0, to: 420 }, p: 0.91 },
              { text: ' بالعالم', offsets: { from: 420, to: 880 }, p: 0.87 },
              { text: '؟', offsets: { from: 880, to: 940 }, p: 0.95 }
            ]
          }
        ]
      }),
      1_500
    );
    expect(words.map(word => word.text)).toEqual(['مرحبًا', 'بالعالم؟']);
    expect(words.map(word => [word.startMs, word.endMs])).toEqual([
      [1_500, 1_920],
      [1_920, 2_440]
    ]);
    expect(words[1].confidence).toBeCloseTo((0.87 + 0.95) / 2, 5);
  });
});

function w(text: string, startMs: number, endMs: number, leadingSpace = true): WhisperWord {
  return { text, startMs, endMs, leadingSpace, confidence: null };
}

describe('mergeChunkWords', () => {
  it('dedups words repeated across the ~50% chunk overlap and stays monotonic', () => {
    const merged = mergeChunkWords([
      [w('Hello', 0, 500), w('world', 500, 1000)],
      [w('world', 480, 1000), w('again', 1000, 1500)]
    ]);
    expect(merged.map(word => word.text)).toEqual(['Hello', 'world', 'again']);
    // the duplicate "world" from the overlapping window is dropped; timestamps
    // never go backwards.
    expect(merged.map(word => [word.startMs, word.endMs])).toEqual([
      [0, 500],
      [500, 1000],
      [1000, 1500]
    ]);
  });

  it('clamps an inverted span without dropping the word', () => {
    const merged = mergeChunkWords([[w('a', 0, 900), w('b', 400, 300)]]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ startMs: 0, endMs: 400 });
    expect(merged[1]).toMatchObject({ startMs: 400, endMs: 400 });
  });

  it('does not deduplicate genuinely repeated zero-length words at different times', () => {
    const merged = mergeChunkWords([[w('yes', 1_000, 1_000), w('yes', 1_800, 1_800)]]);
    expect(merged.map(word => word.startMs)).toEqual([1_000, 1_800]);
  });

  it('never accumulates timing drift while repairing many slightly overlapping words', () => {
    const input = Array.from({ length: 120 }, (_, index) =>
      w(`w${index}`, index * 400, index * 400 + 450)
    );
    const merged = mergeChunkWords([input]);
    expect(merged).toHaveLength(120);
    expect(merged[100].startMs).toBe(40_000);
    expect(merged[119].startMs).toBe(47_600);
    expect(
      merged.every((word, index) => index === 0 || word.startMs >= merged[index - 1].endMs)
    ).toBe(true);
  });

  it('retains distributed token times instead of collapsing words at a segment end', () => {
    const words = parseWhisperFullJson(
      JSON.stringify({
        transcription: [
          {
            tokens: [
              { text: ' One', offsets: { from: 0, to: 300 }, p: 0.9 },
              { text: ' two', offsets: { from: 300, to: 600 }, p: 0.9 },
              { text: ' three', offsets: { from: 600, to: 900 }, p: 0.9 }
            ]
          }
        ]
      }),
      5_000
    );
    expect(words.map(word => word.startMs)).toEqual([5_000, 5_300, 5_600]);
    expect(new Set(words.map(word => word.startMs)).size).toBe(words.length);
  });
});

describe('buildSegmentsFromWords', () => {
  it('splits on sentence end and long gaps, anchoring char offsets to sourceText', () => {
    const segments = buildSegmentsFromWords('j', [
      w('Hello', 0, 500, false),
      w('world.', 500, 1100),
      w('Again', 1300, 1700),
      w('stuff', 1750, 2000),
      w('end', 5000, 5300)
    ]);
    expect(segments.map(s => s.sourceText)).toEqual(['Hello world.', 'Again stuff', 'end']);
    expect(segments[0]).toMatchObject({ id: 'j-s0', startMs: 0, endMs: 1100 });
    expect(segments[0].words[1]).toMatchObject({
      text: 'world.',
      sourceStart: 6,
      sourceEnd: 12
    });
    expect(segments[1]).toMatchObject({ startMs: 1300, endMs: 2000 });
  });

  it('concatenates scripts without spaces (CJK) using whisper leadingSpace', () => {
    const segments = buildSegmentsFromWords('j', [
      w('这是', 0, 500, false),
      w('测试', 500, 1000, false)
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].sourceText).toBe('这是测试');
    expect(segments[0].words[1]).toMatchObject({ sourceStart: 2, sourceEnd: 4 });
  });
});
