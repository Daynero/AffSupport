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
import { registerStreamRoutes } from './stream.js';
import type { ChannelHub } from './sse.js';
import type { EntitlementGate } from '../entitlement/entitlement.js';
import type { JobQueue } from '../queue/queue.js';
import type { PowerGovernor } from '../power/governor.js';
import { registerPowerRoutes, type PowerSamplerHandle } from '../power/routes.js';
import type { ToolContext, ToolModule } from './tools.js';
import { DEFAULT_UPLOAD_BYTES } from './upload-limits.js';
import { TICKET_TTL_MS, issueTicket, ticketAuthorises } from './tickets.js';

/**
 * The only paths a ticket may be minted for.
 *
 * Every one of these is fetched by the browser's own loader — an <img>, a
 * <video>, a background request for a preview frame — which is the entire
 * reason a credential has to travel in the URL at all. Nothing that changes
 * state is here, and nothing that returns a list of what exists.
 */
const TICKETABLE_PREFIXES = [
  '/api/images/',
  '/api/transcription/jobs/',
  '/api/landing-preview/'
] as const;

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
  /**
   * The multiplexed live-update fan-out, when one is wired.
   *
   * Optional so a bare test assembly can omit it: the seven per-tool endpoints still work
   * on their own, which is the same fallback a client that has not been updated relies on.
   */
  channelHub?: ChannelHub;
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

/**
 * A small fixed-window counter, per key.
 *
 * Not a token bucket and not a library: what is being bounded is a loopback
 * server only this user's browser can reach, so the job is to turn a runaway
 * loop or a hostile page's script into a refusal rather than a warm laptop —
 * not to survive a distributed attack. A fixed window is the cheapest shape
 * that does that and the easiest to reason about when it fires.
 */
class FixedWindowBudget {
  #hits = new Map<string, { since: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** True when this call is within budget; false when it should be refused. */
  take(key: string): boolean {
    const at = this.now();
    const entry = this.#hits.get(key);
    if (!entry || at - entry.since >= this.windowMs) {
      this.#hits.set(key, { since: at, count: 1 });
      // Swept here rather than on a timer: a timer would keep the process alive
      // for bookkeeping, and this map only grows while requests are arriving.
      if (this.#hits.size > 512) {
        for (const [candidate, value] of this.#hits) {
          if (at - value.since >= this.windowMs) this.#hits.delete(candidate);
        }
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Forgets a key, so a success can clear a failure streak. */
  clear(key: string): void {
    this.#hits.delete(key);
  }
}

/**
 * Per-route budget. Generous, because the honest client is a page that can
 * legitimately be busy and the dishonest one is a loop.
 */
const ROUTE_BUDGET_LIMIT = 600;
const ROUTE_BUDGET_WINDOW_MS = 60_000;

/**
 * The cooldown after repeated authentication failures.
 *
 * A wrong token is ordinary — the local app restarted and minted a new one — so
 * a handful of attempts stays free. Twenty in a minute is not a stale token; it
 * is something enumerating, and the answer is to stop answering.
 */
const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 60_000;

/**
 * The logger configuration, exported so a test can assert on the real one.
 *
 * A log is what a user attaches to a bug report or pastes into a support
 * thread — deliberately, and without reading every line first — so anything in
 * it is effectively published. Two rules follow: the request URL is never
 * recorded (it carries ids, filenames, and now capability tickets in its
 * query), and the headers that are credentials are removed rather than starred.
 *
 * The route *pattern* goes in instead, which cannot carry any of that and is
 * more useful for diagnostics than a raw URL anyway.
 */
export const SAFE_LOGGER = {
  serializers: {
    req(request: { method: string; routeOptions?: { url?: string }; url: string }) {
      return {
        method: request.method,
        // Never `request.url`: it carries the query string and every id.
        route: request.routeOptions?.url ?? '(unrouted)'
      };
    }
  },
  redact: {
    paths: [
      'req.headers["x-session-token"]',
      'req.headers["x-wishly-native-token"]',
      'req.headers["x-wishly-update-token"]',
      'req.headers.authorization',
      'req.headers.cookie',
      // The one response header that is itself a credential: /pair redirects
      // with the session token in the fragment.
      'res.headers.location'
    ],
    remove: true
  }
};

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
  const app = Fastify({
    // The default logger prints `req.url`, which carries `?token=<64 hex>` on roughly a
    // dozen client call sites, plus path-shaped identifiers. Emitting the *route pattern*
    // instead removes both in one change, and a pattern is more useful for diagnostics
    // than a raw URL anyway. Redaction covers the headers and — the one that matters for
    // /pair — the redirect Location, which carries the session token.
    logger: deps.logger === undefined || deps.logger === true ? SAFE_LOGGER : deps.logger,
    bodyLimit: 16_384
  });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-session-token', 'x-wishly-update-token']
  });
  await app.register(fastifyMultipart, {
    // A restrictive default on purpose. This value applies to any route that does not
    // state its own limit, so forgetting to specify is safe rather than unbounded. Routes
    // handling real media opt in explicitly — see MAX_MEDIA_UPLOAD_BYTES and friends.
    limits: { files: 1, fields: 4, fileSize: DEFAULT_UPLOAD_BYTES }
  });

