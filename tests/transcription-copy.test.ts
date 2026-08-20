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
    transcript: '  Перший текст.  ',
    translation: { languageName: 'English', text: 'First text.' }
  },
  {
    fileName: 'raw.mov',
    transcript: 'Другий текст.\nНаступний рядок.',
    translation: null
  }
];

function formatted(language: Language, content: TranscriptionCopyContent) {
  return formatTranscriptionBatch(entries, content, {
    heading: number => translate(language, 'transcriptionBatchHeading', { number }),
    transcript: translate(language, 'transcriptionCopyTranscriptLabel'),
    translation: translate(language, 'transcriptionCopyTranslationLabel')
  });
}

describe('copying a batch of transcripts', () => {
  it('names the file and labels both halves when translations are included', () => {
    expect(formatted('uk', 'both')).toBe(
      'Транскрибування 1: promo.mp4\n' +
        'Транскрипція:\nПерший текст.\n\n' +
        'Переклад (English):\nFirst text.\n\n' +
        'Транскрибування 2: raw.mov\n' +
        'Транскрипція:\nДругий текст.\nНаступний рядок.'
    );
  });

  it('copies bare transcripts without labels when only the transcript is wanted', () => {
    expect(formatted('en', 'transcript')).toBe(
      'Transcription 1: promo.mp4\nПерший текст.\n\n' +
        'Transcription 2: raw.mov\nДругий текст.\nНаступний рядок.'
    );
  });

  it('skips untranslated files and renumbers the rest without gaps', () => {
    expect(formatted('en', 'translation')).toBe(
      'Transcription 1: promo.mp4 · Translation (English)\nFirst text.'
    );
  });

  it('reports which files contribute to the chosen mode', () => {
    expect(entries.map(entry => hasCopyContent(entry, 'both'))).toEqual([true, true]);
    expect(entries.map(entry => hasCopyContent(entry, 'translation'))).toEqual([true, false]);
    expect(
      hasCopyContent({ fileName: 'x', transcript: '   ', translation: null }, 'transcript')
    ).toBe(false);
  });
});
