import { describe, expect, it } from 'vitest';
import {
  recoveryContextSeconds,
  stitchChunkResult,
  stitchChunkText,
  transcriptionChunks
} from '../apps/agent/src/whisper/chunks.js';
import { lexicalUnitSpans } from '../apps/agent/src/translation/segmentation.js';

describe('bounded speech decoding', () => {
  it('does not reintroduce Indic token exhaustion through wide recovery context', () => {
    expect(recoveryContextSeconds('es')).toBe(6);
    expect(recoveryContextSeconds('en')).toBe(6);
    for (const language of [
      'hi',
      'ur',
      'bn',
      'ta',
      'te',
      'ml',
      'kn',
      'mr',
      'gu',
      'pa',
      'ne',
      'si',
      'auto',
      null
    ])
      expect(recoveryContextSeconds(language)).toBe(1);
  });
  it('covers the entire reported Hindi sample, including the final eight seconds', () => {
    const chunks = transcriptionChunks(68.107);
    expect(chunks.map(chunk => chunk.startSeconds)).toEqual([
      0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66
    ]);
    expect(chunks.every(chunk => chunk.durationSeconds <= 8)).toBe(true);
    expect(chunks.at(-1)!.startSeconds + chunks.at(-1)!.durationSeconds).toBe(68.107);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index - 1].startSeconds + chunks[index - 1].durationSeconds).toBeGreaterThan(
        chunks[index].startSeconds
      );
    }
  });

  it('does not create redundant final windows or discard short sources', () => {
    expect(transcriptionChunks(8)).toEqual([{ startSeconds: 0, durationSeconds: 8 }]);
    expect(transcriptionChunks(14)).toHaveLength(2);
    expect(transcriptionChunks(0.5)).toEqual([{ startSeconds: 0, durationSeconds: 0.5 }]);
    expect(transcriptionChunks(0)).toEqual([]);
  });
  it('bounds malformed metadata and covers a full hour without gaps', () => {
    expect(() => transcriptionChunks(1e300)).toThrow(RangeError);
    const chunks = transcriptionChunks(3600);
    expect(chunks).toHaveLength(600);
    expect(chunks.at(-1)).toEqual({ startSeconds: 3594, durationSeconds: 6 });
  });
});

describe('overlapping transcript text', () => {
  const words = (text: string, base: number) =>
    lexicalUnitSpans(text).map((span, index) => ({
      text: text.slice(span.start, span.end),
      startMs: base + index * 100,
      endMs: base + index * 100 + 100,
      confidence: null,
      leadingSpace: span.start > 0,
      canonicalStart: span.start,
      canonicalEnd: span.end
    }));
  it('uses audio evidence to replace an interior continuation but not a later repeated phrase', () => {
    const left = 'Start we can do this badly';
    const right = 'we can do this correctly and continue';
    const timing = {
      left: words(left, 5900),
      right: words(right, 6000),
      overlapStartMs: 6000,
      overlapEndMs: 8000
    };
    expect(stitchChunkResult(left, right, timing).text).toBe(
      'Start we can do this correctly and continue'
    );
    expect(
      stitchChunkResult(left, right, { ...timing, right: words(right, 10_000) }).ambiguous
    ).toBe(true);
    expect(stitchChunkText(left, right)).toBe(`${left}\n${right}`);
  });
  it('repairs conflicting Spanish inflections only at the same timed occurrence', () => {
    const left = 'resultado tu próstata volverá a';
    const right = 'tu próstata volverás a estar como antes';
    const timing = {
      left: words(left, 5900),
      right: words(right, 6000),
      overlapStartMs: 6000,
      overlapEndMs: 8000
    };
    expect(stitchChunkResult(left, right, timing).text).toBe(
      'resultado tu próstata volverás a estar como antes'
    );
    expect(
      stitchChunkResult(left, right, { ...timing, right: words(right, 10000) }).ambiguous
    ).toBe(true);
    expect(stitchChunkText(left, right)).toBe(`${left}\n${right}`);
  });
  it('repairs a bounded untimed final word after four synchronized anchor words', () => {
    const left = 'Start y recupera el control de tu víctima';
    const right = 'y recupera el control de tu vida con este remedio';
    const timing = {
      left: words(left, 5900).slice(0, -1),
      right: words(right, 6000),
      overlapStartMs: 6000,
      overlapEndMs: 8000
    };
    expect(stitchChunkResult(left, right, timing).text).toBe(
      'Start y recupera el control de tu vida con este remedio'
    );
    expect(
      stitchChunkResult(left, right, { ...timing, right: words(right, 10000) }).ambiguous
    ).toBe(true);
  });
  it("repairs the sample's split proper name and clipped final word", () => {
    expect(
      stitchChunkText(
        'नज़दीकी से बचने लगना प्रो मैन का फॉर्म',
        'प्रोमैन का फॉर्मुला प्रजनन वाले ताकतवर सांडों की प्राकृतिक शक्ति'
      )
    ).toBe('नज़दीकी से बचने लगना प्रोमैन का फॉर्मुला प्रजनन वाले ताकतवर सांडों की प्राकृतिक शक्ति');
    expect(
      stitchChunkText('The problem disappears. If not..', 'If not, then God will punish me.')
    ).toBe('The problem disappears. If not, then God will punish me.');
  });
  it('recovers clipped Hindi words without depending on token timestamps', () => {
    expect(
      stitchChunkText(
        'मैं भगवान की कसम खाता हूँ तुम छोटे लिं',
        'कसम खाता हूँ तुम छोटे लिंग और कमजोर यौन शक्ति की समस्या भूल जाओगे।'
      )
    ).toBe('मैं भगवान की कसम खाता हूँ तुम छोटे लिंग और कमजोर यौन शक्ति की समस्या भूल जाओगे।');
  });

  it('keeps punctuation and new speech after the overlap', () => {
    expect(
      stitchChunkText('Start. We can do this now.', 'we can do this now! Then continue.')
    ).toBe('Start. we can do this now! Then continue.');
  });

  it('retains both decodes when an overlap cannot be established', () => {
    expect(stitchChunkText('one unusual reading', 'a different reading here')).toBe(
      'one unusual reading\na different reading here'
    );
  });

  it('keeps a genuinely repeated phrase beyond the overlap', () => {
    expect(stitchChunkText('We can do this now.', 'We can do this now. We can do this now.')).toBe(
      'We can do this now. We can do this now.'
    );
    expect(stitchChunkText('Go now', 'now go')).toBe('Go now\nnow go');
  });

  it('joins no-space scripts without adding spaces and preserves combining marks', () => {
    expect(stitchChunkText('今日は晴れです', '晴れです。明日は雨です。')).toBe(
      '今日は晴れです。明日は雨です。'
    );
    expect(stitchChunkText('Één twee drie vier', 'één twee drie vier vijf')).toBe(
      'één twee drie vier vijf'
    );
  });
});