  const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

  /**
   * True when the Host header names this machine's loopback interface.
   *
   * The hostname is the security property; the port is not. A page rebound from
   * evil.example to 127.0.0.1 still sends `Host: evil.example`, so the hostname check
   * catches it whatever port it targets. Pinning the port as well would add nothing and
   * would break every caller that reaches the agent on a port this process did not read
   * from configuration — an ephemeral port in tests, or a launcher that picked one.
   */
  function isLoopbackHost(value: string): boolean {
    // Duplicate Host headers arrive joined by Node as "a, b" and are always hostile.
    if (value.includes(',')) return false;
    const bracketed = value.startsWith('[');
    const hostname = bracketed
      ? value.slice(0, value.indexOf(']') + 1)
      : (value.split(':')[0] ?? '');
    return LOOPBACK_HOSTNAMES.has(hostname);
  }

  app.addHook('onRequest', async (request, reply) => {
    // Host first, and on every path — not just /api/*.
    //
    // This is the DNS-rebinding guard, and the prize it protects is not /health leaking a
    // build id. It is /pair, which hands the session token to anyone who follows its
    // redirect: a page rebound to 127.0.0.1 that follows it and reads its own fragment is
    // fully paired. The origin check below cannot stop that, because after rebinding the
    // request is same-origin and carries no Origin header at all.
    //
    // Running in `onRequest` matters: it is before body parsing, so a rejected request
    // never causes a byte of a multipart upload to be read.
    const host = request.headers.host;
    if (typeof host !== 'string' || !isLoopbackHost(host)) {
      return reply.code(403).send({ error: 'HOST_NOT_ALLOWED' });
    }

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
  const routeBudget = new FixedWindowBudget(ROUTE_BUDGET_LIMIT, ROUTE_BUDGET_WINDOW_MS);
  const authFailures = new FixedWindowBudget(AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS);
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
    // `!==` here was both timing-unsafe and type-unsafe. Fastify parses a repeated
    // `?token=a&token=b` into an array, which reached the raw comparison as a non-string;
    // the guard rejects that before it can be compared. /native/* twelve lines above has
    // always used tokensMatch — this brings the browser token to the same standard.
    // A capability ticket authorises exactly this method and this path, and
    // nothing else. It exists so a subresource the browser's own loader fetches
    // — an image, a preview frame, a media stream — can be named in a URL
    // without the session token being in that URL, where it would reach
    // referrers, access logs and proxy caches (C4).
    const ticket = (request.query as { ticket?: unknown }).ticket;
    if (ticket !== undefined && ticketAuthorises(token, request.method, route, ticket)) {
      return;
    }

    // Refused before the token is looked at: something that has failed twenty
    // times in a minute is not a stale token, and answering it at all is what
    // makes the attempt worth repeating.
    const caller = request.ip || 'local';
    if (!authFailures.take(`${caller}:probe`)) {
      return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' });
    }
    if (!routeBudget.take(`${caller}:${route}`)) {
      return reply.code(429).send({ error: 'RATE_LIMITED' });
    }
    const supplied =
      request.headers['x-session-token'] ?? (request.query as { token?: unknown }).token;
    if (typeof supplied !== 'string' || !tokensMatch(token, supplied)) {
      authFailures.take(`${caller}:probe`);
      return reply.code(401).send({ error: 'Invalid session token.' });
    }
    // A success clears the streak. The ordinary cause of a failure here is a
    // restarted local app, and the tab that re-pairs must not spend the rest of
    // the minute in a cooldown it earned before it had the new token.
    authFailures.clear(`${caller}:probe`);
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
    lastError: queue.warningMessage(),
    // Enough to answer "the button says busy and the panel says nothing is
    // happening" without reading the source. Counts and ids only — no file
    // names, no paths — because this page is meant to be sent to us.
    queue: queue.liveness()
  }));

  // The power throttle is server-wide infrastructure, not a tool: it is passed
  // through ToolContext rather than added to the module list, so it never shows
  // up in the /health busy flag.
  registerPowerRoutes(app, {
    governor: deps.power,
    allowedOrigins,
    sampler: deps.powerSampler,
    channelHub: deps.channelHub,
    onError: (error, message) => app.log.error(error, message)
  });

  const toolContext: ToolContext = {
    allowedOrigins,
    acceptingNewTasks: () => queue.acceptingNewTasks(),
    power: deps.power
  };
  for (const module of modules) module.register(app, toolContext);
  if (deps.channelHub) registerStreamRoutes(app, { hub: deps.channelHub, allowedOrigins });

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
  /**
   * The in-page pairing handshake: a document that hands the token to the page
   * that framed it, and to nothing else.
   *
   * Re-pairing used to be a full-page navigation. It works, and it throws away
   * everything the user had on screen — an editable transcript, a half-filled
   * form, an open dialog — to deliver a string. This serves a minimal document
   * inside a hidden frame instead, which posts the token and closes.
   *
   * **The target origin is chosen here, by the server.** Never `*`, and never
   * the requesting origin: both would let any page that can frame this one
   * collect a live session token. The value is the same origin the pairing
   * redirect already trusts, so the handshake grants nothing the existing flow
   * did not. A nonce is echoed back so the receiving page can tell its own
   * handshake from a message someone else sent it.
   */
  /**
   * Mints a ticket for one subresource the caller has already been authorised
   * to see.
   *
   * Reached with the session token like any other API call — this is not a way
   * to get access, it is a way to carry access somewhere a header cannot go.
   * The prefix allowlist is what keeps it that: a ticket may only be asked for
   * on the paths whose whole purpose is to be loaded by the browser as a
   * subresource. Without it this route would mint a five-minute bearer token
   * for any endpoint at all, which is the problem it exists to solve, moved.
   */
  app.post<{ Body: { path?: unknown; method?: unknown } }>(
    '/api/tickets',
    async (request, reply) => {
      const wanted = request.body?.path;
      const method = typeof request.body?.method === 'string' ? request.body.method : 'GET';
      if (typeof wanted !== 'string' || !wanted.startsWith('/api/') || wanted.includes('?')) {
        return reply.code(400).send({ error: 'INVALID_INPUT' });
      }
      if (!TICKETABLE_PREFIXES.some(prefix => wanted.startsWith(prefix))) {
        return reply.code(403).send({ error: 'PATH_NOT_TICKETABLE' });
      }
      if (method !== 'GET' && method !== 'HEAD') {
        // A ticket travels in a URL, and a URL is copied, linked and logged.
        // Anything that changes state stays behind the header.
        return reply.code(403).send({ error: 'METHOD_NOT_TICKETABLE' });
      }
      return { ticket: issueTicket(token, method, wanted), expiresInMs: TICKET_TTL_MS };
    }
  );
  app.get('/pair/handshake', async (request, reply) => {
    const nonce = handshakeNonce((request.query as { nonce?: unknown }).nonce);
    if (!nonce) return reply.code(400).send({ error: 'A handshake nonce is required.' });
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    // No framing by anyone but the origin the token is being posted to.
    reply.header('Content-Security-Policy', `frame-ancestors ${pairOrigin}`);
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    return reply.send(
      '<!doctype html><meta charset="utf-8"><title>Pairing</title><script>' +
        `window.parent.postMessage({type:"soty:pairing",nonce:${JSON.stringify(nonce)},` +
        `token:${JSON.stringify(token)}},${JSON.stringify(pairOrigin)});` +
        '</script>'
    );
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

/**
 * The nonce, echoed back into a script literal — so it is validated, not trusted.
 *
 * It arrives from a browser and is written into a document this server serves.
 * A conservative character set and a length bound are what keep it a nonce
 * rather than an injection point; `JSON.stringify` at the call site is the
 * second layer, not the first.
 */
function handshakeNonce(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9_-]{8,128}$/u.test(value) ? value : null;
}

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
