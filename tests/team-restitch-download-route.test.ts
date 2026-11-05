import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import {
  registerTeamBridgeRoutes,
  type TeamBridgeRoutesDeps
} from '../apps/agent/src/team-bridge/routes.js';

it('passes the space screens and their grants through the download HTTP route', async () => {
  const app = Fastify();
  const download = vi
    .fn()
    .mockResolvedValue({ saved: true, fileName: 'video_restitched.mp4', sizeBytes: 10 });
  registerTeamBridgeRoutes(app, {
    download: { download },
    events: { handler: vi.fn() },
    acceptingNewTasks: () => true
  } as unknown as TeamBridgeRoutesDeps);
  const grant = {
    ticket: 'opaque-download-range-ticket-with-enough-entropy',
    purpose: 'download_range',
    expiresAt: '2099-01-01T00:00:00.000Z',
    maxRangeBytes: 1024,
    maxUses: 10
  };
  const process = {
    tool: 'restitch',
    defaults: { sourceMode: 'drive', configured: true },
    teamId: 'team-1',
    screens: [
      {
        slot: 'start',
        materialId: 'image-1',
        transfer: { transferUrl: 'https://transfer.test/image', grant }
      }
    ]
  };
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/team/download',
      payload: {
        operationId: 'operation-1',
        transferUrl: 'https://transfer.test/video',
        transferGrant: grant,
        fileName: 'video.mp4',
        process
      }
    });
    expect(response.statusCode).toBe(200);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ process: expect.objectContaining(process) })
    );
  } finally {
    await app.close();
  }
});

it('authenticates retired process commands and returns the closed refusal before any worker', async () => {
  const app = Fastify();
  const process = vi.fn().mockRejectedValue(new Error('FEATURE_RETIRED'));
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer synthetic')
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
  registerTeamBridgeRoutes(app, {
    process: { process, resume: vi.fn() },
    library: { process },
    events: { handler: vi.fn() },
    acceptingNewTasks: () => true
  } as unknown as TeamBridgeRoutesDeps);
  try {
    for (const [url, payload] of [
      ['/api/team/process', { toolId: 'translation' }],
      ['/api/team/library/process', { kind: 'translation' }]
    ] as const) {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      const refused = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: 'Bearer synthetic' }
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'FEATURE_RETIRED' });
    }
    expect(process).not.toHaveBeenCalled();
    const grant = (purpose: string) => ({
      ticket: 'opaque-ticket-with-enough-entropy',
      purpose,
      expiresAt: '2099-01-01T00:00:00Z',
      maxRangeBytes: 1024,
      maxUses: 10
    });
    const upstream = await app.inject({
      method: 'POST',
      url: '/api/team/process',
      headers: { authorization: 'Bearer synthetic' },
      payload: {
        operationId: 'operation',
        toolId: 'transcription',
        transferUrl: 'https://transfer.test',
        cloudBaseUrl: 'https://cloud.test',
        sourceGrant: grant('process_input'),
        finalizeGrant: grant('finalize')
      }
    });
    expect(upstream.statusCode).toBe(409);
    expect(upstream.json()).toEqual({ error: 'FEATURE_RETIRED' });
    expect(process).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

it('returns versioned image refusals only through the authenticated, scoped read', async () => {
  const app = Fastify();
  const refused = vi
    .fn()
    .mockResolvedValue([{ slot: 'start', materialId: 'image-id', checksum: 'a'.repeat(32) }]);
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer synthetic')
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
  registerTeamBridgeRoutes(app, {
    screenCache: { refused },
    events: { handler: vi.fn() },
    acceptingNewTasks: () => true
  } as unknown as TeamBridgeRoutesDeps);
  const teamId = '30000000-0000-4000-8000-0000000000cc';
  const url = `/api/team/restitch/screen-refusals?teamId=${teamId}&scope=settings-1`;
  try {
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(refused).not.toHaveBeenCalled();
    const result = await app.inject({ url, headers: { authorization: 'Bearer synthetic' } });
    expect(result.statusCode).toBe(200);
    expect(result.json().refusals).toHaveLength(1);
    expect(refused).toHaveBeenCalledWith(teamId, 'settings-1');
    const invalid = await app.inject({
      url: '/api/team/restitch/screen-refusals?teamId=invalid&scope=settings-1',
      headers: { authorization: 'Bearer synthetic' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(refused).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
