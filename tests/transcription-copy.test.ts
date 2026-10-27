import { describe, expect, it } from 'vitest';
import { translate, type Language } from '../apps/web/src/i18n.js';
import {
  formatTranscriptionBatch,
  hasCopyContent,
  type TranscriptionCopyContent,
  type TranscriptionCopyEntry
} from '../apps/web/src/transcription/copy.js';

const entries: TranscriptionCopyEntry[] = [
  {
    fileName: 'promo.mp4',
    transcript: '  Перший текст.  '
  },
  {
    fileName: 'raw.mov',
    transcript: 'Другий текст.\nНаступний рядок.'
  }
];

function formatted(language: Language, content: TranscriptionCopyContent) {
  return formatTranscriptionBatch(entries, content, {
    heading: number => translate(language, 'transcriptionBatchHeading', { number }),
    transcript: translate(language, 'transcriptionCopyTranscriptLabel')
  });
}

describe('copying a batch of transcripts', () => {
  it('copies bare transcripts without labels when only the transcript is wanted', () => {
    expect(formatted('en', 'transcript')).toBe(
      'Transcript 1: promo.mp4\nПерший текст.\n\n' +
        'Transcript 2: raw.mov\nДругий текст.\nНаступний рядок.'
    );
  });

  it('reports which files contribute to the chosen mode', () => {
    expect(entries.map(entry => hasCopyContent(entry, 'transcript'))).toEqual([true, true]);
    expect(hasCopyContent({ fileName: 'x', transcript: '   ' }, 'transcript')).toBe(false);
  });
});
