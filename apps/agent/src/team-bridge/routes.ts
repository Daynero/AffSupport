import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  LIBRARY_JOB_KINDS,
  parseTeamTransferGrant,
  type TeamLandingRenderJob
} from '@video-compressor/shared';
import type { EventChannel } from '../server/sse.js';
import type { TeamAgentDownloadRequest, TeamDownloadBridge } from './download.js';
import type { TeamOperationEvent } from './events.js';
import { TeamLandingRenderError, type TeamLandingRenderBridge } from './landing-gallery.js';
import type { CreativeLibraryProcessBridge, CreativeLibraryProcessRequest } from './library.js';
import type { TeamPreviewBridge, TeamPreviewTransferRequest } from './preview.js';
import type { TeamProcessBridge, TeamProcessRequest } from './process.js';

export interface TeamBridgeRoutesDeps {
  preview: TeamPreviewBridge;
  process: TeamProcessBridge;
  download: TeamDownloadBridge;
  landings: TeamLandingRenderBridge;
  library: CreativeLibraryProcessBridge;
  events: EventChannel<TeamOperationEvent>;
  acceptingNewTasks: () => boolean;
}

export function registerTeamBridgeRoutes(
  app: FastifyInstance,
  { preview, process, download, landings, library, events, acceptingNewTasks }: TeamBridgeRoutesDeps
) {
  app.get('/api/team/events', events.handler);
  app.get('/api/team/landings/events', events.handler);

  app.post<{ Body?: unknown }>('/api/team/landings/render', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const input = landingRenderJob(request.body);
    if (!input) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await landings.render(input);
    } catch (error) {
      if (error instanceof TeamLandingRenderError) {
        return reply.code(409).send({ error: 'RENDER_FAILED', reason: error.reason });
      }
      return routeFailure(reply, error, 'RENDER_FAILED');
    }
  });

  app.post<{ Params: { operationId: string } }>(
    '/api/team/landings/render/:operationId/cancel',
    async (request, reply) => {
      const canceled = landings.cancel(request.params.operationId);
      if (!canceled) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { canceled: true };
    }
  );

  app.post<{ Body?: unknown }>('/api/team/download', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const input = downloadRequest(request.body);
    if (!input) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await download.download(input);
    } catch (error) {
      return routeFailure(reply, error, 'DOWNLOAD_FAILED');
    }
  });

  app.post<{ Params: { operationId: string } }>(
    '/api/team/download/:operationId/cancel',
    async (request, reply) => {
      const canceled = download.cancel(request.params.operationId);
      if (!canceled) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { canceled: true };
    }
  );

  app.post<{ Body?: unknown }>('/api/team/process', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const input = processRequest(request.body);
    if (!input) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await process.process(input);
    } catch (error) {
      return routeFailure(reply, error, 'PROCESS_FAILED');
    }
  });

  app.post<{ Body?: unknown }>('/api/team/library/process', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const input = libraryProcessRequest(request.body);
    if (!input) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await library.process(input);
    } catch (error) {
      return routeFailure(reply, error, 'PROCESS_FAILED');
    }
  });

  app.post<{ Params: { attemptId: string } }>(
    '/api/team/library/process/:attemptId/cancel',
    async (request, reply) => {
      const canceled = library.cancel(request.params.attemptId);
      if (!canceled) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { canceled: true };
    }
  );

  app.post<{ Params: { operationId: string } }>(
    '/api/team/process/:operationId/cancel',
    async (request, reply) => {
      const canceled = process.cancel(request.params.operationId);
      if (!canceled) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { canceled: true };
    }
  );

  app.post<{ Body?: unknown }>('/api/team/preview/archive', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const input = previewRequest(request.body);
    if (!input) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await preview.previewArchive(input);
    } catch (error) {
      return routeFailure(reply, error, 'PREVIEW_FAILED');
    }
  });

  app.post<{ Body?: unknown }>('/api/team/preview/landing', async (request, reply) => {
    if (!acceptingNewTasks()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const input = previewRequest(request.body);
    if (!input) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await preview.previewLanding(input);
    } catch (error) {
      return routeFailure(reply, error, 'PREVIEW_FAILED');
    }
  });

  app.get<{ Params: { operationId: string }; Querystring: { segment?: string } }>(
    '/api/team/preview/:operationId/screenshot',
    async (request, reply) => {
      const segment = request.query.segment === undefined ? 0 : Number(request.query.segment);
      if (!Number.isInteger(segment) || segment < 0 || segment > 100) {
        return reply.code(400).send({ error: 'INVALID_INPUT' });
      }
      const screenshot = preview.screenshotPath(request.params.operationId, segment);
      if (!screenshot) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .type('image/webp')
        .send(createReadStream(screenshot));
    }
  );

  app.delete<{ Params: { operationId: string } }>(
    '/api/team/preview/:operationId',
    async (request, _reply) => ({
      closed: await preview.close(request.params.operationId)
    })
  );

  app.post<{ Params: { operationId: string } }>(
    '/api/team/preview/:operationId/cancel',
    async (request, _reply) => ({
      closed: await preview.close(request.params.operationId)
    })
  );
}

