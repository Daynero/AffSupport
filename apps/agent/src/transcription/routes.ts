import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isTranscribableFileName, type TranscriptionSettings } from '@video-compressor/shared';
import { eventStreamHeaders } from '../http.js';
import { selectTranscribeMedia } from '../files/picker.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import type { TranscriptionQueue } from '../queue/transcription-queue.js';

interface TranscriptionDeps {
  queue: TranscriptionQueue;
  clients: Set<NodeJS.WritableStream>;
  allowedOrigins: ReadonlySet<string>;
  acceptingNewTasks: () => boolean;
}

export function registerTranscriptionRoutes(app: FastifyInstance, deps: TranscriptionDeps) {
  const { queue, clients, allowedOrigins, acceptingNewTasks } = deps;
  const importRoot =
    process.env.AGENT_TRANSCRIBE_IMPORT_PATH ??
    path.join(applicationSupportRoot(), 'TranscribeImports');

  app.get('/api/transcription/state', async () => queue.state());

  app.get('/api/transcription/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, eventStreamHeaders(request.headers.origin, allowedOrigins));
    clients.add(reply.raw);
    reply.raw.write(
      `data: ${JSON.stringify({ type: 'transcription:state', state: queue.state() })}\n\n`
    );
    request.raw.on('close', () => clients.delete(reply.raw));
  });

  app.post<{ Body: Partial<TranscriptionSettings> }>(
    '/api/transcription/settings',
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== 'object') {
        return reply.code(400).send({ error: 'Invalid settings.' });
      }
      if (body.language !== undefined && typeof body.language !== 'string') {
        return reply.code(400).send({ error: 'Invalid language.' });
      }
      queue.updateSettings(body);
      return queue.state();
    }
  );

  app.post('/api/transcription/select', async (_request, reply) => {
    if (process.platform !== 'darwin') {
      return reply
        .code(501)
        .send({ error: 'The native file picker is unavailable on this system.' });
    }
    const paths = await selectTranscribeMedia();
    const warnings = await queue.add(paths);
    return { state: queue.state(), warnings };
  });

  app.post<{ Body: { paths?: unknown } }>(
    '/api/transcription/files/add',
    async (request, reply) => {
      const paths = request.body?.paths;
      if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string')) {
        return reply.code(400).send({ error: 'Invalid file paths.' });
      }
      const localPaths = paths
        .filter(value => path.isAbsolute(value))
        .map(value => path.resolve(value));
      if (!localPaths.length) {
        return reply.code(400).send({ error: 'No local file paths were provided.' });
      }
      const warnings = await queue.add(localPaths);
      return { state: queue.state(), warnings };
    }
  );

  app.post('/api/transcription/files/upload', async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'No file was provided.' });
    const fileName = path.basename(part.filename || 'audio');
    if (!isTranscribableFileName(fileName)) {
      part.file.resume();
      return {
        state: queue.state(),
        warnings: [
          {
            id: randomBytes(16).toString('hex'),
            fileName,
            reason: 'unsupported-format',
            message: 'This file format is not supported.'
          }
        ]
      };
    }
    const signatureField = part.fields.signature;
    const signature =
      signatureField && 'value' in signatureField && typeof signatureField.value === 'string'
        ? signatureField.value
        : `${fileName}:${Date.now()}`;
    await mkdir(importRoot, { recursive: true });
    const dir = await mkdtemp(path.join(importRoot, 'import-'));
    const target = path.join(dir, fileName);
    try {
      await pipeline(part.file, createWriteStream(target));
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'The file could not be stored.' });
    }
    if (part.file.truncated) {
      return reply.code(413).send({ error: 'The file is too large.' });
    }
    const warnings = await queue.addUploaded(target, fileName, signature);
    return { state: queue.state(), warnings };
  });

  app.post('/api/transcription/model/download', async () => {
    queue.startModelDownload();
    return queue.state();
  });

  app.post('/api/transcription/model/cancel', async () => {
    queue.cancelModelDownload();
    return queue.state();
  });

  app.post<{ Body?: { ids?: unknown } }>('/api/transcription/start', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const state = queue.state();
    if (!state.tools.ffmpeg || !state.tools.whisper) {
      return reply.code(503).send({ error: 'The transcription engine is unavailable.' });
    }
    if (!state.tools.model) {
      return reply.code(409).send({ error: 'MODEL_REQUIRED' });
    }
    const rawIds = request.body?.ids;
    if (!Array.isArray(rawIds) || rawIds.some(id => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'Choose one or more files to transcribe.' });
    }
    const started = await queue.start(rawIds as string[]);
    return started
      ? queue.state()
      : reply.code(409).send({ error: 'No file is ready to transcribe.' });
  });

  app.post<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/cancel',
    async (request, reply) => {
      const cancelled = queue.cancel(request.params.id);
      return cancelled
        ? queue.state()
        : reply.code(409).send({ error: 'The job cannot be cancelled.' });
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/retry',
    async (request, reply) => {
      const retried = await queue.retry(request.params.id);
      return retried
        ? queue.state()
        : reply.code(409).send({ error: 'The job cannot be retried.' });
    }
  );

  app.delete<{ Params: { id: string } }>('/api/transcription/jobs/:id', async (request, reply) => {
    const removed = await queue.remove(request.params.id);
    return removed
      ? queue.state()
      : reply.code(409).send({ error: 'An active job cannot be removed.' });
  });

  app.post<{ Body: { ids?: unknown } }>(
    '/api/transcription/jobs/remove',
    async (request, reply) => {
      const ids = request.body?.ids;
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
        return reply.code(400).send({ error: 'Invalid job ids.' });
      }
      await queue.removeMany(ids as string[]);
      return queue.state();
    }
  );

  app.delete('/api/transcription/completed', async () => {
    await queue.clearCompleted();
    return queue.state();
  });

  app.post<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/reveal',
    async (request, reply) => {
      const output = queue.transcriptPath(request.params.id);
      if (!output) return reply.code(404).send({ error: 'No transcript is available yet.' });
      spawn('/usr/bin/open', ['-R', output], {
        shell: false,
        detached: true,
        stdio: 'ignore'
      }).unref();
      return queue.state();
    }
  );
}
