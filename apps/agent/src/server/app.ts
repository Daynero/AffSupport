import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  AGENT_TOOL_CONTRACTS,
  CORE_CONTRACT_VERSION,
  AGENT_API_VERSION,
  AGENT_CAPABILITIES
} from '@video-compressor/shared';
import type { EntitlementGate } from '../entitlement/entitlement.js';
import type { JobQueue } from '../queue/queue.js';
import type { ToolContext, ToolModule } from './tools.js';

export interface ServerConfig {
  host: string;
  port: number;
  publicOrigin: string | null;
  devOrigin: string;
  version: string;
  buildNumber: string;
  buildId: string;
  channel: string;
  sourceRevision: string;
}

export interface ServerDeps {
  logger?: boolean;
  /** Per-boot session token; the web app obtains it through /pair. */
  token: string;
  /** Shared secret for the Finder/native bridge, or null when not launched natively. */
  nativeToken: string | null;
  allowedOrigins: ReadonlySet<string>;
  entitlementGate: EntitlementGate;
  config: ServerConfig;
  instanceId: string;
  startedAt: string;
  /** Live tool availability, refreshed by the entrypoint's health timer. */
  tools: { ffmpeg: boolean; ffprobe: boolean };
  /** The compressor queue also carries the agent-wide update/warning state. */
  queue: JobQueue;
  modules: ToolModule[];
  /** Directory with the built web bundle served as the local fallback UI. */
  webRoot: string;
}

// Account entitlement gates every tool route; health stays reachable so the
// web can read the entitlement state, and /api/entitlement accepts tokens.
const ENTITLEMENT_EXEMPT_ROUTES = new Set(['/api/health', '/api/diagnostics', '/api/entitlement']);

/**
 * Builds the fully wired Fastify instance from explicit dependencies — no
 * module-level state — so tests can assemble a real server around fake or
 * minimal deps and drive it with `app.inject()`.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { token, nativeToken, allowedOrigins, entitlementGate, config, tools, queue, modules } =
    deps;
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 16_384 });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-session-token']
  });
  await app.register(fastifyMultipart, {
    limits: { files: 1, fields: 4, fileSize: 100 * 1024 * 1024 * 1024 }
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (request.url.startsWith('/api/') && origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'Origin is not allowed.' });
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/health' || request.url === '/api/health') {
      reply.header('Cache-Control', 'no-store');
    }
    if (
      request.headers['access-control-request-private-network'] === 'true' &&
      request.headers.origin &&
      allowedOrigins.has(request.headers.origin)
    ) {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
    return payload;
  });
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/native/')) {
      const supplied = request.headers['x-wishly-native-token'];
      if (!nativeToken || typeof supplied !== 'string' || !tokensMatch(nativeToken, supplied)) {
        return reply.code(401).send({ error: 'Invalid native session token.' });
      }
      return;
    }
    if (!request.url.startsWith('/api/')) return;
    const supplied =
      request.headers['x-session-token'] ?? (request.query as { token?: string }).token;
    if (supplied !== token) return reply.code(401).send({ error: 'Invalid session token.' });
    const route = request.url.split('?')[0];
    if (
      !ENTITLEMENT_EXEMPT_ROUTES.has(route) &&
      entitlementGate.enforced &&
      !entitlementGate.status().entitled
    ) {
      return reply.code(403).send({ error: 'ENTITLEMENT_REQUIRED' });
    }
  });

  app.post('/api/entitlement', async (request, reply) => {
    const entitlementToken = (request.body as { token?: unknown } | null)?.token;
    if (typeof entitlementToken !== 'string') {
      return reply.code(400).send({ error: 'ENTITLEMENT_TOKEN_INVALID' });
    }
    try {
      return await entitlementGate.acceptToken(entitlementToken);
    } catch {
      return reply.code(403).send({ error: 'ENTITLEMENT_TOKEN_INVALID' });
    }
  });

  app.get('/api/health', async () => ({
    ok: tools.ffmpeg && tools.ffprobe,
    tools,
    version: config.version,
    buildNumber: config.buildNumber,
    buildId: config.buildId,
    apiVersion: AGENT_API_VERSION,
    channel: config.channel,
    sourceRevision: config.sourceRevision,
    capabilities: [...AGENT_CAPABILITIES],
    coreContractVersion: CORE_CONTRACT_VERSION,
    toolContracts: { ...AGENT_TOOL_CONTRACTS },
    update: queue.state().update,
    entitlement: entitlementGate.status()
  }));
  app.get('/health', async () => ({
    product: 'local-video-compressor-agent',
    ready: tools.ffmpeg && tools.ffprobe,
    version: config.version,
    buildNumber: config.buildNumber,
    buildId: config.buildId,
    apiVersion: AGENT_API_VERSION,
    channel: config.channel,
    sourceRevision: config.sourceRevision,
    capabilities: [...AGENT_CAPABILITIES],
    coreContractVersion: CORE_CONTRACT_VERSION,
    toolContracts: { ...AGENT_TOOL_CONTRACTS },
    update: queue.state().update,
    instanceId: deps.instanceId,
    startedAt: deps.startedAt,
    busy: modules.some(module => module.busy())
  }));
  app.get('/api/diagnostics', async () => ({
    version: config.version,
    buildNumber: config.buildNumber,
    buildId: config.buildId,
    apiVersion: AGENT_API_VERSION,
    channel: config.channel,
    sourceRevision: config.sourceRevision,
    instanceId: deps.instanceId,
    startedAt: deps.startedAt,
    system: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    ffmpeg: tools.ffmpeg && tools.ffprobe ? 'ready' : 'unavailable',
    lastError: queue.state().warning ?? null
  }));

  const toolContext: ToolContext = {
    allowedOrigins,
    acceptingNewTasks: () => queue.acceptingNewTasks()
  };
  for (const module of modules) module.register(app, toolContext);

  await app.register(fastifyStatic, {
    root: deps.webRoot,
    wildcard: false,
    setHeaders: (response, filePath) => {
      response.header(
        'Cache-Control',
        path.basename(filePath) === 'index.html'
          ? 'no-cache, no-store, must-revalidate'
          : 'public, max-age=31536000, immutable'
      );
    }
  });
  // Without PUBLIC_SITE_ORIGIN a source run must pair against the Vite dev
  // site: the bundled web/dist is a production build that refuses dev env.
  const pairOrigin =
    config.publicOrigin ??
    (config.sourceRevision === 'development'
      ? config.devOrigin
      : `http://${config.host}:${config.port}`);
  app.get('/pair', async (_request, reply) => {
    return reply.redirect(`${pairOrigin}/#agentToken=${token}`);
  });
  app.get('/local', async (_request, reply) => {
    return reply.redirect(`http://${config.host}:${config.port}/#agentToken=${token}`);
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'API action not found.' })
      : reply.sendFile('index.html')
  );

  return app;
}

function tokensMatch(expected: string, supplied: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
