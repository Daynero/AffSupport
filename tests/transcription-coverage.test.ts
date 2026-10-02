import { describe, expect, it } from 'vitest';
import {
  hasDecodeLoop,
  missingSpeechMs,
  speechIntervalFromLog,
  transcriptIntervals
} from '../apps/agent/src/whisper/coverage.js';

describe('independent speech coverage evidence', () => {
  it('requests recovery for decoder loops, but not ordinary repeated words', () => {
    expect(hasDecodeLoop('No. No. No. No. No. No. No. No.', '')).toBe(true);
    expect(hasDecodeLoop('la página de la página de la página de', '')).toBe(true);
    expect(hasDecodeLoop('no no, gracias gracias', '')).toBe(false);
    expect(hasDecodeLoop('A repeated sentence. A repeated sentence.', '')).toBe(false);
    expect(
      hasDecodeLoop(
        'Gracias. Gracias.',
        JSON.stringify({
          transcription: [
            { text: 'Gracias', offsets: { from: 100, to: 200 } },
            { text: 'Gracias', offsets: { from: 100, to: 200 } }
          ]
        })
      )
    ).toBe(true);
    expect(
      hasDecodeLoop(
        'Gracias. Gracias.',
        JSON.stringify({
          transcription: [
            { text: 'Gracias', offsets: { from: 100, to: 200 } },
            { text: 'Gracias', offsets: { from: 1000, to: 1200 } }
          ]
        })
      )
    ).toBe(false);
  });
  it('reads VAD ranges, rejecting malformed and reversed intervals', () => {
    expect(
      speechIntervalFromLog('whisper_vad: Including segment 2: 1.25 - 4.50 (duration: 3.25)')
    ).toEqual({ startMs: 1250, endMs: 4500 });
    expect(speechIntervalFromLog('Including segment 0: 4.0 - 1.0')).toBeNull();
    expect(speechIntervalFromLog('audio is loud')).toBeNull();
  });

  it('finds missing beginning, middle and ending, but ignores actual silence gaps', () => {
    const speech = [
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 8000 }
    ];
    expect(
      missingSpeechMs(speech, [
        { startMs: 0, endMs: 2000 },
        { startMs: 4000, endMs: 8000 }
      ])
    ).toBe(0);
    expect(
      missingSpeechMs(speech, [
        { startMs: 0, endMs: 2000 },
        { startMs: 6000, endMs: 8000 }
      ])
    ).toBe(2000);
    expect(
      missingSpeechMs(speech, [
        { startMs: 1000, endMs: 2000 },
        { startMs: 4000, endMs: 5000 },
        { startMs: 7000, endMs: 7500 }
      ])
    ).toBe(2000);
    expect(missingSpeechMs([], [])).toBe(0);
  });

  it('uses text-bearing segments, not broken or absent token timestamps, for coverage', () => {
    const json = JSON.stringify({
      transcription: [
        { text: 'Spoken words.', offsets: { from: 0, to: 8000 }, tokens: [] },
        { text: '', offsets: { from: 0, to: 8000 } },
        null,
        { text: 'bad', offsets: { from: -5, to: 200 } }
      ]
    });
    expect(transcriptIntervals(json, 8000)).toEqual([{ startMs: 0, endMs: 8000 }]);
    expect(transcriptIntervals('null', 8000)).toEqual([]);
    expect(transcriptIntervals('bad JSON', 8000)).toEqual([]);
  });
});