function previewRequest(value: unknown): TeamPreviewTransferRequest | null {
  if (!record(value)) return null;
  const grant = parseTeamTransferGrant(value.transferGrant);
  if (typeof value.operationId !== 'string' || typeof value.transferUrl !== 'string' || !grant) {
    return null;
  }
  if (grant.purpose !== 'preview_range') return null;
  return {
    operationId: value.operationId,
    transferUrl: value.transferUrl,
    transferGrant: grant
  };
}

function landingRenderJob(value: unknown): TeamLandingRenderJob | null {
  if (!record(value)) return null;
  const sourceGrant = parseTeamTransferGrant(value.sourceGrant);
  const artifactGrant = parseTeamTransferGrant(value.artifactGrant);
  const strings = [
    value.operationId,
    value.renderId,
    value.teamId,
    value.materialId,
    value.preset,
    value.transferUrl,
    value.artifactUploadUrl
  ];
  if (
    strings.some(entry => typeof entry !== 'string') ||
    sourceGrant?.purpose !== 'preview_range' ||
    artifactGrant?.purpose !== 'preview_range'
  ) {
    return null;
  }
  return {
    operationId: value.operationId as string,
    renderId: value.renderId as string,
    teamId: value.teamId as string,
    materialId: value.materialId as string,
    preset: value.preset as string,
    transferUrl: value.transferUrl as string,
    artifactUploadUrl: value.artifactUploadUrl as string,
    sourceGrant,
    artifactGrant
  };
}

function processRequest(value: unknown): TeamProcessRequest | null {
  if (!record(value)) return null;
  const sourceGrant = parseTeamTransferGrant(value.sourceGrant);
  const finalizeGrant = parseTeamTransferGrant(value.finalizeGrant);
  if (
    typeof value.operationId !== 'string' ||
    typeof value.toolId !== 'string' ||
    typeof value.transferUrl !== 'string' ||
    typeof value.cloudBaseUrl !== 'string' ||
    !sourceGrant ||
    sourceGrant.purpose !== 'process_input' ||
    !finalizeGrant ||
    finalizeGrant.purpose !== 'finalize'
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    toolId: value.toolId,
    options: value.options ?? {},
    transferUrl: value.transferUrl,
    cloudBaseUrl: value.cloudBaseUrl,
    sourceGrant,
    finalizeGrant
  };
}

