import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AlignmentLink,
  TranscriptionDocument,
  TranscriptionJob
} from '@video-compressor/shared';
import { weightedDownloadProgress } from '../apps/agent/src/translation/download-progress.js';
import type {
  TranslateRequest,
  Translator,
  TranslationOutputSegment
} from '../apps/agent/src/translation/translator.js';
import { translationPrompt } from '../apps/agent/src/translation/translator.js';
import { TranscriptionDocumentStore } from '../apps/agent/src/transcription/document-store.js';
import {
  combinedModelStatus,
  TranscriptionQueue
} from '../apps/agent/src/queue/transcription-queue.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('weightedDownloadProgress', () => {
  it('reports 100% when nothing is missing', () => {
    expect(
      weightedDownloadProgress([{ label: 'a', present: true, sizeBytes: 100, downloadedBytes: 0 }])
    ).toEqual({ totalBytes: 0, downloadedBytes: 0, progress: 100, remaining: [] });
  });

  it('byte-weights across the missing models only', () => {
    const result = weightedDownloadProgress([
      { label: 'whisper', present: true, sizeBytes: 3_000_000_000, downloadedBytes: 0 },
      {
        label: 'translator',
        present: false,
        sizeBytes: 2_000_000_000,
        downloadedBytes: 500_000_000
      },
      { label: 'align', present: false, sizeBytes: 2_000_000_000, downloadedBytes: 0 }
    ]);
    expect(result.remaining).toEqual(['translator', 'align']);
    expect(result.totalBytes).toBe(4_000_000_000);
    expect(result.downloadedBytes).toBe(500_000_000);
    expect(result.progress).toBe(12); // floor(0.5e9 / 4e9 * 100)
  });

  it('is indeterminate when a missing model has an unknown size', () => {
    expect(
      weightedDownloadProgress([{ label: 'x', present: false, sizeBytes: 0, downloadedBytes: 0 }])
        .progress
    ).toBeNull();
  });

  it('combines runtime and weights using byte-weighted progress', () => {
    const status = combinedModelStatus('translator', [
      {
        present: false,
        downloading: true,
        progress: 50,
        sizeBytes: 100,
        downloadedBytes: 50,
        label: 'weights',
        error: null
      },
      {
        present: true,
        downloading: false,
        progress: 100,
        sizeBytes: 20,
        downloadedBytes: 0,
        label: 'runtime',
        error: null
      }
    ]);
    expect(status).toMatchObject({
      present: false,
      downloading: true,
      sizeBytes: 100,
      downloadedBytes: 50,
      progress: 50
    });
  });

  it('keeps completed bytes in the same composite download batch', () => {
    const status = combinedModelStatus(
      'local models',
      [
        {
          present: true,
          downloading: false,
          progress: 100,
          sizeBytes: 300,
          downloadedBytes: 300,
          downloadBatchId: 'install-1',
          label: 'whisper',
          error: null
        },
        {
          present: false,
          downloading: true,
          progress: 50,
          sizeBytes: 100,
          downloadedBytes: 50,
          downloadBatchId: 'install-1',
          label: 'translator',
          error: null
        },
        {
          present: true,
          downloading: false,
          progress: 100,
          sizeBytes: 900,
          downloadedBytes: 0,
          label: 'already installed',
          error: null
        }
      ],
      'install-1'
    );
    expect(status).toMatchObject({
      sizeBytes: 400,
      downloadedBytes: 350,
      progress: 87,
      downloadBatchId: 'install-1'
    });
  });
});

describe('TranslateGemma prompt rendering', () => {
  it('uses the model translation turn format without duplicating the BOS token', () => {
    const prompt = translationPrompt('en', 'uk', '  Hello world.  ');
    expect(prompt).toContain('You are a professional English (en) to Ukrainian (uk) translator.');
    expect(prompt).toContain(
      'Please translate the following English text into Ukrainian:\n\n\nHello world.'
    );
    expect(prompt).toMatch(/<end_of_turn>\n<start_of_turn>model\n$/u);
    expect(prompt).not.toContain('<bos>');
  });
});

