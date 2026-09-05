import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptionState } from '../packages/shared/src/types.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { EventChannel } from '../apps/agent/src/server/sse.js';
import { registerTranscriptionRoutes } from '../apps/agent/src/transcription/routes.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const stateOf = (overrides: Partial<TranscriptionState> = {}): TranscriptionState => ({
  revision: 1,
  jobs: [],
  running: false,
  tools: { ffmpeg: true, whisper: true, model: true },
  model: {
    present: true,
    downloading: false,
    progress: 100,
    sizeBytes: 1,
    downloadedBytes: 1,
    label: 'fast',
    error: null
  },
  models: {
    fast: {
      present: true,
      downloading: false,
      progress: 100,
      sizeBytes: 1,
      downloadedBytes: 1,
      label: 'fast',
      error: null
    },
    accurate: {
      present: false,
      downloading: false,
      progress: null,
      sizeBytes: 3,
      downloadedBytes: 0,
      label: 'accurate',
      error: null
    }
  },
  translatorModel: {
    present: false,
    downloading: false,
    progress: null,
    sizeBytes: 2,
    downloadedBytes: 0,
    label: 't',
    error: null
  },
  translatorRuntime: {
    present: false,
    downloading: false,
    progress: null,
    sizeBytes: 0,
    downloadedBytes: 0,
    label: 'r',
    error: null
  },
  alignmentModel: {
    present: false,
    downloading: false,
    progress: null,
    sizeBytes: 0,
    downloadedBytes: 0,
    label: 'a',
    error: null
  },
  settings: { language: 'auto', translationLanguage: 'uk', quality: 'fast' },
  ...overrides
});

async function server(queue: Record<string, unknown>) {
  const app = Fastify();
  registerTranscriptionRoutes(app, {
    queue: queue as unknown as TranscriptionQueue,
    events: new EventChannel(new Set(), () => ({
      type: 'transcription:state' as const,
      state: stateOf()
    })),
    acceptingNewTasks: () => true
  });
  await app.ready();
  return app;
}

describe('transcription routes: quality, pause and downloads', () => {
  it('refuses a quality it does not know, on settings and on start', async () => {
    const app = await server({ state: () => stateOf(), updateSettings: () => {} });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/settings',
          payload: { quality: 'turbo' }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/start',
          payload: { ids: ['a'], quality: 'best' }
        })
      ).statusCode
    ).toBe(400);
    await app.close();
  });

  it('checks the model of the quality the files will run on, not the selected one', async () => {
    const started: unknown[] = [];
    const app = await server({
      state: () => stateOf(),
      start: async (ids: string[], quality?: string) => {
        started.push([ids, quality]);
        return true;
      }
    });
    // The selected (fast) model is present; the accurate one is not.
    const accurate = await app.inject({
      method: 'POST',
      url: '/api/transcription/start',
      payload: { ids: ['a'], quality: 'accurate' }
    });
    expect(accurate.statusCode).toBe(409);
    expect(accurate.json()).toEqual({ error: 'MODEL_REQUIRED' });
    const fast = await app.inject({
      method: 'POST',
      url: '/api/transcription/start',
      payload: { ids: ['a'], quality: 'fast' }
    });
    expect(fast.statusCode).toBe(200);
    expect(started).toEqual([[['a'], 'fast']]);
    await app.close();
  });

  it('maps the pause outcomes onto status codes', async () => {
    const calls: unknown[] = [];
    let outcome: 'ok' | 'not-found' | 'unsupported' = 'ok';
    const app = await server({
      state: () => stateOf(),
      setPaused: (id: string, paused: boolean) => {
        calls.push([id, paused]);
        return outcome;
      }
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/jobs/j/pause',
          payload: { paused: true }
        })
      ).statusCode
    ).toBe(200);
    // No body means pause; `paused: false` is the resume.
    expect(
      (await app.inject({ method: 'POST', url: '/api/transcription/jobs/j/pause' })).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/jobs/j/pause',
          payload: { paused: false }
        })
      ).statusCode
    ).toBe(200);
    outcome = 'unsupported';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/jobs/j/pause',
          payload: { paused: true }
        })
      ).statusCode
    ).toBe(501);
    outcome = 'not-found';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/jobs/j/pause',
          payload: { paused: true }
        })
      ).statusCode
    ).toBe(409);
    expect(calls).toEqual([
      ['j', true],
      ['j', true],
      ['j', false],
      ['j', true],
      ['j', true]
    ]);
    await app.close();
  });

  it('lets a retry name a quality, like a start', async () => {
    const retried: unknown[] = [];
    const app = await server({
      state: () => stateOf(),
      retry: async (id: string, quality?: string) => {
        retried.push([id, quality]);
        return true;
      }
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/jobs/j/retry',
          payload: { quality: 'accurate' }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/jobs/j/retry',
          payload: { quality: 'x' }
        })
      ).statusCode
    ).toBe(400);
    expect(retried).toEqual([['j', 'accurate']]);
    await app.close();
  });

  it('passes the download options through and refuses a bad quality', async () => {
    const requests: unknown[] = [];
    const app = await server({
      state: () => stateOf(),
      startModelDownload: (options: unknown) => requests.push(options)
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/model/download',
          payload: { quality: 'accurate', speechOnly: true }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transcription/model/download',
          payload: { quality: 'x' }
        })
      ).statusCode
    ).toBe(400);
    expect(requests).toEqual([{ quality: 'accurate', speechOnly: true }]);
    await app.close();
  });
});

describe('transcription queue: per-run quality and pause', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) await removeTemporaryDirectory(directory);
  });

  it('stamps a named quality on the run without touching the setting', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-transcription-controls-'));
    directories.push(directory);
    process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH = path.join(directory, 'docs');
    process.env.AGENT_TRANSLATION_CACHE_PATH = path.join(directory, 'cache');
    process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH = path.join(directory, 'previews');
    try {
      const media = path.join(directory, 'clip.wav');
      await writeFile(media, Buffer.alloc(64));
      // Without the engine the pump refuses to run, so the queued job keeps what start gave it.
      const queue = new TranscriptionQueue({ ffmpeg: false, whisper: false }, () => {});
      expect(await queue.add([media])).toEqual([]);
      const [job] = queue.state().jobs;
      expect(queue.state().settings.quality).toBe('fast');
      expect(await queue.start([job.id], 'accurate')).toBe(true);
      const queued = queue.state().jobs[0];
      expect(queued.status).toBe('queued');
      expect(queued.quality).toBe('accurate');
      expect(queue.state().settings.quality).toBe('fast');
      // Only a running job can be held.
      expect(queue.setPaused(job.id, true)).toBe('not-found');
      expect(queue.setPaused('nope', true)).toBe('not-found');
      await queue.shutdown();
    } finally {
      delete process.env.AGENT_TRANSCRIBE_DOCUMENTS_PATH;
      delete process.env.AGENT_TRANSLATION_CACHE_PATH;
      delete process.env.AGENT_TRANSCRIBE_PREVIEWS_PATH;
    }
  });
});
