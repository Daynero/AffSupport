import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';

const processMock = vi.hoisted(() => ({
  unref: vi.fn(),
  spawn: vi.fn()
}));

vi.mock('node:child_process', () => ({
  spawn: processMock.spawn
}));

import { registerTranscriptionRoutes } from '../apps/agent/src/transcription/routes.js';

describe('revealing a completed transcription source', () => {
  beforeEach(() => {
    processMock.unref.mockReset();
    processMock.spawn.mockReset().mockReturnValue({ unref: processMock.unref });
  });

  async function server() {
    const app = Fastify();
    const queue = {
      sourcePath: (id: string) => (id === 'known' ? '/Users/example/Movies/source.mp4' : null),
      state: () => ({ jobs: [] })
    } as unknown as TranscriptionQueue;
    registerTranscriptionRoutes(app, {
      queue,
      clients: new Set(),
      allowedOrigins: new Set(),
      acceptingNewTasks: () => true
    });
    await app.ready();
    return app;
  }

  it('asks Finder to reveal the original media path, not a transcript file', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/api/transcription/jobs/known/reveal'
    });

    expect(response.statusCode).toBe(200);
    expect(processMock.spawn).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-R', '/Users/example/Movies/source.mp4'],
      {
        shell: false,
        detached: true,
        stdio: 'ignore'
      }
    );
    expect(processMock.unref).toHaveBeenCalledOnce();
    await app.close();
  });

  it('does not open Finder for an unknown job', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/api/transcription/jobs/missing/reveal'
    });

    expect(response.statusCode).toBe(404);
    expect(processMock.spawn).not.toHaveBeenCalled();
    await app.close();
  });
});
