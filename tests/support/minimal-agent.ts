import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { defaultImageEmbeddingSettings } from '../../packages/shared/src/types.js';
import { EntitlementGate } from '../../apps/agent/src/entitlement/entitlement.js';
import { ImageAssetStore } from '../../apps/agent/src/images/store.js';
import { PowerGovernor } from '../../apps/agent/src/power/governor.js';
import { JobQueue } from '../../apps/agent/src/queue/queue.js';
import { buildServer, type ServerConfig } from '../../apps/agent/src/server/app.js';
import {
  DiagnosticsLog,
  setActiveDiagnosticsLog
} from '../../apps/agent/src/server/diagnostics-log.js';
import { ChannelHub, EventChannel } from '../../apps/agent/src/server/sse.js';
import { optimalSettings } from '../helpers.js';
import { removeTemporaryDirectory } from './temp-dir.js';

/**
 * The real Fastify app with the fewest dependencies it will accept.
 *
 * `tests/agent-http.test.ts` assembles every tool module, which is right for the tests
 * that drive those tools. What the connection tests need is the *server* — its hooks, its
 * limiter, its stream route, its close — and for those the eight bridges and three queues
 * are two hundred lines of setup that say nothing. No tool modules are registered; the
 * stream carries one channel published here plus the power channel the server wires
 * itself.
 */

export const MINIMAL_AGENT_TOKEN = 'minimal-agent-session-token';

export interface MinimalAgent {
  app: FastifyInstance;
  hub: ChannelHub;
  /** The channel published on the hub as `compressor` and on its own `/api/events`-style handler. */
  channel: EventChannel<{ type: string }>;
  config: ServerConfig;
  allowedOrigins: Set<string>;
  token: string;
  /** The in-memory journal `/api/diagnostics` pages out; also installed process-wide. */
  diagnostics: DiagnosticsLog;
  /** `http://127.0.0.1:<port>` once listening; throws before. */
  readonly origin: string;
  /** Closes the app (idempotent) and removes the temporary directory. */
  stop(): Promise<void>;
}

export interface MinimalAgentOptions {
  config?: Partial<ServerConfig>;
  allowedOrigins?: Iterable<string>;
  /** Bind a real port on 127.0.0.1 rather than only serving `inject`. */
  listen?: boolean;
  /** Enforce entitlement against this key; absent means the gate is not enforced. */
  entitlementPublicKey?: string;
}

const DEFAULT_CONFIG: ServerConfig = {
  environment: 'production',
  host: '127.0.0.1',
  port: 43120,
  publicOrigin: 'https://soty.example',
  devOrigin: 'http://127.0.0.1:5173',
  version: '1.2.5',
  buildNumber: '200',
  buildId: '1.2.5+200',
  channel: 'test',
  sourceRevision: 'abcdef0'
};

export async function startMinimalAgent(options: MinimalAgentOptions = {}): Promise<MinimalAgent> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-minimal-agent-'));
  const webRoot = path.join(dir, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Soty test</title>');

  const config: ServerConfig = { ...DEFAULT_CONFIG, ...options.config };
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      config.devOrigin,
      ...(config.publicOrigin ? [config.publicOrigin] : []),
      `http://${config.host}:${config.port}`,
      `http://localhost:${config.port}`
    ]
  );
  const tools = { ffmpeg: true, ffprobe: true };
  const hub = new ChannelHub();
  const channel = new EventChannel<{ type: string }>(allowedOrigins, () => ({
    type: 'state'
  })).publishOn(hub, 'compressor');
  const queue = new JobQueue(
    tools,
    () => channel.broadcast({ type: 'state' }),
    [],
    { ...optimalSettings, imageEmbedding: defaultImageEmbeddingSettings() },
    null,
    new ImageAssetStore(path.join(dir, 'images'))
  );

  // In memory only: the route and the writers are what these tests drive, not the file.
  const diagnostics = new DiagnosticsLog();
  setActiveDiagnosticsLog(diagnostics);

  const app = await buildServer({
    logger: false,
    token: MINIMAL_AGENT_TOKEN,
    nativeToken: null,
    updateHandoffToken: null,
    requestUpdateDrain: () => undefined,
    allowedOrigins,
    entitlementGate: new EntitlementGate({
      publicKeyBase64: options.entitlementPublicKey ?? null,
      stateFile: path.join(dir, 'entitlement.json')
    }),
    config,
    instanceId: 'minimal-instance',
    startedAt: new Date().toISOString(),
    tools,
    queue,
    modules: [],
    channelHub: hub,
    power: new PowerGovernor({ pauseSupported: false }),
    webRoot,
    diagnostics
  });

  // Registered on an endpoint of its own as well, the way every tool's channel is, so a
  // test can hold a legacy per-tool stream open next to the multiplexed one.
  app.get('/api/events', channel.handler);

  let origin: string | null = null;
  if (options.listen) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  } else {
    await app.ready();
  }

  let stopped = false;
  return {
    app,
    hub,
    channel,
    config,
    allowedOrigins,
    token: MINIMAL_AGENT_TOKEN,
    diagnostics,
    get origin() {
      if (!origin) throw new Error('The minimal agent is not listening; pass { listen: true }.');
      return origin;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      hub.closeAll();
      channel.close();
      await app.close();
      setActiveDiagnosticsLog(null);
      await removeTemporaryDirectory(dir);
    }
  };
}
