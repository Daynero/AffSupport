import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptionDocument, TranscriptionJob } from '@video-compressor/shared';
import {
  loadTranscriptionState,
  saveTranscriptionState,
  TRANSCRIPTION_INTERRUPTED_CODE
} from '../apps/agent/src/queue/transcription-store.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let directory = '';
let docsDir = '';
let stateFile = '';
let queue: TranscriptionQueue | null = null;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-transcription-state-'));
  docsDir = path.join(directory, 'docs');
  stateFile = path.join(directory, 'transcription-state.json');
  process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = docsDir;
  process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'cache');
  process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
});

afterEach(async () => {
  await queue?.shutdown();
  queue = null;
  delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
  delete process.env.AGENT_TRANSLATION_CACHE_PATH;
  delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
  await removeTemporaryDirectory(directory);
  directory = '';
});

function makeJob(
  overrides: Partial<TranscriptionJob> & { id: string; inputPath: string }
): TranscriptionJob {
  return {
    fileName: path.basename(overrides.inputPath),
    sourceKind: 'local',
    sourceKey: null,
    durationSeconds: 12,
    status: 'ready',
    progress: null,
    requestedLanguage: 'auto',
    detectedLanguage: null,
    text: null,
    characters: null,
    translation: null,
    error: null,
    errorDetails: null,
    batchId: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    ...overrides
  };
}

async function writeDocument(jobId: string, text = 'Hello world.'): Promise<TranscriptionDocument> {
  const document: TranscriptionDocument = {
    jobId,
    sourceLanguage: 'en',
    modelVersion: 'large-v3',
    segments: [{ id: `${jobId}-s0`, startMs: 0, endMs: 1000, sourceText: text, words: [] }],
    translations: {}
  };
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, `${jobId}.json`), JSON.stringify(document));
  return document;
}

