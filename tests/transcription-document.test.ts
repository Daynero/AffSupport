import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translationCacheKey, type TranscriptionJob } from '@video-compressor/shared';
import { mediaMimeType, resolveByteRange } from '../apps/agent/src/transcription/media.js';
import { browserCompatible } from '../apps/agent/src/transcription/media-preview.js';
import {
  buildTranscriptionDocument,
  buildTextTranscriptionDocument,
  segmentsFromText,
  segmentsFromTextWithWords,
  sourceContentHash,
  TranscriptionDocumentStore
} from '../apps/agent/src/transcription/document-store.js';
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
  it('splits a merged transcript into one segment per non-empty line', () => {
    const segments = segmentsFromText('job1', 'First sentence.\n\n  Second sentence.  \n');
    expect(segments).toEqual([
      { id: 'job1-s0', startMs: 0, endMs: 0, sourceText: 'First sentence.', words: [] },
      { id: 'job1-s1', startMs: 0, endMs: 0, sourceText: 'Second sentence.', words: [] }
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
