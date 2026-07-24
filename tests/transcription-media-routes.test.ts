import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { registerTranscriptionRoutes } from '../apps/agent/src/transcription/routes.js';

describe('token-gated transcription media Range endpoint', () => {
  let dir: string;
  let mediaPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-media-route-'));
    mediaPath = path.join(dir, 'clip.mp4');
    await writeFile(mediaPath, '0123456789');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function server() {
    const app = Fastify();
    app.addHook('preHandler', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      const supplied =
        request.headers['x-session-token'] ?? (request.query as { token?: string }).token;
      if (supplied !== 'secret') return reply.code(401).send({ error: 'Invalid session token.' });
    });
    const source = { path: mediaPath, mimeType: 'video/mp4', fileName: 'clip.mp4' };
    const queue = {
      mediaSource: async (id: string) => (id === 'known' ? source : null),
      playbackMediaSource: async (id: string) => (id === 'known' ? source : null)
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

  it('rejects missing tokens and unknown opaque job ids', async () => {
    const app = await server();
    expect((await app.inject({ url: '/api/transcription/jobs/known/media' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/transcription/jobs/not-known/media?token=secret'
        })
      ).statusCode
    ).toBe(404);
    await app.close();
  });

  it('streams only the requested bytes with seek-compatible headers', async () => {
    const app = await server();
    const response = await app.inject({
      url: '/api/transcription/jobs/known/media?token=secret',
      headers: { range: 'bytes=3-6' }
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('3456');
    expect(response.headers).toMatchObject({
      'accept-ranges': 'bytes',
      'content-length': '4',
      'content-range': 'bytes 3-6/10',
      'content-type': 'video/mp4'
    });

    const invalid = await app.inject({
      url: '/api/transcription/jobs/known/media?token=secret',
      headers: { range: 'bytes=20-30' }
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */10');
    await app.close();
  });
});