function libraryProcessRequest(value: unknown): CreativeLibraryProcessRequest | null {
  if (!record(value)) return null;
  const sourceGrant = parseTeamTransferGrant(value.sourceGrant);
  const finalizeGrant = parseTeamTransferGrant(value.finalizeGrant);
  const requiredStrings = [
    value.operationId,
    value.teamId,
    value.requirementId,
    value.attemptId,
    value.agentInstanceId,
    value.variant,
    value.sourceVersion,
    value.leaseToken,
    value.transferUrl,
    value.cloudBaseUrl
  ];
  if (
    requiredStrings.some(entry => typeof entry !== 'string') ||
    typeof value.kind !== 'string' ||
    !(LIBRARY_JOB_KINDS as readonly string[]).includes(value.kind) ||
    (value.leaseToken as string).length < 24 ||
    sourceGrant?.purpose !== 'process_input' ||
    finalizeGrant?.purpose !== 'finalize'
  ) {
    return null;
  }
  return {
    operationId: value.operationId as string,
    teamId: value.teamId as string,
    requirementId: value.requirementId as string,
    attemptId: value.attemptId as string,
    agentInstanceId: value.agentInstanceId as string,
    kind: value.kind as CreativeLibraryProcessRequest['kind'],
    variant: value.variant as string,
    sourceVersion: value.sourceVersion as string,
    leaseToken: value.leaseToken as string,
    transferUrl: value.transferUrl as string,
    cloudBaseUrl: value.cloudBaseUrl as string,
    sourceGrant,
    finalizeGrant,
    options: value.options ?? {}
  };
}

function downloadRequest(value: unknown): TeamAgentDownloadRequest | null {
  if (!record(value)) return null;
  const transferGrant = parseTeamTransferGrant(value.transferGrant);
  if (
    typeof value.operationId !== 'string' ||
    typeof value.transferUrl !== 'string' ||
    typeof value.fileName !== 'string' ||
    transferGrant?.purpose !== 'download_range'
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    transferUrl: value.transferUrl,
    transferGrant,
    fileName: value.fileName
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function routeFailure(
  reply: FastifyReply,
  error: unknown,
  fallback: 'PREVIEW_FAILED' | 'PROCESS_FAILED' | 'DOWNLOAD_FAILED' | 'RENDER_FAILED'
) {
  const code = safeErrorCode(error, fallback);
  const status =
    code === 'PERMISSION_DENIED'
      ? 403
      : code === 'TOO_LARGE'
        ? 413
        : code === 'WRONG_STATE' ||
            code === 'UPDATE_PENDING' ||
            code === 'AGENT_UPDATE_REQUIRED' ||
            code === 'RENDER_FAILED' ||
            code === 'SOURCE_CHANGED'
          ? 409
          : code === 'PREVIEW_CANCELED' ||
              code === 'PROCESS_CANCELED' ||
              code === 'DOWNLOAD_CANCELED'
            ? 499
            : code === 'PROCESS_TIMEOUT'
              ? 504
              : code === 'DRIVE_UNAVAILABLE'
                ? 503
                : 400;
  return reply.code(status).send({ error: code });
}

function safeErrorCode(
  error: unknown,
  fallback: 'PREVIEW_FAILED' | 'PROCESS_FAILED' | 'DOWNLOAD_FAILED' | 'RENDER_FAILED'
) {
  const value = error instanceof Error ? error.message : '';
  return [
    'INVALID_INPUT',
    'PERMISSION_DENIED',
    'TOO_LARGE',
    'WRONG_STATE',
    'PREVIEW_CANCELED',
    'PROCESS_CANCELED',
    'DOWNLOAD_CANCELED',
    'DOWNLOAD_FAILED',
    'RENDER_FAILED',
    'PROCESS_TIMEOUT',
    'PROCESS_FAILED',
    'AGENT_UPDATE_REQUIRED',
    'UNSUPPORTED_MEDIA',
    'DRIVE_UNAVAILABLE',
    'SOURCE_CHANGED',
    'INVALID_RESPONSE',
    'NOT_FOUND'
  ].includes(value)
    ? value
    : fallback;
}
