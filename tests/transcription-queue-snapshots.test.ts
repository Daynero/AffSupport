import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptionJob } from '@video-compressor/shared';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let directory = '';
let queue: TranscriptionQueue | null = null;

afterEach(async () => {
  await queue?.shutdown();
  queue = null;
  delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
  delete process.env.AGENT_TRANSLATION_CACHE_PATH;
  delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
  if (directory) await removeTemporaryDirectory(directory);
  directory = '';
});

function job(id: string, inputPath: string, status: TranscriptionJob['status']): TranscriptionJob {
  return {
    id,
    inputPath,
    fileName: path.basename(inputPath),
    sourceKind: 'local',
    sourceKey: null,
    durationSeconds: 2,
    status,
    progress: status === 'completed' ? 100 : null,
    requestedLanguage: 'auto',
    detectedLanguage: 'en',
    text: status === 'completed' ? 'A transcript' : null,
    characters: 12,
    error: null,
    errorDetails: null,
    batchId: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null
  };
}

async function makeQueue(jobs: TranscriptionJob[]) {
  directory = await mkdtemp(path.join(os.tmpdir(), 'soty-transcription-queue-state-'));
  process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(directory, 'docs');
  process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'cache');
  process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
  queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {}, jobs);
  return queue;
}

describe('transcription queue snapshots and cleanup', () => {
  it('lets a manual language override detection and return safely to automatic detection', async () => {
    const restored = job('language', path.join(os.tmpdir(), 'language.mp3'), 'ready');
    restored.languageSource = 'probe';
    restored.languageConfidence = 0.8;
    restored.languageCandidates = [{ language: 'en', share: 0.8 }];
    restored.languageSamples = 2;
    const subject = await makeQueue([restored]);
    expect(subject.setJobLanguage('absent', 'uk')).toBe(false);
    expect(subject.setJobLanguage('language', 'uk')).toBe(true);
    expect(subject.state().jobs[0]).toMatchObject({
      detectedLanguage: 'uk',
      languageSource: 'manual'
    });
    expect(subject.state().jobs[0]).not.toHaveProperty('languageCandidates');
    expect(subject.state().jobs[0]).not.toHaveProperty('languageConfidence');
    expect(subject.setJobLanguage('language', 'auto')).toBe(true);
    expect(subject.state().jobs[0].detectedLanguage).toBeNull();
    expect(subject.state().jobs[0]).not.toHaveProperty('languageSource');
    expect(await subject.prepareMediaPreview('absent')).toBeNull();
    expect(await subject.playbackMediaSource('absent')).toBeNull();
  });
  it('updates local settings and tooling without starting absent models', async () => {
    const subject = await makeQueue([]);
    subject.updateSettings({ language: 'en', quality: 'accurate' });
    expect(subject.state().settings).toMatchObject({
      language: 'en',
      quality: 'accurate'
    });
    subject.setToolAvailability({ ffmpeg: true, whisper: false });
    expect(subject.state().tools.ffmpeg).toBe(true);
    expect(subject.modelStatus()).toMatchObject({ present: expect.any(Boolean) });
    expect(subject.teamJob('missing')).toBeNull();
    expect(subject.workActive()).toBe(false);
    expect(await subject.sweepCaches()).toMatchObject({
      previews: expect.any(Number)
    });
  });

  it('rejects an unsupported upload and removes its abandoned import copy', async () => {
    const subject = await makeQueue([]);
    const importPath = path.join(directory, 'unsupported.txt');
    await writeFile(importPath, 'not media');
    expect(await subject.addUploaded(importPath, 'unsupported.txt', 'upload-1')).toMatchObject([
      { reason: 'unsupported-format' }
    ]);
    const { access } = await import('node:fs/promises');
    await expect(access(importPath)).rejects.toThrow();
  });

  it('keeps private paths and transcript text out of state, but retains restart metadata', async () => {
    const inputPath = path.join(os.tmpdir(), 'snapshot.mp3');
    const restored = job('snapshot', inputPath, 'completed');
    Object.assign(restored, {
      translation: {
        targetLanguage: 'uk',
        status: 'unavailable',
        progress: null,
        completedSegments: 0,
        totalSegments: 0,
        error: 'TRANSLATOR_UNAVAILABLE'
      }
    });
    const subject = await makeQueue([restored]);
    subject.setInstanceId('agent-1');
    expect(subject.state()).toMatchObject({
      instance: 'agent-1',
      jobs: [{ inputPath: '', text: null }]
    });
    expect(subject.persisted().jobs[0]).toMatchObject({
      inputPath,
      text: null
    });
    expect(await subject.mediaSource('missing')).toBeNull();
    expect(await subject.mediaSource('snapshot')).toBeNull();
    expect(subject.cancelMediaPreview('missing')).toBe(false);
    expect(subject.cancelMediaPreview('snapshot')).toBe(true);
    expect(subject.state().jobs[0]).not.toHaveProperty('translation');
    expect(subject.persisted().jobs[0]).not.toHaveProperty('translation');
  });

  it('removes selected jobs and clears finished jobs without touching ready work', async () => {
    const inputPath = path.join(os.tmpdir(), 'cleanup.mp3');
    const subject = await makeQueue([
      job('done', inputPath, 'completed'),
      job('failed', inputPath, 'failed'),
      job('ready', inputPath, 'ready')
    ]);
    expect(await subject.remove('absent')).toBe(false);
    await subject.removeMany(['failed']);
    expect(subject.persisted().jobs.map(item => item.id)).toEqual(['done', 'ready']);
    await subject.clearCompleted();
    expect(subject.persisted().jobs.map(item => item.id)).toEqual(['ready']);
    await subject.removeMany(['ready']);
    expect(subject.persisted().jobs).toEqual([]);
  });

  it('reads a completed local source only while the file remains accessible', async () => {
    const inputPath = path.join(os.tmpdir(), `soty-source-${Date.now()}.mp3`);
    const subject = await makeQueue([job('media', inputPath, 'completed')]);
    await writeFile(inputPath, 'media');
    try {
      expect(await subject.mediaSource('media')).toMatchObject({
        path: inputPath,
        mimeType: 'audio/mpeg'
      });
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(inputPath);
    }
    expect(await subject.mediaSource('media')).toBeNull();
  });
});
