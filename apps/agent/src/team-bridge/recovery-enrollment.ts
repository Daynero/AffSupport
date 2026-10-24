import type { FastifyInstance } from 'fastify';
import { hasCapability } from '../server/capabilities.js';
import type { TeamRecoveryWorker } from './recovery-worker.js';

export function registerRecoveryRoutes(
  app: FastifyInstance,
  worker: TeamRecoveryWorker,
  accepting: () => boolean
) {
  app.post<{ Body?: unknown }>('/api/team/recovery/enroll', async (request, reply) => {
    if (!hasCapability('team-background-recovery'))
      return reply.code(501).send({ error: 'AGENT_REQUIRED' });
    if (!accepting()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    const body = request.body;
    if (!record(body) || typeof body.teamId !== 'string' || typeof body.endpoint !== 'string')
      return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return worker.begin(body.teamId, body.endpoint);
    } catch {
      return reply.code(409).send({ error: 'WRONG_STATE' });
    }
  });
  app.post<{ Body?: unknown }>('/api/team/recovery/confirm', async (request, reply) => {
    const body = request.body;
    if (
      !record(body) ||
      typeof body.enrollmentId !== 'string' ||
      typeof body.challengeId !== 'string'
    )
      return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await worker.enroll(body.enrollmentId, body.challengeId);
    } catch (error) {
      const code =
        error instanceof Error &&
        ['AGENT_UPDATE_REQUIRED', 'PERMISSION_DENIED', 'INVALID_RESPONSE'].includes(error.message)
          ? error.message
          : 'AUTH_REQUIRED';
      return reply.code(409).send({ error: code });
    }
  });
  app.post<{ Body?: unknown }>('/api/team/recovery/retry', async (request, reply) => {
    if (!hasCapability('team-background-recovery'))
      return reply.code(501).send({ error: 'AGENT_REQUIRED' });
    if (!accepting()) return reply.code(409).send({ error: 'UPDATE_PENDING' });
    if (!record(request.body) || typeof request.body.teamId !== 'string')
      return reply.code(400).send({ error: 'INVALID_INPUT' });
    try {
      return await worker.retry(request.body.teamId);
    } catch {
      return reply.code(409).send({ error: 'WRONG_STATE' });
    }
  });
  app.get<{ Params: { teamId: string } }>('/api/team/recovery/:teamId', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/iu.test(request.params.teamId))
      return reply.code(400).send({ error: 'INVALID_INPUT' });
    return worker.status(request.params.teamId);
  });
  app.delete<{ Params: { teamId: string } }>(
    '/api/team/recovery/:teamId',
    async (request, reply) => {
      if (!/^[0-9a-f-]{36}$/iu.test(request.params.teamId))
        return reply.code(400).send({ error: 'INVALID_INPUT' });
      return worker.remove(request.params.teamId);
    }
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
