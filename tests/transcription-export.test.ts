import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@video-compressor/shared';
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
      content: 'transcript',
      format: 'txt'
    });
    expect(file.name).toBe('clip.txt');
    expect(file.text).toBe('Hello there.\nSecond line,\nand a third.');
  });

  it('builds monotonic, gap-free SRT cues and skips empty ones', () => {
    const file = buildTranscriptExport({
      fileName: 'clip.mov',
      segments,
      content: 'transcript',
      format: 'srt'
    });
    // The second segment has no translation, so its cue is dropped and the numbering closes up.
    expect(file.text).toBe(
      [
        '1',
        '00:00:00,020 --> 00:00:01,500',
        'Hello there.',
        '',
        '2',
        // A segment that started before its predecessor ended, and one with no length, are
        // pushed forward so every cue starts after the last and lasts at least a moment.
        '00:00:01,500 --> 00:00:03,000',
        'Second line,',
        '',
        '3',
        '00:00:03,000 --> 00:00:03,001',
        'and a third.'
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
    const approximate = { ...segment('a', 'x', 1000, 8000), timingSource: 'window' as const };
    expect(hasTimings([approximate])).toBe(false);
    expect(() =>
      buildTranscriptExport({
        fileName: 'a.mp4',
        segments: [approximate],
        content: 'transcript',
        format: 'srt'
      })
    ).toThrow('TIMINGS_REQUIRED');
  });
});