/** A translator whose every call is a manually-resolved promise, for races. */
class GatedTranslator implements Translator {
  availableFlag = true;
  version = 'fake-1';
  calls: {
    request: TranslateRequest;
    signal: AbortSignal;
    resolve: (out: TranslationOutputSegment[]) => void;
    reject: (error: Error) => void;
  }[] = [];

  available(): boolean {
    return this.availableFlag;
  }
  modelVersion(): string {
    return this.version;
  }
  translate(request: TranslateRequest, signal: AbortSignal): Promise<TranslationOutputSegment[]> {
    return new Promise((resolve, reject) => {
      this.calls.push({ request, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  complete(index: number, translatedText: string, alignments: AlignmentLink[] = []) {
    const segment = { sourceSegmentId: 's0', translatedText, alignments };
    // Mirror the real translator: emit the segment through onSegment (drives
    // pipelined alignment + progress) and then resolve with the full output.
    this.calls[index].request.onSegment?.(segment, 0);
    this.calls[index].resolve([segment]);
  }
}

describe('translation coordination', () => {
  let dir: string;
  let queue: TranscriptionQueue;
  let jobId: string;
  let mediaPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-tr-'));
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(dir, 'docs');
    process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(dir, 'cache');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(dir, 'previews');
    mediaPath = path.join(dir, 'sample.mp3');
    await writeFile(mediaPath, 'x');
    queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, () => {});
    await queue.add([mediaPath]);
    jobId = queue.state().jobs[0].id;
    const document: TranscriptionDocument = {
      jobId,
      sourceLanguage: 'en',
      modelVersion: 'large-v3',
      segments: [
        { id: `${jobId}-s0`, startMs: 0, endMs: 0, sourceText: 'Hello world.', words: [] }
      ],
      translations: {}
    };
    await new TranscriptionDocumentStore(path.join(dir, 'docs')).save(document);
  });
  afterEach(async () => {
    await queue.shutdown();
    delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
    delete process.env.AGENT_TRANSLATION_CACHE_PATH;
    delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects unknown jobs, invalid languages, and a missing translator', async () => {
    expect(await queue.requestTranslation('nope', 'uk')).toEqual({ outcome: 'no-document' });
    expect(await queue.requestTranslation(jobId, '../x')).toEqual({ outcome: 'invalid-language' });
    expect(await queue.requestTranslation(jobId, 'xx')).toEqual({ outcome: 'invalid-language' });
    expect(await queue.requestTranslation(jobId, 'uk')).toEqual({ outcome: 'unavailable' });
  });

  it('never resolves media or preview controls for an unknown opaque job id', async () => {
    expect(queue.sourcePath(jobId)).toBe(mediaPath);
    expect(queue.sourcePath('nope')).toBeNull();
    expect(await queue.mediaSource('nope')).toBeNull();
    expect(await queue.playbackMediaSource('nope')).toBeNull();
    expect(await queue.mediaPreviewStatus('nope')).toBeNull();
    expect(await queue.prepareMediaPreview('nope')).toBeNull();
    expect(queue.cancelMediaPreview('nope')).toBe(false);
  });

  it('migrates an old plain-text transcript on demand without putting text in SSE state', async () => {
    const internal = queue as unknown as { jobs: TranscriptionJob[] };
    await new TranscriptionDocumentStore(path.join(dir, 'docs')).remove(jobId);
    Object.assign(internal.jobs[0], {
      status: 'completed',
      text: 'Legacy transcript.',
      detectedLanguage: 'en',
      characters: 18
    });

    expect(queue.state().jobs[0].text).toBeNull();
    const migrated = await queue.document(jobId);
    expect(migrated?.segments.map(segment => segment.sourceText)).toEqual(['Legacy transcript.']);
  });

  it('translates, caches by model version, and reuses the cache instantly', async () => {
    const translator = new GatedTranslator();
    queue.setTranslator(translator);

    const first = await queue.requestTranslation(jobId, 'uk');
    expect(first.outcome).toBe('queued');
    await waitFor(() => translator.calls.length === 1);
    translator.complete(0, 'Привіт світ.');
    await waitFor(
      async () => (await queue.document(jobId))?.translations.uk?.status === 'completed'
    );

    const doc = await queue.document(jobId);
    expect(doc?.translations.uk).toMatchObject({ status: 'completed', modelVersion: 'fake-1' });
    expect(doc?.translations.uk.segments[0].translatedText).toBe('Привіт світ.');

    // Re-request the same language: cached, no new inference.
    const cached = await queue.requestTranslation(jobId, 'uk');
    expect(cached.outcome).toBe('completed');
    await tick();
    expect(translator.calls).toHaveLength(1);

    // A new model version invalidates the cache and re-runs.
    translator.version = 'fake-2';
    const revalidate = await queue.requestTranslation(jobId, 'uk');
    expect(revalidate.outcome).toBe('queued');
    await waitFor(() => translator.calls.length === 2);
  });

  it('supersedes an in-flight request and never lets a stale result win', async () => {
    const translator = new GatedTranslator();
    queue.setTranslator(translator);

    await queue.requestTranslation(jobId, 'uk'); // generation 1
    await waitFor(() => translator.calls.length === 1);

    await queue.requestTranslation(jobId, 'uk'); // generation 2 supersedes
    await waitFor(() => translator.calls[0].signal.aborted); // gen 1 aborted
    await waitFor(() => translator.calls.length === 2); // gen 2 started after gen 1 unwound

    // A late resolve of the aborted gen-1 promise is a no-op (already rejected).
    translator.complete(0, 'STALE');
    translator.complete(1, 'Привіт світ.'); // gen 2 wins
    await waitFor(
      async () => (await queue.document(jobId))?.translations.uk?.status === 'completed'
    );

    const doc = await queue.document(jobId);
    expect(doc?.translations.uk.status).toBe('completed');
    expect(doc?.translations.uk.segments[0].translatedText).toBe('Привіт світ.');
  });

  it('cancels the old target when languages are switched rapidly', async () => {
    const translator = new GatedTranslator();
    queue.setTranslator(translator);

    await queue.requestTranslation(jobId, 'uk');
    await waitFor(() => translator.calls.length === 1);
    await queue.requestTranslation(jobId, 'ar');
    await waitFor(() => translator.calls[0].signal.aborted);
    await waitFor(() => translator.calls.length === 2);
    expect(translator.calls[1].request.targetLanguage).toBe('ar');

    translator.complete(1, 'مرحبًا بالعالم.');
    await waitFor(
      async () => (await queue.document(jobId))?.translations.ar?.status === 'completed'
    );
    const doc = await queue.document(jobId);
    expect(doc?.translations.ar.segments[0].translatedText).toBe('مرحبًا بالعالم.');
    expect(doc?.translations.uk?.status).not.toBe('completed');
  });

  it('cancels obsolete work even when the newly selected language is cached', async () => {
    const translator = new GatedTranslator();
    queue.setTranslator(translator);

    await queue.requestTranslation(jobId, 'uk');
    await waitFor(() => translator.calls.length === 1);
    translator.complete(0, 'Привіт світ.');
    await waitFor(
      async () => (await queue.document(jobId))?.translations.uk?.status === 'completed'
    );

    await queue.requestTranslation(jobId, 'ar');
    await waitFor(() => translator.calls.length === 2);
    const cached = await queue.requestTranslation(jobId, 'uk');

    expect(cached.outcome).toBe('completed');
    await waitFor(() => translator.calls[1].signal.aborted);
    await tick();
    expect(translator.calls).toHaveLength(2);
  });
});
