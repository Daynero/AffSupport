import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { hasCapability } from '../server/capabilities.js';
import { isImageConversionFormat, type ImageConversionFormat } from './image-converter.js';
import type { MediaActionQueue } from './queue.js';

export interface MediaActionsContext {
  mediaActions: MediaActionQueue;
  acceptingNewTasks: () => boolean;
}

/**
 * Native-bridge routes for Finder actions. They live under `/native/` and are
 * guarded by the x-wishly-native-token preHandler, not the browser session.
 */
export function registerMediaActionRoutes(app: FastifyInstance, ctx: MediaActionsContext): void {
  const { mediaActions, acceptingNewTasks } = ctx;

  app.post<{
    Body: { paths?: unknown; format?: unknown };
  }>('/native/media-actions/images/convert', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    if (!hasCapability('finder-image-conversion')) {
      return reply.code(501).send({ error: 'FINDER_IMAGE_CONVERSION_UNSUPPORTED' });
    }
    if (!acceptingNewTasks()) {
      return reply.code(409).send({ error: 'Soty is preparing to install an update.' });
    }
    const paths = request.body?.paths;
    const format = request.body?.format;
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.length > 100 ||
      !paths.every(
        value =>
          typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 4_096 &&
          !value.includes('\0') &&
          path.isAbsolute(value)
      ) ||
      !isImageConversionFormat(format)
    ) {
      return reply.code(400).send({ error: 'Invalid Finder image conversion request.' });
    }
    const uniquePaths = [...new Set(paths.map(value => path.resolve(value as string)))];
    const jobs = await mediaActions.addImageConversions(
      uniquePaths,
      format as ImageConversionFormat
    );
    return reply.code(202).send({
      accepted: jobs.length,
      jobs: jobs.map(job => ({ id: job.id, status: job.status }))
    });
  });

  /**
   * Stopping a Finder-initiated conversion from the browser.
   *
   * Under `/api/` rather than `/native/` on purpose: the person who wants to stop this is
   * looking at the interface, not at Finder. A conversion started from the file manager has
   * no window of its own, so before these routes existed the only way to stop a wedged one
   * was to quit the application (A3).
   */
  app.post<{ Params: { id: string } }>(
    '/api/media-actions/:id/cancel',
    async (request, reply) => {
      const cancelled = await mediaActions.cancel(request.params.id);
      return cancelled
        ? { state: mediaActions.state() }
        : reply.code(409).send({ error: 'TRANSITION_NOT_ALLOWED' });
    }
  );

  app.post('/api/media-actions/cancel-all', async () => ({
    // A count, not a boolean: "stopped nothing" and "stopped three" are different answers,
    // and the interface reports the second one to the user.
    stopped: await mediaActions.cancelAll(),
    state: mediaActions.state()
  }));

  app.get('/api/media-actions', async () => ({ state: mediaActions.state() }));

  app.get('/native/media-actions', async () => ({
    jobs: mediaActions.state().jobs.map(job => ({
      id: job.id,
      status: job.status,
      outputPath: job.status === 'completed' ? job.outputPath : null,
      errorCode: job.errorCode,
      error: job.error
    }))
  }));

  app.get<{ Params: { id: string } }>('/native/media-actions/:id', async (request, reply) => {
    const job = mediaActions.state().jobs.find(candidate => candidate.id === request.params.id);
    if (!job) return reply.code(404).send({ error: 'Media action not found.' });
    return {
      job: {
        id: job.id,
        status: job.status,
        outputPath: job.status === 'completed' ? job.outputPath : null,
        errorCode: job.errorCode,
        error: job.error
      }
    };
  });
}
