import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { LandingSettings } from '@video-compressor/shared';
import { eventStreamHeaders } from '../http.js';
import { selectLandingFolders, selectLandingZips } from '../files/picker.js';
import type { LandingOptimizer } from './optimizer.js';
import { sanitizeRelPath } from './workspace.js';

interface LandingDeps {
  optimizer: LandingOptimizer;
  clients: Set<NodeJS.WritableStream>;
  allowedOrigins: ReadonlySet<string>;
  acceptingNewTasks: () => boolean;
}

export function registerLandingRoutes(app: FastifyInstance, deps: LandingDeps) {
  const { optimizer, clients, allowedOrigins, acceptingNewTasks } = deps;

  app.get('/api/landing/state', async () => optimizer.state());

  app.get('/api/landing/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, eventStreamHeaders(request.headers.origin, allowedOrigins));
    clients.add(reply.raw);
    reply.raw.write(
      `data: ${JSON.stringify({ type: 'landing:state', state: optimizer.state() })}\n\n`
    );
    request.raw.on('close', () => clients.delete(reply.raw));
  });

  app.get<{
    Params: { jobId: string; assetId: string; side: string };
    Querystring: { variant?: string };
  }>('/api/landing/jobs/:jobId/assets/:assetId/preview/:side', async (request, reply) => {
    const side = request.params.side;
    const variant = request.query.variant ?? 'full';
    if (side !== 'before' && side !== 'after') {
      return reply.code(400).send({ error: 'Invalid preview side.' });
    }
    if (variant !== 'full' && variant !== 'thumbnail') {
      return reply.code(400).send({ error: 'Invalid preview variant.' });
    }
    const content = await optimizer.previewContent(
      request.params.jobId,
      request.params.assetId,
      side,
      variant
    );
    if (!content) return reply.code(404).send({ error: 'Preview is unavailable.' });
    return reply
      .header('Cache-Control', 'private, no-store')
      .type(content.mimeType)
      .send(createReadStream(content.filePath));
  });

  app.post<{ Body: Partial<LandingSettings> }>('/api/landing/settings', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Invalid settings.' });
    }
    const patch: Partial<LandingSettings> = {};
    if (body.imageQuality !== undefined) {
      if (body.imageQuality !== 'optimal' && body.imageQuality !== 'high') {
        return reply.code(400).send({ error: 'Invalid image quality.' });
      }
      patch.imageQuality = body.imageQuality;
    }
    if (body.videoQuality !== undefined) {
      if (body.videoQuality !== 'optimal' && body.videoQuality !== 'high') {
        return reply.code(400).send({ error: 'Invalid video quality.' });
      }
      patch.videoQuality = body.videoQuality;
    }
    if (body.archive !== undefined) {
      if (typeof body.archive !== 'boolean') {
        return reply.code(400).send({ error: 'Invalid archive option.' });
      }
      patch.archive = body.archive;
    }
    optimizer.updateSettings(patch);
    return optimizer.state();
  });

  app.post('/api/landing/select/zip', async (_request, reply) => {
    if (process.platform !== 'darwin') {
      return reply.code(501).send({ error: 'The native picker is unavailable on this system.' });
    }
    try {
      const zipPaths = await selectLandingZips();
      for (const zipPath of zipPaths) await optimizer.prepareFromZipPath(zipPath);
      return optimizer.state();
    } catch (error) {
      return failPreparation(reply, optimizer, error);
    }
  });

  app.post('/api/landing/select/folder', async (_request, reply) => {
    if (process.platform !== 'darwin') {
      return reply.code(501).send({ error: 'The native picker is unavailable on this system.' });
    }
    try {
      const folderPaths = await selectLandingFolders();
      for (const folderPath of folderPaths) await optimizer.prepareFromFolderPath(folderPath);
      return optimizer.state();
    } catch (error) {
      return failPreparation(reply, optimizer, error);
    }
  });

  app.post('/api/landing/upload/zip', async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'No archive was provided.' });
    const fileName = path.basename(part.filename || 'landing.zip');
    if (!/\.zip$/i.test(fileName)) {
      part.file.resume();
      return reply.code(400).send({ error: 'Only ZIP archives are supported.' });
    }
    try {
      await optimizer.beginUpload('zip', fileName);
      const target = optimizer.zipStagingPath();
      await pipeline(part.file, createWriteStream(target));
      if (part.file.truncated) throw new Error('The archive is too large.');
      await optimizer.finishZipUpload(target);
      return optimizer.state();
    } catch (error) {
      return failPreparation(reply, optimizer, error);
    }
  });

  app.post<{ Body: { name?: unknown } }>('/api/landing/upload/folder/begin', async request => {
    const name = typeof request.body?.name === 'string' ? request.body.name : 'landing';
    await optimizer.beginUpload('folder', name);
    return optimizer.state();
  });

  app.post('/api/landing/upload/folder/file', async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'No file was provided.' });
    const relField = part.fields.relPath;
    const rawRel =
      relField && 'value' in relField && typeof relField.value === 'string'
        ? relField.value
        : part.filename;
    const safeRel = sanitizeRelPath(rawRel || '');
    if (!safeRel) {
      part.file.resume();
      return reply.code(400).send({ error: 'Invalid file path.' });
    }
    let inputDir: string;
    try {
      inputDir = optimizer.currentInputDir();
    } catch {
      part.file.resume();
      return reply.code(409).send({ error: 'No landing upload is in progress.' });
    }
    const target = path.join(inputDir, safeRel);
    if (!target.startsWith(inputDir + path.sep)) {
      part.file.resume();
      return reply.code(400).send({ error: 'Invalid file path.' });
    }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(part.file, createWriteStream(target));
      return { ok: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'The file could not be stored.' });
    }
  });

  app.post('/api/landing/upload/folder/finish', async (_request, reply) => {
    try {
      await optimizer.finishFolderUpload();
      return optimizer.state();
    } catch (error) {
      return failPreparation(reply, optimizer, error);
    }
  });

  app.post<{ Body?: { ids?: unknown } }>('/api/landing/start', async (request, reply) => {
    if (!acceptingNewTasks()) {
      return reply.code(409).send({ error: 'UPDATE_PENDING' });
    }
    const rawIds = request.body?.ids;
    if (
      rawIds !== undefined &&
      (!Array.isArray(rawIds) || rawIds.some(id => typeof id !== 'string'))
    ) {
      return reply.code(400).send({ error: 'Invalid landing ids.' });
    }
    const started = await optimizer.start(rawIds as string[] | undefined);
    return started
      ? optimizer.state()
      : reply.code(409).send({ error: 'No landing is ready to optimize.' });
  });

  app.post<{ Params: { jobId: string } }>(
    '/api/landing/jobs/:jobId/start',
    async (request, reply) => {
      if (!acceptingNewTasks()) {
        return reply.code(409).send({ error: 'UPDATE_PENDING' });
      }
      const started = await optimizer.start([request.params.jobId]);
      return started
        ? optimizer.state()
        : reply.code(409).send({ error: 'The landing is not ready to optimize.' });
    }
  );

  app.delete<{ Params: { jobId: string } }>('/api/landing/jobs/:jobId', async (request, reply) => {
    const removed = await optimizer.remove(request.params.jobId);
    return removed
      ? optimizer.state()
      : reply.code(409).send({ error: 'An active landing cannot be removed.' });
  });

  app.delete('/api/landing/completed', async () => {
    await optimizer.clearFinished();
    return optimizer.state();
  });

  app.post('/api/landing/reset', async () => {
    await optimizer.reset();
    return optimizer.state();
  });

  app.post('/api/landing/output/reveal', async (_request, reply) =>
    revealOutput(reply, optimizer, '-R')
  );
  app.post('/api/landing/output/open', async (_request, reply) =>
    revealOutput(reply, optimizer, null)
  );
  app.post<{ Params: { jobId: string } }>(
    '/api/landing/jobs/:jobId/output/reveal',
    async (request, reply) => revealOutput(reply, optimizer, '-R', request.params.jobId)
  );
  app.post<{ Params: { jobId: string } }>(
    '/api/landing/jobs/:jobId/output/open',
    async (request, reply) => revealOutput(reply, optimizer, null, request.params.jobId)
  );
}

async function failPreparation(reply: any, optimizer: LandingOptimizer, error: unknown) {
  await optimizer.abortUpload().catch(() => {});
  return reply
    .code(400)
    .send({ error: error instanceof Error ? error.message : 'The landing could not be prepared.' });
}

function revealOutput(reply: any, optimizer: LandingOptimizer, flag: '-R' | null, jobId?: string) {
  const output = jobId ? optimizer.outputPath(jobId) : optimizer.state().job?.outputPath;
  if (!output) return reply.code(404).send({ error: 'No result is available yet.' });
  const args = flag ? [flag, output] : [output];
  spawn('/usr/bin/open', args, { shell: false, detached: true, stdio: 'ignore' }).unref();
  return optimizer.state();
}
