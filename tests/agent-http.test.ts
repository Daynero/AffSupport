import { generateKeyPairSync, sign as signData } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultImageEmbeddingSettings,
  type AgentEvent,
  type LandingEvent,
  type TranscriptionEvent
} from '../packages/shared/src/types.js';
import { EntitlementGate } from '../apps/agent/src/entitlement/entitlement.js';
import { EstimationWorker } from '../apps/agent/src/estimate/worker.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';
import { MediaActionQueue } from '../apps/agent/src/media-actions/queue.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { buildServer } from '../apps/agent/src/server/app.js';
import { EventChannel } from '../apps/agent/src/server/sse.js';
import { createToolModules } from '../apps/agent/src/server/tools.js';
import { optimalSettings } from './helpers.js';

const TOKEN = 'test-session-token';
const NATIVE_TOKEN = 'test-native-token';
const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';

interface ServerHandle {
  app: FastifyInstance;
  dir: string;
}

const handles: ServerHandle[] = [];

afterEach(async () => {
  while (handles.length) {
    const handle = handles.pop()!;
    await handle.app.close();
    await rm(handle.dir, { recursive: true, force: true });
  }
});

async function makeServer(options: { entitlementPublicKey?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-agent-http-'));
  const webRoot = path.join(dir, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Wishly test</title>');

  const allowedOrigins = new Set([ALLOWED_ORIGIN]);
  const tools = { ffmpeg: true, ffprobe: true };
  const imageStore = new ImageAssetStore(path.join(dir, 'images'));
  const agentEvents = new EventChannel<AgentEvent>(allowedOrigins, () => ({
    type: 'state',
    state: queue.state()
  }));
  const queue: JobQueue = new JobQueue(
    tools,
    type => agentEvents.broadcast({ type: type ?? 'state', state: queue.state() }),
    [],
    { ...optimalSettings, imageEmbedding: defaultImageEmbeddingSettings() },
    null,
    imageStore
  );
  const estimator = new EstimationWorker(
    () => queue.estimationJobs(),
    (id, patch, event) => queue.updateEstimate(id, patch, event),
    () => queue.compressionActive(),
    undefined,
    imageStore
  );
  const landingEvents = new EventChannel<LandingEvent>(allowedOrigins, () => ({
    type: 'landing:state',
    state: landingOptimizer.state()
  }));
  const landingOptimizer = new LandingOptimizer(tools, () =>
    landingEvents.broadcast({ type: 'landing:state', state: landingOptimizer.state() })
  );
  const transcriptionEvents = new EventChannel<TranscriptionEvent>(allowedOrigins, () => ({
    type: 'transcription:state',
    state: transcriptionQueue.state()
  }));
  const transcriptionQueue = new TranscriptionQueue({ ffmpeg: true, whisper: false }, () =>
    transcriptionEvents.broadcast({
      type: 'transcription:state',
      state: transcriptionQueue.state()
    })
  );
  const mediaActions = new MediaActionQueue();
  const entitlementGate = new EntitlementGate({
    publicKeyBase64: options.entitlementPublicKey ?? null,
    stateFile: path.join(dir, 'entitlement.json')
  });

  const app = await buildServer({
    logger: false,
    token: TOKEN,
    nativeToken: NATIVE_TOKEN,
    allowedOrigins,
    entitlementGate,
    config: {
      host: '127.0.0.1',
      port: 43120,
      publicOrigin: null,
      devOrigin: ALLOWED_ORIGIN,
      version: '0.0.0-test',
      buildNumber: '0',
      buildId: 'test-build',
      channel: 'test',
      sourceRevision: 'development'
    },
    instanceId: 'test-instance',
    startedAt: new Date().toISOString(),
    tools,
    queue,
    modules: createToolModules({
      compressor: { queue, estimator, imageStore, events: agentEvents, tools },
      mediaActions,
      landing: { optimizer: landingOptimizer, events: landingEvents },
      transcription: { queue: transcriptionQueue, events: transcriptionEvents }
    }),
    webRoot
  });
  await app.ready();
  handles.push({ app, dir });
  return app;
}

function entitlementKit() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const issue = (payload: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = signData('sha256', Buffer.from(`wat1.${body}`, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    }).toString('base64url');
    return `wat1.${body}.${signature}`;
  };
  return { publicKeyBase64, issue };
}

describe('agent HTTP surface', () => {
  it('rejects /api requests without a valid session token, via header or query', async () => {
    const app = await makeServer();

    const missing = await app.inject({ url: '/api/queue' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: 'Invalid session token.' });

    const wrong = await app.inject({
      url: '/api/queue',
      headers: { 'x-session-token': 'not-the-token' }
    });
    expect(wrong.statusCode).toBe(401);

    const viaHeader = await app.inject({
      url: '/api/queue',
      headers: { 'x-session-token': TOKEN }
    });
    expect(viaHeader.statusCode).toBe(200);
    expect(Array.isArray(viaHeader.json().jobs)).toBe(true);

    const viaQuery = await app.inject({ url: `/api/queue?token=${TOKEN}` });
    expect(viaQuery.statusCode).toBe(200);
  });

  it('refuses /api requests from a foreign origin even with a valid token', async () => {
    const app = await makeServer();

    const foreign = await app.inject({
      url: '/api/queue',
      headers: { 'x-session-token': TOKEN, origin: 'https://evil.example' }
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ error: 'Origin is not allowed.' });

    const allowed = await app.inject({
      url: '/api/queue',
      headers: { 'x-session-token': TOKEN, origin: ALLOWED_ORIGIN }
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('reports an unenforced entitlement in development runs', async () => {
    const app = await makeServer();
    const health = await app.inject({
      url: '/api/health',
      headers: { 'x-session-token': TOKEN }
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().entitlement).toMatchObject({ enforced: false, entitled: true });
  });

  it('gates tool routes behind a signed entitlement token when enforced', async () => {
    const kit = entitlementKit();
    const app = await makeServer({ entitlementPublicKey: kit.publicKeyBase64 });

    const blocked = await app.inject({
      url: '/api/queue',
      headers: { 'x-session-token': TOKEN }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: 'ENTITLEMENT_REQUIRED' });

    // Health stays reachable so the web app can read the entitlement state.
    const health = await app.inject({
      url: '/api/health',
      headers: { 'x-session-token': TOKEN }
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().entitlement).toMatchObject({ enforced: true, entitled: false });

    const garbage = await app.inject({
      method: 'POST',
      url: '/api/entitlement',
      headers: { 'x-session-token': TOKEN },
      payload: { token: 'wat1.bm90LWEtcGF5bG9hZA.bm90LWEtc2lnbmF0dXJl' }
    });
    expect(garbage.statusCode).toBe(403);
    expect(garbage.json()).toEqual({ error: 'ENTITLEMENT_TOKEN_INVALID' });

    const now = Math.floor(Date.now() / 1000);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/entitlement',
      headers: { 'x-session-token': TOKEN },
      payload: {
        token: kit.issue({ v: 1, sub: 'user-1', plan: 'pro', iat: now - 10, exp: now + 3600 })
      }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ enforced: true, entitled: true, reason: 'active' });

    const unlocked = await app.inject({
      url: '/api/queue',
      headers: { 'x-session-token': TOKEN }
    });
    expect(unlocked.statusCode).toBe(200);
  });

  it('requires the native bridge token on /native routes', async () => {
    const app = await makeServer();

    const missing = await app.inject({ url: '/native/media-actions' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: 'Invalid native session token.' });

    const wrong = await app.inject({
      url: '/native/media-actions',
      headers: { 'x-wishly-native-token': 'not-the-native-token' }
    });
    expect(wrong.statusCode).toBe(401);

    const valid = await app.inject({
      url: '/native/media-actions',
      headers: { 'x-wishly-native-token': NATIVE_TOKEN }
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ jobs: [] });
  });

  it('applies a valid settings patch and rejects an invalid one with the same error code', async () => {
    const app = await makeServer();

    const valid = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: { 'x-session-token': TOKEN },
      payload: { mode: 'custom', crf: 20 }
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().settings).toMatchObject({ mode: 'custom', crf: 20 });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: { 'x-session-token': TOKEN },
      payload: { crf: 5 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Invalid quality.' });
  });

  it('serves the unauthenticated /health probe with product and busy state', async () => {
    const app = await makeServer();
    const health = await app.inject({ url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['cache-control']).toBe('no-store');
    const body = health.json();
    expect(body.product).toBe('local-video-compressor-agent');
    expect(typeof body.busy).toBe('boolean');
    expect(body.busy).toBe(false);
  });

  it('redirects /pair to the pairing origin with the session token', async () => {
    const app = await makeServer();
    const pair = await app.inject({ url: '/pair' });
    expect(pair.statusCode).toBe(302);
    expect(pair.headers.location).toBe(`${ALLOWED_ORIGIN}/#agentToken=${TOKEN}`);
  });

  it('streams the initial compressor snapshot over the /api/events SSE channel', async () => {
    // reply.hijack() bypasses inject()'s response plumbing, so this one test
    // drives a real listening socket instead.
    const app = await makeServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events?token=${TOKEN}`, {
        signal: controller.signal
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text.startsWith('data: ')).toBe(true);
      const event = JSON.parse(text.slice('data: '.length));
      expect(event.type).toBe('state');
      expect(Array.isArray(event.state.jobs)).toBe(true);
    } finally {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
});
