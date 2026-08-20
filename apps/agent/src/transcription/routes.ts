import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  isTranscribableFileName,
  isValidTargetLanguage,
  type TranscriptionEvent,
  type TranscriptionSettings
} from '@video-compressor/shared';
import { findDroppedSource } from '../files/dropped-source.js';
import { selectTranscribeMedia } from '../files/picker.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import { uploadIntakeMeta } from '../files/upload-intake.js';
import { capabilities, revealInFileManager } from '../platform/platform.js';
import type { EventChannel } from '../server/sse.js';
import { resolveByteRange } from './media.js';
import type { TranscriptionQueue } from '../queue/transcription-queue.js';

interface TranscriptionDeps {
  queue: TranscriptionQueue;
  events: EventChannel<TranscriptionEvent>;
  acceptingNewTasks: () => boolean;
}

export function registerTranscriptionRoutes(app: FastifyInstance, deps: TranscriptionDeps) {
  const { queue, events, acceptingNewTasks } = deps;
  const importRoot =
    process.env.AGENT_TRANSCRIBE_IMPORT_PATH ??
    path.join(applicationSupportRoot(), 'TranscribeImports');

  app.get('/api/transcription/state', async () => queue.state());

  app.get('/api/transcription/events', events.handler);

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
      if (
        body.translationLanguage !== undefined &&
        !isValidTargetLanguage(body.translationLanguage)
      ) {
        return reply.code(400).send({ error: 'Invalid translation language.' });
      }
      queue.updateSettings(body);
      return queue.state();
    }
  );

  app.post('/api/transcription/select', async (_request, reply) => {
    if (!capabilities().nativeFilePicker) {
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
    const { fileName, signature, sourceSize, sourceModifiedAt } = uploadIntakeMeta(part, 'audio');
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
    const droppedSource = await findDroppedSource(fileName, sourceSize, sourceModifiedAt);
    if (droppedSource) {
      part.file.resume();
      const warnings = await queue.add([droppedSource]);
      return { state: queue.state(), warnings };
    }
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

  // One-time install of the local translation model (TranslateGemma).
  app.post('/api/transcription/translator/download', async () => {
    queue.startTranslatorModelDownload();
    return queue.state();
  });

  app.post('/api/transcription/translator/cancel', async () => {
    queue.cancelTranslatorModelDownload();
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

  app.post('/api/transcription/cancel-all', async () => {
    queue.cancelAll();
    return queue.state();
  });

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
      const source = queue.sourcePath(request.params.id);
      if (!source) return reply.code(404).send({ error: 'No source file is available.' });
      revealInFileManager(source);
      return queue.state();
    }
  );

  // The structured document (segments, words, cached translations) is large and
  // fetched on demand — deliberately never carried in `transcription:progress`.
  app.get<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/document',
    async (request, reply) => {
      const document = await queue.document(request.params.id);
      if (!document) return reply.code(404).send({ error: 'No transcript document is available.' });
      return reply.header('Cache-Control', 'private, no-store').send(document);
    }
  );

  // Packages the creative + transcript + translation into a folder next to the
  // source file, then reveals it. The web client passes localized names.
  app.post<{
    Params: { id: string };
    Body: { languageLabel?: unknown; fileName?: unknown };
  }>('/api/transcription/jobs/:id/save-with-translation', async (request, reply) => {
    const languageLabel =
      typeof request.body?.languageLabel === 'string'
        ? request.body.languageLabel.slice(0, 64)
        : '';
    const fileName =
      typeof request.body?.fileName === 'string' ? request.body.fileName.slice(0, 128) : '';
    const result = await queue.saveWithTranslation(request.params.id, languageLabel, fileName);
    switch (result.outcome) {
      case 'saved':
        revealInFileManager(result.folderPath);
        return queue.state();
      case 'not-local':
        return reply.code(409).send({ error: 'SOURCE_NOT_LOCAL' });
      case 'no-translation':
        return reply.code(409).send({ error: 'TRANSLATION_NOT_READY' });
      case 'failed':
        return reply.code(500).send({ error: 'SAVE_FAILED' });
      case 'not-found':
      default:
        return reply.code(404).send({ error: 'No source file is available.' });
    }
  });

  // Kick off (or return a cached) translation into a target language.
  app.post<{
    Params: { id: string };
    Body: { targetLanguage?: unknown; requestId?: unknown };
  }>('/api/transcription/jobs/:id/translations', async (request, reply) => {
    const targetLanguage = request.body?.targetLanguage;
    if (typeof targetLanguage !== 'string' || !targetLanguage.trim()) {
      return reply.code(400).send({ error: 'A target language is required.' });
    }
    const requestId =
      typeof request.body?.requestId === 'string' && request.body.requestId.length <= 128
        ? request.body.requestId
        : undefined;
    const result = await queue.requestTranslation(
      request.params.id,
      targetLanguage.trim(),
      requestId
    );
    switch (result.outcome) {
      case 'completed':
      case 'queued':
        return reply.header('Cache-Control', 'private, no-store').send(result.translation);
      case 'invalid-language':
        return reply.code(400).send({ error: 'That target language is not supported.' });
      case 'unavailable':
        return reply.code(503).send({ error: 'TRANSLATOR_UNAVAILABLE' });
      case 'no-document':
      default:
        return reply.code(404).send({ error: 'No transcript document is available.' });
    }
  });

  app.get<{ Params: { id: string; language: string } }>(
    '/api/transcription/jobs/:id/translations/:language',
    async (request, reply) => {
      const translation = await queue.translation(request.params.id, request.params.language);
      if (!translation) return reply.code(404).send({ error: 'No translation is available.' });
      return reply.header('Cache-Control', 'private, no-store').send(translation);
    }
  );

  // User-initiated cancel of the job's running/queued translation. Persisted
  // partial segments are kept so a retry resumes where it stopped.
  app.delete<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/translations',
    async (request, reply) => {
      const cancelled = await queue.cancelTranslation(request.params.id);
      if (!cancelled) return reply.code(404).send({ error: 'No running translation.' });
      return queue.state();
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/media/status',
    async (request, reply) => {
      const status = await queue.mediaPreviewStatus(request.params.id).catch(() => null);
      return status
        ? reply.header('Cache-Control', 'private, no-store').send(status)
        : reply.code(404).send({ error: 'The media is unavailable.' });
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/media/prepare',
    async (request, reply) => {
      const status = await queue.prepareMediaPreview(request.params.id).catch(() => null);
      return status
        ? reply.header('Cache-Control', 'private, no-store').send(status)
        : reply.code(404).send({ error: 'The media is unavailable.' });
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/media/cancel',
    async (request, reply) =>
      queue.cancelMediaPreview(request.params.id)
        ? reply.send({ ok: true })
        : reply.code(404).send({ error: 'The media is unavailable.' })
  );

  // Serves the original source media locally, with HTTP Range so the player can
  // seek without re-downloading. Unsupported input is served from a cached,
  // local browser-compatible proxy after `/media/prepare`. Token-gated by the
  // global `/api/` preHandler.
  app.get<{ Params: { id: string } }>(
    '/api/transcription/jobs/:id/media',
    async (request, reply) => {
      const knownSource = await queue.mediaSource(request.params.id);
      if (!knownSource) return reply.code(404).send({ error: 'The media is unavailable.' });
      const source = await queue.playbackMediaSource(request.params.id);
      if (!source) return reply.code(409).send({ error: 'PREVIEW_NOT_READY' });

      let size: number;
      try {
        size = (await stat(source.path)).size;
      } catch {
        return reply.code(404).send({ error: 'The media is unavailable.' });
      }

      reply
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'private, no-store')
        .header(
          'Content-Disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(source.fileName)}`
        )
        .type(source.mimeType);

      const resolved = resolveByteRange(request.headers.range, size);
      if (resolved.kind === 'unsatisfiable') {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      if (resolved.kind === 'full') {
        return reply.header('Content-Length', String(size)).send(createReadStream(source.path));
      }
      const { start, end } = resolved.range;
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', String(end - start + 1))
        .send(createReadStream(source.path, { start, end }));
    }
  );
}
