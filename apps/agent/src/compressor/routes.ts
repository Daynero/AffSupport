import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  AgentEvent,
  AgentSettingsPatch,
  ImageAsset,
  ImageSlot
} from '@video-compressor/shared';
import { findDroppedSource } from '../files/dropped-source.js';
import { selectOutputFolder, selectVideos } from '../files/picker.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import { uploadIntakeMeta } from '../files/upload-intake.js';
import { ImageAssetError, MAX_IMAGE_BYTES, type ImageAssetStore } from '../images/store.js';
import { openPath, revealInFileManager } from '../platform/platform.js';
import { isSupportedVideoPath, type JobQueue } from '../queue/queue.js';
import type { EventChannel } from '../server/sse.js';
import { parseSettingsPatch } from './settings-validation.js';

export interface CompressorEstimator {
  pause(): Promise<void>;
  resume(): void;
  shutdown(): Promise<void>;
}

export interface CompressorContext {
  queue: JobQueue;
  estimator: CompressorEstimator;
  imageStore: ImageAssetStore;
  events: EventChannel<AgentEvent>;
  /** Live tool availability, shared with (and refreshed by) the entrypoint. */
  tools: { ffmpeg: boolean; ffprobe: boolean };
}

export function registerCompressorRoutes(app: FastifyInstance, ctx: CompressorContext): void {
  const { queue, estimator, imageStore, events, tools } = ctx;
  // Files chosen through the native picker but flagged with a warning (for
  // example duplicates) wait here until the user confirms re-adding them.
  const pendingSelections = new Map<string, string>();

  app.get('/api/queue', async () => queue.state());
  app.get('/api/events', events.handler);

  app.post('/api/files/select', async (_request, reply) => {
    if (process.platform !== 'darwin') {
      return reply
        .code(501)
        .send({ error: 'The native file picker is unavailable on this system.' });
    }
    const paths = await selectVideos();
    const warnings = await queue.add(paths);
    for (const warning of warnings) {
      const selected = paths.find(value => path.basename(value) === warning.fileName);
      if (
        selected &&
        warning.reason !== 'unsupported-format' &&
        warning.reason !== 'inaccessible'
      ) {
        pendingSelections.set(warning.id, selected);
      }
    }
    return { state: queue.state(), warnings };
  });

  // Finder drops can include a file:// URL. Retain that source path rather than
  // importing a copy, so "next to originals" really means next to the original.
  app.post<{ Body: { paths?: unknown } }>('/api/files/add', async (request, reply) => {
    const paths = request.body?.paths;
    if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string')) {
      return reply.code(400).send({ error: 'Invalid file paths.' });
    }
    const localPaths = paths
      .filter(value => path.isAbsolute(value))
      .map(value => path.resolve(value));
    if (!localPaths.length)
      return reply.code(400).send({ error: 'No local file paths were provided.' });
    const warnings = await queue.add(localPaths);
    return { state: queue.state(), warnings };
  });

  app.post('/api/files/upload', async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'No file was provided.' });
    const { fileName, signature, sourceSize, sourceModifiedAt } = uploadIntakeMeta(part, 'video');
    if (!isSupportedVideoPath(fileName)) {
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

    const importRoot =
      process.env.AGENT_IMPORT_PATH ?? path.join(applicationSupportRoot(), 'Imports');
    await mkdir(importRoot, { recursive: true });
    const directory = await mkdtemp(path.join(importRoot, 'import-'));
    const inputPath = path.join(directory, fileName);
    try {
      await pipeline(part.file, createWriteStream(inputPath, { flags: 'wx' }));
      if (part.file.truncated) throw new Error('The file is too large.');
      const warnings = await queue.addUploaded(inputPath, fileName, signature);
      if (warnings.length) await rm(directory, { recursive: true, force: true });
      return { state: queue.state(), warnings };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'The file could not be imported.'
      });
    }
  });

  app.post<{ Params: { slot: string } }>('/api/images/:slot', async (request, reply) => {
    const slot = imageSlot(request.params.slot);
    if (!slot) return reply.code(400).send({ error: 'IMAGE_SLOT_INVALID' });
    const part = await request.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
    if (!part) return reply.code(400).send({ error: 'IMAGE_MISSING' });
    let asset: ImageAsset | null = null;
    try {
      asset = await imageStore.import(
        part.file,
        part.filename || 'image',
        part.mimetype || 'application/octet-stream'
      );
      await queue.addImage(slot, asset);
      return queue.state();
    } catch (error) {
      if (asset) await queue.releaseImageIfUnused(asset);
      const code = error instanceof ImageAssetError ? error.code : 'IMAGE_IMPORT_FAILED';
      return reply.code(code === 'IMAGE_TOO_LARGE' ? 413 : 400).send({ error: code });
    }
  });

  app.delete<{ Params: { slot: string; id: string } }>(
    '/api/images/:slot/:id',
    async (request, reply) => {
      const slot = imageSlot(request.params.slot);
      if (!slot) return reply.code(400).send({ error: 'IMAGE_SLOT_INVALID' });
      const previous = await queue.removeImage(slot, request.params.id);
      if (!previous) return reply.code(404).send({ error: 'IMAGE_UNAVAILABLE' });
      await queue.releaseImageIfUnused(previous);
      return queue.state();
    }
  );

  app.get<{ Params: { id: string } }>('/api/images/:id/content', async (request, reply) => {
    const asset = queue.imageAsset(request.params.id);
    if (!asset) return reply.code(404).send({ error: 'IMAGE_UNAVAILABLE' });
    try {
      const filePath = await imageStore.validate(asset);
      return reply
        .header('Cache-Control', 'private, no-store')
        .type(asset.mimeType)
        .send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: 'IMAGE_UNAVAILABLE' });
    }
  });

  app.post<{ Body: { ids?: unknown } }>('/api/files/confirm', async (request, reply) => {
    if (
      !request.body ||
      !Array.isArray(request.body.ids) ||
      !request.body.ids.every(id => typeof id === 'string')
    ) {
      return reply.code(400).send({ error: 'Invalid confirmation.' });
    }
    const paths = request.body.ids
      .map(id => pendingSelections.get(id))
      .filter((value): value is string => Boolean(value));
    request.body.ids.forEach(id => pendingSelections.delete(id));
    await queue.add(paths, true);
    return queue.state();
  });

  app.post('/api/output/select', async () => {
    const folder = await selectOutputFolder();
    if (folder) {
      await queue.updateSettings({ outputMode: 'chosen-folder', outputFolder: folder });
    }
    return queue.state();
  });

  app.post<{ Body: AgentSettingsPatch }>('/api/settings', async (request, reply) => {
    const parsed = parseSettingsPatch(request.body, queue.state().settings.imageEmbedding);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    await queue.updateSettings(parsed.patch);
    return queue.state();
  });

  app.post<{ Body: { ids?: unknown } }>('/api/queue/start', async (request, reply) => {
    if (!queue.acceptingNewTasks()) {
      return reply.code(409).send({ error: 'UPDATE_PENDING' });
    }
    if (!tools.ffmpeg) {
      return reply.code(503).send({ error: 'The bundled video engine is unavailable.' });
    }
    if (
      !request.body ||
      !Array.isArray(request.body.ids) ||
      !request.body.ids.every(id => typeof id === 'string')
    ) {
      return reply.code(400).send({ error: 'Choose one or more ready videos.' });
    }
    const invalidImageWasCleared = await queue.revalidateSettingsImages();
    if (invalidImageWasCleared) return reply.code(400).send({ error: 'IMAGE_UNAVAILABLE' });
    const embeddingError = queue.embeddingConfigurationError();
    if (embeddingError) return reply.code(400).send({ error: embeddingError });
    await estimator.pause();
    const started = await queue.start(request.body.ids);
    if (!started) {
      estimator.resume();
      return reply.code(409).send({ error: 'No selected videos are ready to start.' });
    }
    return queue.state();
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/estimate-priority', async (request, reply) =>
    queue.prioritizeEstimate(request.params.id)
      ? queue.state()
      : reply.code(409).send({ error: 'This estimate cannot be prioritized.' })
  );
  app.delete<{ Params: { id: string } }>(
    '/api/jobs/:id/estimate-priority',
    async (request, reply) =>
      queue.cancelPrioritizedEstimate(request.params.id)
        ? queue.state()
        : reply.code(409).send({ error: 'This estimate is not prioritized.' })
  );
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request, reply) =>
    (await queue.cancel(request.params.id))
      ? queue.state()
      : reply.code(409).send({ error: 'Only the current job can be cancelled.' })
  );
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) =>
    queue.remove(request.params.id)
      ? queue.state()
      : reply.code(409).send({ error: 'An active job cannot be removed.' })
  );
  app.post<{ Body: { ids?: unknown } }>('/api/jobs/remove', async (request, reply) => {
    if (
      !request.body ||
      !Array.isArray(request.body.ids) ||
      !request.body.ids.every(id => typeof id === 'string')
    ) {
      return reply.code(400).send({ error: 'Invalid selection.' });
    }
    queue.removeMany(request.body.ids);
    return queue.state();
  });
  app.delete('/api/jobs/completed', async () => {
    queue.clearCompleted();
    return queue.state();
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request, reply) =>
    (await queue.retry(request.params.id))
      ? queue.state()
      : reply.code(409).send({ error: 'This job cannot be retried.' })
  );
  app.post<{ Params: { id: string } }>('/api/jobs/:id/repeat', async (request, reply) => {
    if (await queue.revalidateSettingsImages()) {
      return reply.code(400).send({ error: 'IMAGE_UNAVAILABLE' });
    }
    const embeddingError = queue.embeddingConfigurationError();
    if (embeddingError) return reply.code(400).send({ error: embeddingError });
    await estimator.pause();
    if (await queue.repeat(request.params.id)) return queue.state();
    estimator.resume();
    return reply.code(409).send({ error: 'This completed job cannot be repeated right now.' });
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/reveal', async (request, reply) => {
    const job = queue
      .state()
      .jobs.find(
        candidate => candidate.id === request.params.id && candidate.status === 'completed'
      );
    if (!job) return reply.code(404).send({ error: 'Completed file not found.' });
    revealInFileManager(job.outputPath);
    return queue.state();
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/open', async (request, reply) => {
    const job = queue
      .state()
      .jobs.find(
        candidate => candidate.id === request.params.id && candidate.status === 'completed'
      );
    if (!job) return reply.code(404).send({ error: 'Completed file not found.' });
    openPath(job.outputPath);
    return queue.state();
  });
  app.post('/api/output/reveal', async (_request, reply) => {
    const folder = queue.outputFolder();
    if (!folder) return reply.code(404).send({ error: 'No output folder is available yet.' });
    openPath(folder);
    return queue.state();
  });
}

function imageSlot(value: string): ImageSlot | null {
  return value === 'start' || value === 'end' ? value : null;
}
