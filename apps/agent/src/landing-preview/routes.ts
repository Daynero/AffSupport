import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { LandingPreviewEvent } from '@video-compressor/shared';
import { selectLandingPreviewFolder } from '../files/picker.js';
import { capabilities, openPath, revealInFileManager } from '../platform/platform.js';
import type { EventChannel } from '../server/sse.js';
import type { LandingPreviewCatalog } from './catalog.js';

interface LandingPreviewDeps {
  catalog: LandingPreviewCatalog;
  events: EventChannel<LandingPreviewEvent>;
  acceptingNewTasks: () => boolean;
}

export function registerLandingPreviewRoutes(
  app: FastifyInstance,
  { catalog, events, acceptingNewTasks }: LandingPreviewDeps
) {
  app.get('/api/landing-preview/state', async () => catalog.state());
  app.get('/api/landing-preview/events', events.handler);

  app.get<{ Params: { landingId: string } }>(
    '/api/landing-preview/landings/:landingId/image',
    async (request, reply) => {
      const preview = await catalog.previewPath(request.params.landingId);
      if (!preview) return reply.code(404).send({ error: 'Preview is unavailable.' });
      return reply
        .header('Cache-Control', 'private, no-store')
        .type('image/webp')
        .send(createReadStream(preview));
    }
  );

  app.post('/api/landing-preview/select', async (_request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    if (!capabilities().nativeFilePicker) {
      return reply.code(501).send({ error: 'The native folder picker is unavailable.' });
    }
    try {
      const selected = await selectLandingPreviewFolder();
      if (selected && !(await catalog.openRoot(selected))) {
        return reply.code(409).send({ error: 'Preview generation is already running.' });
      }
      return catalog.state();
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post<{ Body?: { paths?: unknown } }>('/api/landing-preview/open', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const paths = request.body?.paths;
    if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string') {
      return reply.code(400).send({ error: 'Provide exactly one local folder path.' });
    }
    try {
      if (!(await catalog.openRoot(paths[0]))) {
        return reply.code(409).send({ error: 'Preview generation is already running.' });
      }
      return catalog.state();
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post<{ Params: { catalogId: string } }>(
    '/api/landing-preview/catalogs/:catalogId/activate',
    async (request, reply) => {
      if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
      return (await catalog.activate(request.params.catalogId))
        ? catalog.state()
        : reply.code(409).send({ error: 'This catalogue cannot be opened right now.' });
    }
  );

  app.delete<{ Params: { catalogId: string } }>(
    '/api/landing-preview/catalogs/:catalogId',
    async (request, reply) =>
      (await catalog.removeCatalog(request.params.catalogId))
        ? catalog.state()
        : reply.code(409).send({ error: 'This catalogue cannot be removed right now.' })
  );

  app.post<{ Body?: { mode?: unknown; landingId?: unknown } }>(
    '/api/landing-preview/refresh',
    async (request, reply) => {
      if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
      const mode = request.body?.mode;
      const landingId = request.body?.landingId;
      if (!['changed', 'all', 'current'].includes(String(mode))) {
        return reply.code(400).send({ error: 'Invalid refresh mode.' });
      }
      if (landingId !== undefined && typeof landingId !== 'string') {
        return reply.code(400).send({ error: 'Invalid landing id.' });
      }
      if (mode === 'current' && typeof landingId !== 'string') {
        return reply.code(400).send({ error: 'The current landing id is required.' });
      }
      return catalog.refresh(mode as 'changed' | 'all' | 'current', landingId as string | undefined)
        ? catalog.state()
        : reply.code(409).send({ error: 'Preview generation is already running.' });
    }
  );

  app.post('/api/landing-preview/cancel', async (_request, reply) =>
    catalog.cancel()
      ? catalog.state()
      : reply.code(409).send({ error: 'No preview generation is running.' })
  );

  app.delete('/api/landing-preview/cache', async (_request, reply) =>
    (await catalog.clearActiveCache())
      ? catalog.state()
      : reply.code(409).send({ error: 'The cache cannot be cleared right now.' })
  );

  app.post<{ Params: { landingId: string } }>(
    '/api/landing-preview/landings/:landingId/reveal',
    async (request, reply) => {
      const source = catalog.sourceLocation(request.params.landingId);
      if (!source) return reply.code(404).send({ error: 'Landing source is unavailable.' });
      try {
        await access(source.path);
        if (source.kind === 'folder') openPath(source.path);
        else revealInFileManager(source.path);
        return catalog.state();
      } catch (error) {
        return failure(reply, error, 404);
      }
    }
  );

  app.post<{ Params: { landingId: string } }>(
    '/api/landing-preview/landings/:landingId/open-extracted',
    async (request, reply) => {
      const extracted = catalog.extractedPath(request.params.landingId);
      if (!extracted) return reply.code(404).send({ error: 'Extracted copy is unavailable.' });
      try {
        await access(extracted);
        openPath(extracted);
        return catalog.state();
      } catch (error) {
        return failure(reply, error, 404);
      }
    }
  );
}

function failure(reply: any, error: unknown, status = 400) {
  return reply
    .code(status)
    .send({ error: error instanceof Error ? error.message : 'Landing preview action failed.' });
}
