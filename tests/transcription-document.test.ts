import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translationCacheKey, type TranscriptionJob } from '@video-compressor/shared';
import { mediaMimeType, resolveByteRange } from '../apps/agent/src/transcription/media.js';
import { browserCompatible } from '../apps/agent/src/transcription/media-preview.js';
import {
  buildTranslationSourceSegments,
  buildTranscriptionDocument,
  buildTextTranscriptionDocument,
  segmentsFromText,
  segmentsFromTextWithWords,
  sourceContentHash,
  TranscriptionDocumentStore
} from '../apps/agent/src/transcription/document-store.js';
import {
  MAX_TRANSLATION_SEGMENT_UNITS,
  splitTextForTranslation
} from '../apps/agent/src/translation/segmentation.js';
import type { WhisperWord } from '../apps/agent/src/whisper/words.js';
import { isValidTargetLanguage } from '../apps/agent/src/queue/transcription-queue.js';

describe('media range + mime helpers', () => {
  it('treats a missing or multi-range header as a full response', () => {
    expect(resolveByteRange(undefined, 1000)).toEqual({ kind: 'full' });
    expect(resolveByteRange('bytes=0-99,200-299', 1000)).toEqual({ kind: 'full' });
    expect(resolveByteRange('bytes=-', 1000)).toEqual({ kind: 'full' });
  });

  it('resolves explicit, open-ended, and suffix ranges', () => {
    expect(resolveByteRange('bytes=0-99', 1000)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 99 }
    });
    expect(resolveByteRange('bytes=500-', 1000)).toEqual({
      kind: 'partial',
      range: { start: 500, end: 999 }
    });
    expect(resolveByteRange('bytes=-200', 1000)).toEqual({
      kind: 'partial',
      range: { start: 800, end: 999 }
    });
  });

  it('clamps an end past EOF and rejects an out-of-bounds or inverted range', () => {
    expect(resolveByteRange('bytes=900-100000', 1000)).toEqual({
      kind: 'partial',
      range: { start: 900, end: 999 }
    });
    expect(resolveByteRange('bytes=1000-1100', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveByteRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveByteRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('maps known containers to a content type and falls back for unknowns', () => {
    expect(mediaMimeType('clip.mp4')).toBe('video/mp4');
    expect(mediaMimeType('SONG.MP3')).toBe('audio/mpeg');
    expect(mediaMimeType('voice.opus')).toBe('audio/ogg');
    expect(mediaMimeType('mystery.xyz')).toBe('application/octet-stream');
  });

  it('streams browser-safe codecs and requires a proxy for unsupported media', () => {
    expect(browserCompatible('clip.mp4', true, 'h264', 'aac', true)).toBe(true);
    expect(browserCompatible('clip.webm', true, 'vp9', 'opus', true)).toBe(true);
    expect(browserCompatible('clip.mkv', true, 'h264', 'aac', true)).toBe(false);
    expect(browserCompatible('clip.mp4', true, 'hevc', 'aac', true)).toBe(false);
    expect(browserCompatible('voice.mp3', false, null, 'mp3', true)).toBe(true);
    expect(browserCompatible('voice.wma', false, null, 'wmav2', true)).toBe(false);
  });
});

describe('structured document building', () => {
  it('keeps ordinary transcript lines as individual segments', () => {
    const segments = segmentsFromText('job1', 'First sentence.\n\n  Second sentence.  \n');
    expect(segments).toEqual([
      { id: 'job1-s0', startMs: 0, endMs: 0, sourceText: 'First sentence.', words: [] },
      { id: 'job1-s1', startMs: 0, endMs: 0, sourceText: 'Second sentence.', words: [] }
    ]);
  });

  it('bounds a punctuation-poor line before it reaches the translator', () => {
    const text = Array.from({ length: 85 }, (_, index) => `शब्द${index}`).join(' ');
    const segments = segmentsFromText('long', text);

    expect(segments.length).toBeGreaterThan(1);
    expect(
      segments.every(
        segment =>
          (segment.sourceText.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length <=
          MAX_TRANSLATION_SEGMENT_UNITS
      )
    ).toBe(true);
    expect(segments.map(segment => segment.sourceText).join(' ')).toBe(text);
  });

  it('bounds scripts without spaces by visible units', () => {
    const text = '這是一段沒有空格而且非常長的逐字稿內容'.repeat(4);
    const parts = splitTextForTranslation(text, { maxUnits: 12 });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    expect(parts.every(part => Array.from(part).length <= 12)).toBe(true);
  });

  it('maps a speech-derived English pivot onto every visible source segment', () => {
    const source = segmentsFromText('pivot', 'один два\nтри чотири');
    const mapped = buildTranslationSourceSegments(
      source,
      'One two three four. Five six seven eight.'
    );

    expect(mapped).toEqual([
      { sourceSegmentId: 'pivot-s0', text: 'One two three four.' },
      { sourceSegmentId: 'pivot-s1', text: 'Five six seven eight.' }
    ]);
    expect(mapped?.map(segment => segment.text).join(' ')).toBe(
      'One two three four. Five six seven eight.'
    );
  });

  it('uses word timing to preserve adjacent short source sentences in the pivot', () => {
    const source = segmentsFromText(
      'timed-pivot',
      'Перше речення.\nКороткий слоган.\nДругий слоган.\nЗавершення.'
    );
    source.forEach((segment, index) => {
      segment.startMs = index * 1_000 + (index ? 100 : 0);
      segment.endMs = (index + 1) * 1_000;
    });
    const english = 'First sentence. Tiny slogan one Tiny slogan two Next sentence.';
    const pivotWords = [
      ['First', 100, 400],
      ['sentence.', 500, 900],
      ['Tiny', 1_100, 1_300],
      ['slogan', 1_350, 1_550],
      ['one', 1_600, 1_900],
      ['Tiny', 2_100, 2_300],
      ['slogan', 2_350, 2_550],
      ['two', 2_600, 2_900],
      ['Next', 3_100, 3_400],
      ['sentence.', 3_500, 3_900]
    ].map(([text, startMs, endMs], index): WhisperWord => ({
      text: String(text),
      leadingSpace: index > 0,
      startMs: Number(startMs),
      endMs: Number(endMs),
      confidence: 0.9
    }));

    expect(buildTranslationSourceSegments(source, english, pivotWords)).toEqual([
      { sourceSegmentId: 'timed-pivot-s0', text: 'First sentence.' },
      { sourceSegmentId: 'timed-pivot-s1', text: 'Tiny slogan one' },
      { sourceSegmentId: 'timed-pivot-s2', text: 'Tiny slogan two' },
      { sourceSegmentId: 'timed-pivot-s3', text: 'Next sentence.' }
    ]);
  });

  it('hashes source content stably and changes when the text changes', () => {
    const a = sourceContentHash(segmentsFromText('j', 'one\ntwo'));
    const b = sourceContentHash(segmentsFromText('other-id', 'one\ntwo'));
    const c = sourceContentHash(segmentsFromText('j', 'one\nthree'));
    expect(a).toBe(b); // id is not part of the content hash
    expect(a).not.toBe(c);
  });

  it('prefers the detected language and starts with no translations', () => {
    const job = {
      id: 'j2',
      detectedLanguage: 'uk',
      requestedLanguage: 'auto',
      text: 'Привіт світ.'
    } as TranscriptionJob;
    const document = buildTextTranscriptionDocument(job, 'large-v3');
    expect(document.sourceLanguage).toBe('uk');
    expect(document.modelVersion).toBe('large-v3');
    expect(document.translations).toEqual({});
    expect(document.segments).toHaveLength(1);
  });

  it('keeps canonical text while filtering interleaved overlap candidates', () => {
    const text =
      'Maaaring hindi mo alam na ang produkto ay maaaring lumaki.\n' +
      'Hindi ito nakadepende sa lahi, taas at sukat.';
    const candidateText = [
      'Maaaring',
      'hindi',
      'mo',
      'alam',
      'na',
      'ang',
      'produkto',
      'ay',
      'maaaring',
      'lumaki.',
      // Two overlapping decodings of the second sentence, interleaved by
      // timestamp just like the reported Tagalog regression.
      'Hindi',
      'ito',
      'Hindi',
      'nakadepende',
      'ito',
      'sa',
      'sa',
      'lahi',
      'sa',
      'lahi,',
      'taas',
      'at',
      'sukat.'
    ];
    const candidates: WhisperWord[] = candidateText.map((word, index) => ({
      text: word,
      leadingSpace: index > 0,
      startMs: index * 200,
      endMs: index * 200 + 180,
      confidence: 0.9
    }));
    const job = {
      id: 'overlap',
      detectedLanguage: 'tl',
      requestedLanguage: 'auto',
      text
    } as TranscriptionJob;

    const document = buildTranscriptionDocument(job, 'large-v3', candidates);

    expect(document.segments.map(segment => segment.sourceText).join('\n')).toBe(text);
    expect(document.segments[1].sourceText).toBe('Hindi ito nakadepende sa lahi, taas at sukat.');
    expect(document.segments[1].words.map(word => word.text)).toEqual([
      'Hindi',
      'ito',
      'nakadepende',
      'sa',
      'lahi,',
      'taas',
      'at',
      'sukat.'
    ]);
    expect(document.segments.flatMap(segment => segment.words)).toHaveLength(18);
  });

  it('stores a complete speech-derived translation source when supplied', () => {
    const job = {
      id: 'speech-pivot',
      detectedLanguage: 'hi',
      requestedLanguage: 'auto',
      text: 'पहला भाग\nदूसरा भाग'
    } as TranscriptionJob;
    const document = buildTranscriptionDocument(
      job,
      'large-v3',
      [],
      'The first part. The second part.'
    );

    expect(document.translationSource).toMatchObject({
      language: 'en',
      modelVersion: 'large-v3:speech-to-en'
    });
    expect(document.translationSource?.segments).toHaveLength(2);
    expect(document.translationSource?.segments.map(segment => segment.text).join(' ')).toBe(
      'The first part. The second part.'
    );
  });

  it('splits punctuation compounds into monotonic timing units', () => {
    const candidates: WhisperWord[] = [
      {
        text: ' 50,000',
        leadingSpace: true,
        startMs: 1_000,
        endMs: 1_400,
        confidence: 0.8
      },
      {
        text: ' araw-araw.',
        leadingSpace: true,
        startMs: 1_400,
        endMs: 2_000,
        confidence: 0.9
      }
    ];

    const [segment] = segmentsFromTextWithWords('compound', '50,000 araw-araw.', candidates);

    expect(segment.sourceText).toBe('50,000 araw-araw.');
    expect(segment.words.map(word => word.text)).toEqual(['50,', '000', 'araw-', 'araw.']);
    expect(segment.words.map(word => [word.startMs, word.endMs])).toEqual([
      [1_000, 1_200],
      [1_200, 1_400],
      [1_400, 1_700],
      [1_700, 2_000]
    ]);
  });
});

describe('translation cache key + language validation', () => {
  it('is stable and varies with every component', () => {
    const base = {
      sourceContentHash: 'abc',
      sourceLanguage: 'en',
      targetLanguage: 'uk',
      translatorModelVersion: 'tg-4b-q4'
    };
    expect(translationCacheKey(base)).toBe(translationCacheKey({ ...base }));
    expect(translationCacheKey(base)).not.toBe(
      translationCacheKey({ ...base, targetLanguage: 'de' })
    );
    expect(translationCacheKey(base)).not.toBe(
      translationCacheKey({ ...base, translatorModelVersion: 'tg-12b-q4' })
    );
  });

  it('accepts ISO / BCP-47 codes and rejects junk', () => {
    expect(isValidTargetLanguage('uk')).toBe(true);
    expect(isValidTargetLanguage('en')).toBe(true);
    expect(isValidTargetLanguage('zh-Hant')).toBe(true);
    expect(isValidTargetLanguage('pt-BR')).toBe(true);
    expect(isValidTargetLanguage('')).toBe(false);
    expect(isValidTargetLanguage('../etc/passwd')).toBe(false);
    expect(isValidTargetLanguage(42)).toBe(false);
  });
});

describe('document store round-trip', () => {
  let dir: string;
  let store: TranscriptionDocumentStore;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-docs-'));
    store = new TranscriptionDocumentStore(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves, loads, and removes a document without leaking the id into a path', async () => {
    const job = {
      id: 'round-trip',
      detectedLanguage: 'en',
      requestedLanguage: 'auto',
      text: 'Hello there.\nGeneral Kenobi.'
    } as TranscriptionJob;
    const document = buildTextTranscriptionDocument(job, 'large-v3');

    expect(await store.load('round-trip')).toBeNull();
    await store.save(document);
    const loaded = await store.load('round-trip');
    expect(loaded).toEqual(document);

    await store.remove('round-trip');
    expect(await store.load('round-trip')).toBeNull();
  });
});
