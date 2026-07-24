import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translationCacheKey, type TranscriptionJob } from '@video-compressor/shared';
import { mediaMimeType, resolveByteRange } from '../apps/agent/src/transcription/media.js';
import { browserCompatible } from '../apps/agent/src/transcription/media-preview.js';
import {
  buildTextTranscriptionDocument,
  segmentsFromText,
  sourceContentHash,
  TranscriptionDocumentStore
} from '../apps/agent/src/transcription/document-store.js';
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
