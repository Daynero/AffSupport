import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TranscriptionJob } from '@video-compressor/shared';
import { mediaMimeType, resolveByteRange } from '../apps/agent/src/transcription/media.js';
import { browserCompatible } from '../apps/agent/src/transcription/media-preview.js';
import {
  buildTranscriptionDocument,
  buildTextTranscriptionDocument,
  segmentsFromText,
  segmentsFromTextWithWords,
  sourceContentHash,
  TranscriptionDocumentStore,
  validDocument
} from '../apps/agent/src/transcription/document-store.js';
import {
  MAX_TRANSCRIPT_SEGMENT_UNITS,
  splitTranscriptText
} from '../apps/agent/src/transcription/segmentation.js';
import type { WhisperWord } from '../apps/agent/src/whisper/words.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

it('round-trips decoder uncertainty without treating the saved transcript as corrupted', () => {
  const document = buildTextTranscriptionDocument(
    { id: 'decode-warning', detectedLanguage: 'es', text: 'Spoken text.' } as TranscriptionJob,
    'large-v3'
  );
  document.reliability = {
    windows: 1,
    retries: 2,
    recoveredWindows: 0,
    timedWords: 0,
    totalWords: 2,
    warnings: [{ code: 'DECODE_UNCERTAIN', startMs: 0, endMs: 8000 }]
  };
  expect(validDocument(document)?.reliability?.warnings[0].code).toBe('DECODE_UNCERTAIN');
});

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
  it('round-trips timing provenance, speech-derived translation and aligned translated words', () => {
    const document = {
      jobId: 'roundtrip',
      sourceLanguage: 'uk',
      modelVersion: 'large-v3',
      reliability: {
        windows: 1,
        retries: 0,
        recoveredWindows: 0,
        timedWords: 1,
        totalWords: 1,
        ranges: [{ canonicalStart: 0, canonicalEnd: 5, startMs: 100, endMs: 400 }],
        warnings: []
      },
      translationSource: {
        language: 'en',
        modelVersion: 'large-v3',
        segments: [{ sourceSegmentId: 's', text: 'Hello' }]
      },
      segments: [
        {
          id: 's',
          sourceText: 'Привіт',
          startMs: 100,
          endMs: 400,
          timingSource: 'words',
          words: [
            {
              id: 'w',
              text: 'Привіт',
              startMs: 100,
              endMs: 400,
              sourceStart: 0,
              sourceEnd: 6,
              confidence: 0.9
            }
          ]
        }
      ],
      translations: {
        en: {
          targetLanguage: 'en',
          modelVersion: 'translator',
          status: 'completed',
          segments: [
            {
              sourceSegmentId: 's',
              translatedText: 'Hello',
              alignments: [
                { sourceStart: 0, sourceEnd: 6, targetStart: 0, targetEnd: 5, confidence: 0.8 }
              ]
            }
          ]
        }
      }
    };
    const original = {
      jobId: document.jobId,
      sourceLanguage: document.sourceLanguage,
      modelVersion: document.modelVersion,
      segments: document.segments,
      reliability: document.reliability
    };
    expect(validDocument(JSON.parse(JSON.stringify(document)))).toEqual(original);
    const corrupt = structuredClone(document);
    corrupt.reliability.ranges[0].endMs = 50;
    expect(validDocument(corrupt)).toBeNull();
    const corruptTranslation = structuredClone(document);
    corruptTranslation.translations.en.segments[0].alignments[0].targetEnd = 99;
    expect(validDocument(corruptTranslation)?.segments).toEqual(document.segments);
  });
  it('uses a clearly approximate window interval for untimed speech navigation', () => {
    const document = buildTranscriptionDocument(
      {
        id: 'untimed',
        text: 'A phrase without word timestamps.',
        requestedLanguage: 'en'
      } as TranscriptionJob,
      'model',
      [],
      {
        windows: 1,
        retries: 0,
        recoveredWindows: 0,
        warnings: [],
        timedWords: 0,
        totalWords: 5,
        ranges: [{ canonicalStart: 0, canonicalEnd: 33, startMs: 6000, endMs: 14000 }]
      }
    );
    expect(document.segments[0]).toMatchObject({
      startMs: 6000,
      endMs: 14000,
      timingSource: 'window',
      words: []
    });
  });
  it('does not let a missing common word consume timings for later phrases', () => {
    const text =
      'देती हैं प्रजनन वाले सांडों को देखो प्रजनन के लिए केवल सबसे ताकतवर और स्वस्थ नर चुने जाते हैं कमजोर सांडों को पास तक नहीं आने दिया जाता';
    const tokens = text.split(' ').filter((_, index) => index !== 1);
    const words = tokens.map((token, index) => ({
      text: token,
      leadingSpace: true,
      startMs: index * 200,
      endMs: (index + 1) * 200,
      confidence: null
    }));
    const aligned = segmentsFromTextWithWords('missing-common-word', text, words).flatMap(
      segment => segment.words
    );
    expect(aligned.map(word => word.text)).toEqual(tokens);
    expect(aligned.at(-1)?.endMs).toBe(words.at(-1)?.endMs);
  });

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
          MAX_TRANSCRIPT_SEGMENT_UNITS
      )
    ).toBe(true);
    expect(segments.map(segment => segment.sourceText).join(' ')).toBe(text);
  });

  it('bounds scripts without spaces by visible units', () => {
    const text = '這是一段沒有空格而且非常長的逐字稿內容'.repeat(4);
    const parts = splitTranscriptText(text, { maxUnits: 12 });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    expect(parts.every(part => Array.from(part).length <= 12)).toBe(true);
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
    expect(document).not.toHaveProperty('translations');
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

  it('does not consume later sentences when a missing timing word recurs far in the future', () => {
    const candidates: WhisperWord[] = [
      'Start',
      'Then',
      'continue.',
      ...Array.from({ length: 60 }, (_, index) => `filler${index}`),
      'missing'
    ].map((text, index) => ({
      text,
      leadingSpace: true,
      startMs: index * 200,
      endMs: index * 200 + 180,
      confidence: 0.9
    }));
    const segments = segmentsFromTextWithWords('local', 'Start missing Then continue.', candidates);
    expect(segments[0].sourceText).toBe('Start missing Then continue.');
    expect(segments[0].words.map(word => word.text)).toEqual(['Start', 'Then', 'continue.']);
    expect(segments[0].endMs).toBe(580);
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

describe('document store round-trip', () => {
  let dir: string;
  let store: TranscriptionDocumentStore;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-docs-'));
    store = new TranscriptionDocumentStore(dir);
  });
  afterAll(async () => {
    await removeTemporaryDirectory(dir);
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
