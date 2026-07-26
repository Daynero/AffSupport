import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TranslateRequest,
  Translator,
  TranslationOutputSegment
} from '../apps/agent/src/translation/translator.js';

vi.mock('../apps/agent/src/whisper/transcriber.js', () => ({
  transcribe: vi.fn(({ onProgress }: { onProgress: (progress: number | null) => void }) => {
    onProgress(50);
    return {
      cancel: vi.fn(),
      done: Promise.resolve({
        code: 0,
        cancelled: false,
        text: 'Hello world.',
        detectedLanguage: 'en',
        stderr: '',
        failedStage: null,
        spawnErrorCode: null,
        words: []
      })
    };
  })
}));

import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000) {
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

class ImmediateTranslator implements Translator {
  calls: TranslateRequest[] = [];

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
    if (signal.aborted) throw new Error('aborted');
    const output = request.segments.map((segment, index) => {
      const translated = {
        sourceSegmentId: segment.id,
        translatedText: 'Привіт, світе.',
        alignments: []
      };
      request.onSegment?.(translated, index);
      return translated;
    });
    return output;
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
    await rm(dir, { recursive: true, force: true });
  });

  it('starts the default translation immediately, reports it in the row, and reuses it', async () => {
    const mediaPath = path.join(dir, 'speech.mp3');
    await writeFile(mediaPath, 'media');
    const translator = new ImmediateTranslator();
    queue.setTranslator(translator);
    queue.updateSettings({ translationLanguage: 'uk' });
    await queue.add([mediaPath]);
    const jobId = queue.state().jobs[0].id;

    expect(await queue.start([jobId])).toBe(true);
    await waitFor(() => queue.state().jobs[0].translation?.status === 'completed');

    expect(translator.calls).toHaveLength(1);
    expect(translator.calls[0].targetLanguage).toBe('uk');
    expect(queue.state().jobs[0].translation).toMatchObject({
      targetLanguage: 'uk',
      status: 'completed',
      progress: 100
    });

    const cached = await queue.requestTranslation(jobId, 'uk');
    expect(cached.outcome).toBe('completed');
    expect(translator.calls).toHaveLength(1);
  });
});
