import { describe, expect, it } from 'vitest';
import { translate, type Language } from '../apps/web/src/i18n.js';
import { formatTranscriptionBatch } from '../apps/web/src/transcription/copy.js';

function formatted(language: Language) {
  return formatTranscriptionBatch(
    ['  Перший текст.  ', 'Другий текст.\nНаступний рядок.'],
    number => translate(language, 'transcriptionBatchHeading', { number })
  );
}

describe('copying every completed transcript', () => {
  it('uses Ukrainian headings when Ukrainian is selected on the site', () => {
    expect(formatted('uk')).toBe(
      'Транскрибування 1:\nПерший текст.\n\n' +
        'Транскрибування 2:\nДругий текст.\nНаступний рядок.'
    );
  });

  it('uses English headings when English is selected on the site', () => {
    expect(formatted('en')).toBe(
      'Transcription 1:\nПерший текст.\n\n' + 'Transcription 2:\nДругий текст.\nНаступний рядок.'
    );
  });
});