describe('persistent transcription state', () => {
  it('round-trips jobs and settings without duplicating transcripts', async () => {
    const source = path.join(directory, 'talk.mp3');
    await writeFile(source, 'media');
    await writeDocument('done-1');
    await saveTranscriptionState(
      {
        settings: { language: 'uk', translationLanguage: 'en' },
        jobs: [
          makeJob({ id: 'ready-1', inputPath: source }),
          makeJob({
            id: 'done-1',
            inputPath: source,
            status: 'completed',
            progress: 100,
            detectedLanguage: 'en',
            text: 'Hello world.',
            characters: 12,
            translation: {
              targetLanguage: 'uk',
              status: 'completed',
              progress: 100,
              completedSegments: 1,
              totalSegments: 1,
              error: null
            },
            startedAt: Date.now() - 2000,
            finishedAt: Date.now() - 1000
          })
        ]
      },
      stateFile
    );

    const restored = await loadTranscriptionState(stateFile);
    expect(restored.settings).toEqual({ language: 'uk', translationLanguage: 'en' });
    expect(restored.jobs.map(job => job.status)).toEqual(['ready', 'completed']);
    const completed = restored.jobs[1];
    expect(completed.progress).toBe(100);
    expect(completed.characters).toBe(12);
    // The transcript itself lives in the document sidecar, never in the list.
    expect(completed.text).toBeNull();
    expect(completed.translation).toMatchObject({ targetLanguage: 'uk', status: 'completed' });
  });

  it('returns an empty state for a missing or corrupt file', async () => {
    const missing = await loadTranscriptionState(path.join(directory, 'nope.json'));
    expect(missing.jobs).toEqual([]);
    expect(missing.settings).toEqual({ language: 'auto', translationLanguage: 'uk' });

    await writeFile(stateFile, '{ this is not json');
    const corrupt = await loadTranscriptionState(stateFile);
    expect(corrupt.jobs).toEqual([]);
    expect(corrupt.settings).toEqual({ language: 'auto', translationLanguage: 'uk' });
  });

  it('restores an interrupted transcription as interrupted, not failed', async () => {
    const source = path.join(directory, 'interview.mp3');
    await writeFile(source, 'media');
    await saveTranscriptionState(
      {
        settings: { language: 'auto', translationLanguage: 'uk' },
        jobs: [
          makeJob({
            id: 'mid-run',
            inputPath: source,
            status: 'processing',
            progress: 42,
            startedAt: Date.now() - 500
          })
        ]
      },
      stateFile
    );

    const restored = await loadTranscriptionState(stateFile);
    expect(restored.jobs).toHaveLength(1);
    const job = restored.jobs[0];
    // A12: the compressor has always called this `interrupted` and transcription called it
    // `failed`, so the same event — the agent stopping mid-run — told the user their work had
    // broken in one tool and had been interrupted in the other.
    expect(job.status).toBe('interrupted');
    expect(job.errorDetails).toBe(TRANSCRIPTION_INTERRUPTED_CODE);
    expect(job.error).toContain('interrupted');
    expect(job.finishedAt).toBeTypeOf('number');

    // The web retry button posts /jobs/:id/retry — the restored job must accept it.
    queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {}, restored.jobs);
    expect(await queue.retry('mid-run')).toBe(true);
    expect(queue.state().jobs[0].status).toBe('queued');
  });

  it('leaves a record already persisted as failed exactly as it is', async () => {
    const source = path.join(directory, 'broken.mp3');
    await writeFile(source, 'media');
    await saveTranscriptionState(
      {
        settings: { language: 'auto', translationLanguage: 'uk' },
        jobs: [
          makeJob({
            id: 'really-failed',
            inputPath: source,
            status: 'failed',
            error: 'The transcription was interrupted when the agent stopped.'
          })
        ]
      },
      stateFile
    );

    const restored = await loadTranscriptionState(stateFile);

    // Only a run that was still `processing` when the agent stopped gets the new state.
    // Rewriting history would relabel genuine failures — including ones whose message happens
    // to read like an interruption — as something the user could simply resume.
    expect(restored.jobs[0].status).toBe('failed');
  });

  it('keeps restored queued jobs waiting for an explicit start', async () => {
    const source = path.join(directory, 'queued.mp3');
    await writeFile(source, 'media');
    await saveTranscriptionState(
      {
        settings: { language: 'auto', translationLanguage: 'uk' },
        jobs: [
          makeJob({ id: 'queued-1', inputPath: source, status: 'queued' }),
          makeJob({ id: 'analyzing-1', inputPath: source, status: 'analyzing' })
        ]
      },
      stateFile
    );

    // 'ready' is the only restart-safe waiting state: the pump also runs on
    // model-download completion and after translations drain, so a restored
    // 'queued' job would auto-start without the user pressing anything.
    const restored = await loadTranscriptionState(stateFile);
    expect(restored.jobs.map(job => job.status)).toEqual(['ready', 'ready']);
  });

  it('drops jobs whose backing files disappeared, keeping cached transcripts', async () => {
    const source = path.join(directory, 'still-here.mp3');
    await writeFile(source, 'media');
    await writeDocument('kept-completed');
    await saveTranscriptionState(
      {
        settings: { language: 'auto', translationLanguage: 'uk' },
        jobs: [
          // Waiting job whose source vanished between restarts (e.g. tmp file).
          makeJob({ id: 'gone-ready', inputPath: path.join(directory, 'gone.mp3') }),
          // Completed job whose source vanished: the transcript document is the
          // product and still exists, so the job survives (media playback 404s).
          makeJob({
            id: 'kept-completed',
            inputPath: path.join(directory, 'gone-too.mp3'),
            status: 'completed',
            characters: 12
          }),
          // Completed job whose document sidecar is gone has nothing to show.
          makeJob({ id: 'gone-completed', inputPath: source, status: 'completed' })
        ]
      },
      stateFile
    );

    const restored = await loadTranscriptionState(stateFile);
    expect(restored.jobs.map(job => job.id)).toEqual(['kept-completed']);
    expect(restored.jobs[0].status).toBe('completed');
  });

  it('serves a restored completed job from the document cache', async () => {
    const source = path.join(directory, 'cached.mp3');
    await writeFile(source, 'media');
    const document = await writeDocument('cached-1', 'Cached transcript line.');
    await saveTranscriptionState(
      {
        settings: { language: 'auto', translationLanguage: 'uk' },
        jobs: [
          makeJob({
            id: 'cached-1',
            inputPath: source,
            status: 'completed',
            detectedLanguage: 'en',
            characters: 23
          })
        ]
      },
      stateFile
    );

    const restored = await loadTranscriptionState(stateFile);
    queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, () => {}, restored.jobs);
    await expect(queue.document('cached-1')).resolves.toEqual(document);
  });

  it('still deletes a restored uploaded import when its job is removed', async () => {
    const importDir = path.join(directory, 'TranscribeImports', 'import-x');
    const imported = path.join(importDir, 'upload.mp3');
    await mkdir(importDir, { recursive: true });
    await writeFile(imported, 'media');
    await saveTranscriptionState(
      {
        settings: { language: 'auto', translationLanguage: 'uk' },
        jobs: [
          makeJob({ id: 'upload-1', inputPath: imported, sourceKind: 'uploaded', sourceKey: 'sig' })
        ]
      },
      stateFile
    );

    const restored = await loadTranscriptionState(stateFile);
    queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {}, restored.jobs);
    expect(await queue.remove('upload-1')).toBe(true);
    await expect(access(imported)).rejects.toThrow();
  });
});
