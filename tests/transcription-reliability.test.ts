import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as replacement from '../apps/agent/src/files/replace-file.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { stitchChunkText, transcriptionChunks } from '../apps/agent/src/whisper/chunks.js';
import {
  collapseTranscriptArtifacts,
  dropTrailingCredits,
  stripCreditSuffix
} from '../apps/agent/src/whisper/transcriber.js';
import {
  segmentsFromTextWithWords,
  TranscriptionDocumentStore,
  validDocument
} from '../apps/agent/src/transcription/document-store.js';
import { canonicalChunkWords, parseWhisperFullJson } from '../apps/agent/src/whisper/words.js';

describe('transcription must not silently discard speech', () => {
  it('keeps the prior sidecar and removes partial output when an atomic save fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-document-failure-'));
    const store = new TranscriptionDocumentStore(dir);
    const original = {
      jobId: 'prior',
      sourceLanguage: 'en',
      modelVersion: 'test',
      segments: [],
      translations: {}
    };
    try {
      await store.save(original);
      const replace = vi
        .spyOn(replacement, 'replaceFile')
        .mockRejectedValue(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
      try {
        await expect(store.save({ ...original, modelVersion: 'new' })).rejects.toMatchObject({
          code: 'ENOSPC'
        });
      } finally {
        replace.mockRestore();
      }
      expect(await store.load('prior')).toEqual(original);
      expect(await readdir(dir)).toEqual(['prior.json']);
      await store.save({ ...original, modelVersion: 'cancelled' }, () => false);
      expect(await store.load('prior')).toEqual(original);
      expect(await readdir(dir)).toEqual(['prior.json']);
    } finally {
      await removeTemporaryDirectory(dir);
    }
  });
  it('preserves different continuations after a shared phrase', () => {
    const result = stitchChunkText(
      'Intro we can do this keep the receipt',
      'we can do this tomorrow'
    );
    expect(result).toContain('keep the receipt');
    expect(result).toContain('tomorrow');
  });

  it('retains reordered sentences and actual repeated sentences', () => {
    const lines = ['Dog bites man.', 'Man bites dog.', 'Man bites dog.'];
    expect(collapseTranscriptArtifacts(lines)).toEqual(lines);
  });

  it('retains a spoken outro without audio evidence of a hallucination', () => {
    const lines = ['The tutorial ends here.', 'Thanks for watching.', 'Please subscribe.'];
    expect(dropTrailingCredits(lines)).toEqual(lines);
    expect(stripCreditSuffix('Order now. Thanks for watching')).toBe(
      'Order now. Thanks for watching'
    );
  });

  it('rejects unbounded and negative audio durations', () => {
    expect(() => transcriptionChunks(Infinity)).toThrow();
    expect(() => transcriptionChunks(NaN)).toThrow();
    expect(() => transcriptionChunks(-1)).toThrow();
  });

  it('recovers word alignment after a long run of extra tokens', () => {
    const source = Array.from({ length: 50 }, (_, index) => `word${index}`);
    const candidates = [...Array.from({ length: 80 }, (_, index) => `noise${index}`), ...source];
    const words = candidates.map((text, index) => ({
      text,
      startMs: index * 100,
      endMs: index * 100 + 80,
      confidence: null,
      leadingSpace: true
    }));
    const aligned = segmentsFromTextWithWords('resync', source.join(' '), words).flatMap(
      segment => segment.words
    );
    expect(aligned.map(word => word.text)).toEqual(source);
    expect(aligned[0].startMs).toBe(8000);
  });

  it('rejects malformed token ranges and null full JSON', () => {
    expect(parseWhisperFullJson('null', 0)).toEqual([]);
    const tokens = [
      { text: ' bad', offsets: { from: -20, to: 100 } },
      { text: ' reversed', offsets: { from: 300, to: 100 } },
      { text: ' good', offsets: { from: 300, to: 500 } }
    ];
    expect(
      parseWhisperFullJson(JSON.stringify({ transcription: [{ tokens }] }), 0).map(
        word => word.text
      )
    ).toEqual(['good']);
  });
  it('does not report a zero-duration decoder pile-up as reliable word timing', () => {
    const text = 'Keep all words';
    const timings = ['Keep', 'all', 'words'].map((word, index) => ({
      text: word,
      leadingSpace: true,
      startMs: index ? 500 : 0,
      endMs: 500,
      confidence: null
    }));
    expect(canonicalChunkWords(text, timings).map(word => word.text)).toEqual(['Keep']);
    expect(
      segmentsFromTextWithWords('partial', text, canonicalChunkWords(text, timings))
        .map(segment => segment.sourceText)
        .join(' ')
    ).toBe(text);
  });
  it('rejects malformed translation metadata rather than silently discarding it', () => {
    expect(
      validDocument({ jobId: 'a', sourceLanguage: 'en', segments: [], translations: 'corrupt' })
    ).toBeNull();
  });

  it('rejects corrupted words in a persisted document', () => {
    expect(
      validDocument({
        jobId: 'a',
        sourceLanguage: 'en',
        segments: [{ id: 's', sourceText: 'Hello', startMs: 0, endMs: 100, words: [null] }],
        translations: {}
      })
    ).toBeNull();
  });
});
