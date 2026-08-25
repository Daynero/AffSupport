import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TranslateRequest,
  Translator,
  TranslationOutputSegment
} from '../apps/agent/src/translation/translator.js';

vi.mock('../apps/agent/src/whisper/transcriber.js', () => ({
  transcribe: vi.fn(
    ({
      inputPath,
      onProgress
    }: {
      inputPath: string;
      onProgress: (progress: number | null) => void;
    }) => {
      const fileName = inputPath.split(/[\\/]/u).at(-1) ?? 'media';
      const text = `Transcript for ${fileName}.`;
      onProgress(50);
      return {
        cancel: vi.fn(),
        done: Promise.resolve({
          code: 0,
          cancelled: false,
          text,
          detectedLanguage: 'en',
          stderr: '',
          failedStage: null,
          spawnErrorCode: null,
          words: []
        })
      };
    }
  )
}));

import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { waitFor } from './support/wait.js';

function translatedOutput(request: TranslateRequest): TranslationOutputSegment[] {
  return request.segments.map((segment, index) => {
    const translated = {
      sourceSegmentId: segment.id,
      translatedText: `Переклад ${segment.text}`,
      alignments: []
    };
    request.onSegment?.(translated, index);
    return translated;
  });
}

class ImmediateTranslator implements Translator {
  calls: TranslateRequest[] = [];

  constructor(private readonly onCall: () => void = () => {}) {}

  available(): boolean {
    return true;
  }

  modelVersion(): string {
    return 'automatic-test-1';
  }

  async translate(
    request: TranslateRequest,
    signal: AbortSignal
  ): Promise<TranslationOutputSegment[]> {
    this.calls.push(request);
    this.onCall();
    if (signal.aborted) throw new Error('aborted');
    return translatedOutput(request);
  }
}

class PreemptibleTranslator implements Translator {
  calls: TranslateRequest[] = [];
  statusesAtCall: string[][] = [];
  abortedCalls = 0;

  constructor(private readonly statuses: () => string[]) {}

  available(): boolean {
    return true;
  }

  modelVersion(): string {
    return 'preemption-test-1';
  }

  async translate(
    request: TranslateRequest,
    signal: AbortSignal
  ): Promise<TranslationOutputSegment[]> {
    this.calls.push(request);
    this.statusesAtCall.push(this.statuses());
    if (this.calls.length === 1) {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          this.abortedCalls += 1;
          reject(new Error('aborted'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (signal.aborted) throw new Error('aborted');
    return translatedOutput(request);
  }
}

describe('automatic post-transcription translation', () => {
  let dir: string;
  let queue: TranscriptionQueue;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-auto-translation-'));
    const modelPath = path.join(dir, 'whisper.bin');
    await writeFile(modelPath, 'model');
    process.env.WHISPER_MODEL_PATH = modelPath;
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(dir, 'docs');
    process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(dir, 'cache');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(dir, 'previews');
    queue = new TranscriptionQueue({ ffmpeg: true, whisper: true }, () => {});
  });

  afterEach(async () => {
    await queue.shutdown();
    delete process.env.WHISPER_MODEL_PATH;
    delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
    delete process.env.AGENT_TRANSLATION_CACHE_PATH;
    delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
    // A18: the queue's workers may still be flushing when this runs, and a
    // plain recursive remove fails with ENOTEMPTY on a directory that was empty
    // when the walk started. Retried rather than raced.
    await removeTemporaryDirectory(dir);
  });

  it('waits for the whole transcription batch before translating and reuses cached work', async () => {
    const mediaPaths = [path.join(dir, 'first.mp3'), path.join(dir, 'second.mp3')];
    await Promise.all(mediaPaths.map(mediaPath => writeFile(mediaPath, 'media')));
    const statusesAtCall: string[][] = [];
    const translator = new ImmediateTranslator(() => {
      statusesAtCall.push(queue.state().jobs.map(job => job.status));
    });
    queue.setTranslator(translator);
    queue.updateSettings({ translationLanguage: 'uk' });
    await queue.add(mediaPaths);
    const jobIds = queue.state().jobs.map(job => job.id);

    expect(await queue.start(jobIds)).toBe(true);
    await waitFor(() => queue.state().jobs.every(job => job.translation?.status === 'completed'));

    expect(translator.calls).toHaveLength(2);
    expect(translator.calls[0].targetLanguage).toBe('uk');
    expect(statusesAtCall).toHaveLength(2);
    expect(statusesAtCall[0]).toEqual(['completed', 'completed']);
    expect(
      statusesAtCall.every(statuses =>
        statuses.every(status => status !== 'queued' && status !== 'processing')
      )
    ).toBe(true);
    expect(queue.state().jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          translation: expect.objectContaining({
            targetLanguage: 'uk',
            status: 'completed',
            progress: 100
          })
        })
      ])
    );

    const cached = await queue.requestTranslation(jobIds[0], 'uk');
    expect(cached.outcome).toBe('completed');
    expect(translator.calls).toHaveLength(2);
  });

  it('preempts an active translation for a newly started transcription, then resumes it', async () => {
    const firstPath = path.join(dir, 'first.mp3');
    const secondPath = path.join(dir, 'second.mp3');
    await Promise.all([writeFile(firstPath, 'media'), writeFile(secondPath, 'media')]);
    const translator = new PreemptibleTranslator(() => queue.state().jobs.map(job => job.status));
    queue.setTranslator(translator);
    queue.updateSettings({ translationLanguage: 'uk' });

    await queue.add([firstPath]);
    const firstId = queue.state().jobs[0].id;
    expect(await queue.start([firstId])).toBe(true);
    await waitFor(
      () =>
        translator.calls.length === 1 && queue.state().jobs[0].translation?.status === 'processing'
    );

    await queue.add([secondPath]);
    const secondId = queue.state().jobs[1].id;
    expect(await queue.start([secondId])).toBe(true);

    await waitFor(() => queue.state().jobs[1].status === 'completed');
    expect(translator.abortedCalls).toBe(1);
    await waitFor(() => queue.state().jobs.every(job => job.translation?.status === 'completed'));

    expect(translator.calls).toHaveLength(3);
    expect(
      translator.statusesAtCall
        .slice(1)
        .every(statuses => statuses.every(status => status !== 'queued' && status !== 'processing'))
    ).toBe(true);
  });
});
