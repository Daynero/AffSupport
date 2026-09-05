import { describe, expect, it } from 'vitest';
import type { TranscriptSegment, TranslationDocument } from '@video-compressor/shared';
import {
  baseFileName,
  buildTranscriptExport,
  formatTimestamp,
  hasTimings
} from '../apps/web/src/transcription/export.js';

function segment(id: string, text: string, startMs: number, endMs: number): TranscriptSegment {
  return { id, sourceText: text, startMs, endMs, words: [] };
}

const segments = [
  segment('s0', 'Hello there.', 20, 1500),
  segment('s1', 'Second line,', 1480, 3000),
  segment('s2', 'and a third.', 3000, 3000)
];

const translation: TranslationDocument = {
  targetLanguage: 'uk',
  modelVersion: 'test',
  status: 'completed',
  segments: [
    { sourceSegmentId: 's0', translatedText: 'Привіт.', alignments: [] },
    { sourceSegmentId: 's2', translatedText: 'і третій.', alignments: [] }
  ],
  error: null
};

describe('transcript export', () => {
  it('formats timestamps for SRT and WebVTT', () => {
    expect(formatTimestamp(0, ',')).toBe('00:00:00,000');
    expect(formatTimestamp(3_723_456, '.')).toBe('01:02:03.456');
    expect(formatTimestamp(-5, ',')).toBe('00:00:00,000');
  });

  it('names the file after the source and the content', () => {
    expect(baseFileName('ad creative.final.mp4')).toBe('ad creative.final');
    expect(baseFileName('.hidden')).toBe('.hidden');
    const file = buildTranscriptExport({
      fileName: 'clip.mov',
      segments,
      translation,
      content: 'translation',
      format: 'txt'
    });
    expect(file.name).toBe('clip.uk.txt');
    expect(file.text).toBe('Привіт.\nі третій.');
  });

  it('pairs both languages line by line in plain text', () => {
    const file = buildTranscriptExport({
      fileName: 'clip.mov',
      segments,
      translation,
      content: 'both',
      format: 'txt'
    });
    expect(file.name).toBe('clip.bilingual.txt');
    expect(file.text).toBe(
      'Hello there.\nПривіт.\n\nSecond line,\n\nand a third.\ni третій.'.replace('i ', 'і ')
    );
  });

  it('builds monotonic, gap-free SRT cues and skips empty ones', () => {
    const file = buildTranscriptExport({
      fileName: 'clip.mov',
      segments,
      translation,
      content: 'translation',
      format: 'srt'
    });
    // The second segment has no translation, so its cue is dropped and the numbering closes up.
    expect(file.text).toBe(
      [
        '1',
        '00:00:00,020 --> 00:00:01,500',
        'Привіт.',
        '',
        '2',
        // A segment that started before its predecessor ended, and one with no length, are
        // pushed forward so every cue starts after the last and lasts at least a moment.
        '00:00:03,000 --> 00:00:03,001',
        'і третій.'
      ].join('\n')
    );
  });

  it('writes a WEBVTT header and dotted timestamps', () => {
    const file = buildTranscriptExport({
      fileName: 'clip.mov',
      segments: segments.slice(0, 1),
      content: 'transcript',
      format: 'vtt'
    });
    expect(file.name).toBe('clip.vtt');
    expect(file.text).toBe('WEBVTT\n\n00:00:00.020 --> 00:00:01.500\nHello there.');
    expect(file.mimeType).toContain('text/vtt');
  });

  it('knows when a document carries no usable timings', () => {
    expect(hasTimings(segments)).toBe(true);
    expect(hasTimings([segment('a', 'x', 0, 0)])).toBe(false);
  });

  it('pairs both languages inside one subtitle cue', () => {
    const file = buildTranscriptExport({
      fileName: 'clip.mov',
      segments: segments.slice(0, 1),
      translation,
      content: 'both',
      format: 'vtt'
    });
    expect(file.name).toBe('clip.bilingual.vtt');
    expect(file.text).toBe('WEBVTT\n\n00:00:00.020 --> 00:00:01.500\nHello there.\nПривіт.');
  });
});
