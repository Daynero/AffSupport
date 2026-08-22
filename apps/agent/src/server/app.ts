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
  type AppEnvironment
} from '@video-compressor/shared';
import { advertisedCapabilities } from './capabilities.js';
import type { EntitlementGate } from '../entitlement/entitlement.js';
import type { JobQueue } from '../queue/queue.js';
import type { PowerGovernor } from '../power/governor.js';
import { registerPowerRoutes, type PowerSamplerHandle } from '../power/routes.js';
import type { ToolContext, ToolModule } from './tools.js';

export interface ServerConfig {
  /** Which environment this process belongs to; surfaced on the health snapshot. */
  environment: AppEnvironment;
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
  /**
   * Session token the web app obtains through /pair (or /local). It outlives
   * a restart, so an already-paired browser stays paired.
   */
  token: string;
  /** Shared secret for the Finder/native bridge, or null when not launched natively. */
  nativeToken: string | null;
  /**
   * Stable, per-user secret used only by a newer native launcher to ask an
   * older local Agent to drain work before an update handoff. It is separate
   * from the per-boot Finder token because the requesting launcher belongs to
   * a different app process.
   */
  updateHandoffToken: string | null;
  /** Starts the agent-wide update drain after the handoff secret is verified. */
  requestUpdateDrain: (targetBuildId: string) => void;
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
  /** The shared local-resource budget every tool spawns through. */
  power: PowerGovernor;
  /** Live consumption measurement; absent when the agent runs without it. */
  powerSampler?: PowerSamplerHandle;
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
  const {
    token,
    nativeToken,
    updateHandoffToken,
    allowedOrigins,
    entitlementGate,
    config,
    tools,
    queue,
    modules
  } = deps;
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 16_384 });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-session-token', 'x-wishly-update-token']
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
    if (request.url.startsWith('/api/team/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Content-Type-Options', 'nosniff');
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
    const route = request.url.split('?')[0];
    if (route === '/native/update/drain') {
      const supplied = request.headers['x-wishly-update-token'];
      if (
        !updateHandoffToken ||
        typeof supplied !== 'string' ||
        !tokensMatch(updateHandoffToken, supplied)
      ) {
        return reply.code(401).send({ error: 'Invalid update handoff token.' });
      }
      return;
    }
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

  app.post('/native/update/drain', async (request, reply) => {
    const targetBuildId = (request.body as { targetBuildId?: unknown } | null)?.targetBuildId;
    if (typeof targetBuildId !== 'string' || !/^[A-Za-z0-9._+-]{1,160}$/u.test(targetBuildId)) {
      return reply.code(400).send({ error: 'UPDATE_TARGET_INVALID' });
    }
    if (!isStrictlyNewerBuildId(targetBuildId, config.buildId)) {
      return reply.code(409).send({ error: 'UPDATE_TARGET_NOT_NEWER' });
    }
    deps.requestUpdateDrain(targetBuildId);
    return reply.code(202).send({ accepted: true });
  });

  app.get('/api/health', async () => ({
    ok: tools.ffmpeg && tools.ffprobe,
    tools,
    environment: config.environment,
    version: config.version,
    buildNumber: config.buildNumber,
    buildId: config.buildId,
    apiVersion: AGENT_API_VERSION,
    channel: config.channel,
    sourceRevision: config.sourceRevision,
    capabilities: advertisedCapabilities(),
    coreContractVersion: CORE_CONTRACT_VERSION,
    toolContracts: { ...AGENT_TOOL_CONTRACTS },
    update: queue.updateStatus(),
    entitlement: entitlementGate.status()
  }));
  app.get('/health', async () => ({
    product: 'local-video-compressor-agent',
    ready: tools.ffmpeg && tools.ffprobe,
    environment: config.environment,
    version: config.version,
    buildNumber: config.buildNumber,
    buildId: config.buildId,
    apiVersion: AGENT_API_VERSION,
    channel: config.channel,
    sourceRevision: config.sourceRevision,
    capabilities: advertisedCapabilities(),
    coreContractVersion: CORE_CONTRACT_VERSION,
    toolContracts: { ...AGENT_TOOL_CONTRACTS },
    update: queue.updateStatus(),
    instanceId: deps.instanceId,
    startedAt: deps.startedAt,
    busy: modules.some(module => module.busy())
  }));
  app.get('/api/diagnostics', async () => ({
    environment: config.environment,
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
    lastError: queue.warningMessage()
  }));

  // The power throttle is server-wide infrastructure, not a tool: it is passed
  // through ToolContext rather than added to the module list, so it never shows
  // up in the /health busy flag.
  registerPowerRoutes(app, {
    governor: deps.power,
    allowedOrigins,
    sampler: deps.powerSampler,
    onError: (error, message) => app.log.error(error, message)
  });

  const toolContext: ToolContext = {
    allowedOrigins,
    acceptingNewTasks: () => queue.acceptingNewTasks(),
    power: deps.power
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
  app.get('/local', async (request, reply) => {
    const path = localRedirectPath((request.query as { to?: unknown }).to);
    return reply.redirect(`http://${config.host}:${config.port}${path}#agentToken=${token}`);
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'API action not found.' })
      : reply.sendFile('index.html')
  );

  return app;
}

/**
 * Where `/local?to=…` is allowed to send the browser.
 *
 * The hosted site forwards the page the user was trying to open, so that a
 * browser which refuses to reach loopback costs one click rather than a click
 * and then a hunt through the menu for the tool they already asked for.
 *
 * The value arrives from a browser and is treated as hostile. Anything that is
 * not a single-slash path over a conservative character set collapses to the
 * home screen — losing the destination is a small cost, and the alternative is
 * a redirector. `//host` is the case worth naming: it reads as a path and
 * navigates to another site entirely.
 */
const LOCAL_REDIRECT_PATH = /^\/[A-Za-z0-9\-._~/]*(?:\?[A-Za-z0-9\-._~/=&%]*)?$/u;

function localRedirectPath(value: unknown) {
  if (typeof value !== 'string' || value.length > 512) return '/';
  if (value.startsWith('//') || !LOCAL_REDIRECT_PATH.test(value)) return '/';
  return value;
}

function tokensMatch(expected: string, supplied: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

interface BuildIdentity {
  version: number[];
  prerelease: string | null;
  build: number[];
}

function parseBuildIdentity(value: string): BuildIdentity | null {
  const matched = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\+(\d+(?:\.\d+)*)$/u.exec(value);
  if (!matched) return null;
  return {
    version: matched.slice(1, 4).map(Number),
    prerelease: matched[4] ?? null,
    build: matched[5].split('.').map(Number)
  };
}

function compareNumberComponents(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Only a newer installed build may ask this Agent to make way for it. */
function isStrictlyNewerBuildId(candidate: string, current: string) {
  const next = parseBuildIdentity(candidate);
  const active = parseBuildIdentity(current);
  if (!next || !active) return false;
  const version = compareNumberComponents(next.version, active.version);
  if (version !== 0) return version > 0;
  if (next.prerelease !== active.prerelease) {
    if (next.prerelease === null) return true;
    if (active.prerelease === null) return false;
    return next.prerelease.localeCompare(active.prerelease, 'en') > 0;
  }
  return compareNumberComponents(next.build, active.build) > 0;
}
