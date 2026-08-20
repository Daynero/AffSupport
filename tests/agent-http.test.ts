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
  type LandingPreviewEvent,
  type LandingPreviewState,
  type TranscriptionEvent
} from '../packages/shared/src/types.js';
import { EntitlementGate } from '../apps/agent/src/entitlement/entitlement.js';
import { EstimationWorker } from '../apps/agent/src/estimate/worker.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { LandingOptimizer } from '../apps/agent/src/landing/optimizer.js';
import {
  LandingPreviewCatalog,
  type LandingRenderer
} from '../apps/agent/src/landing-preview/catalog.js';
import { MediaActionQueue } from '../apps/agent/src/media-actions/queue.js';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { TranscriptionQueue } from '../apps/agent/src/queue/transcription-queue.js';
import { buildServer } from '../apps/agent/src/server/app.js';
import { EventChannel } from '../apps/agent/src/server/sse.js';
import { createToolModules } from '../apps/agent/src/server/tools.js';
import { TeamPreviewBridge } from '../apps/agent/src/team-bridge/preview.js';
import { TeamDownloadBridge } from '../apps/agent/src/team-bridge/download.js';
import { TeamLandingRenderBridge } from '../apps/agent/src/team-bridge/landing-gallery.js';
import { CreativeLibraryProcessBridge } from '../apps/agent/src/team-bridge/library.js';
import {
  TeamOperationEvents,
  type TeamOperationEvent
} from '../apps/agent/src/team-bridge/events.js';
import { TeamProcessBridge } from '../apps/agent/src/team-bridge/process.js';
import { TeamTransferClient } from '../apps/agent/src/team-bridge/transfer.js';
import { optimalSettings } from './helpers.js';

const TOKEN = 'test-session-token';
const NATIVE_TOKEN = 'test-native-token';
const UPDATE_HANDOFF_TOKEN = 'test-update-handoff-token';
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
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Soty test</title>');

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
  const landingPreviewRenderer: LandingRenderer = {
    init: async () => {},
    availability: () => ({ available: true, error: null }),
    render: async ({ outputPath }) => {
      await writeFile(
        outputPath,
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)])
      );
      return {
        width: 1440,
        height: 900,
        segmentFiles: [outputPath],
        title: null,
        blockedExternalRequests: 0,
        warning: null
      };
    },
    shutdown: async () => {}
  };
  const landingPreviewCatalog = new LandingPreviewCatalog({
    root: path.join(dir, 'landing-previews'),
    renderer: landingPreviewRenderer
  });
  await landingPreviewCatalog.init();
  const landingPreviewEvents = new EventChannel<LandingPreviewEvent>(allowedOrigins, () => ({
    type: 'landing-preview:state',
    state: landingPreviewCatalog.state()
  }));
  landingPreviewCatalog.setNotify(type =>
    landingPreviewEvents.broadcast({
      type: type ?? 'landing-preview:state',
      state: landingPreviewCatalog.state()
    })
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
  const teamPreviewBridge = new TeamPreviewBridge({
    temporaryRoot: path.join(dir, 'team-previews'),
    renderer: landingPreviewRenderer
  });
  await teamPreviewBridge.init();
  const teamOperationEvents = new TeamOperationEvents();
  const teamEvents = new EventChannel<TeamOperationEvent>(allowedOrigins, () =>
    teamOperationEvents.snapshot()
  );
  teamOperationEvents.setNotify(event => teamEvents.broadcast(event));
  const teamTransfer = new TeamTransferClient({ temporaryRoot: path.join(dir, 'team-transfer') });
  const teamProcessBridge = new TeamProcessBridge({
    transfer: teamTransfer,
    delegates: {},
    events: teamOperationEvents
  });
  const creativeLibraryProcessBridge = new CreativeLibraryProcessBridge({
    process: teamProcessBridge
  });
  const teamDownloadBridge = new TeamDownloadBridge({
    transfer: teamTransfer,
    chooseDestination: async () => null,
    reveal: () => undefined
  });
  const teamLandingRenderBridge = new TeamLandingRenderBridge({
    preview: teamPreviewBridge,
    events: teamOperationEvents
  });
  const entitlementGate = new EntitlementGate({
    publicKeyBase64: options.entitlementPublicKey ?? null,
    stateFile: path.join(dir, 'entitlement.json')
  });

  const requestedUpdateBuilds: string[] = [];
  const app = await buildServer({
    logger: false,
    token: TOKEN,
    nativeToken: NATIVE_TOKEN,
    updateHandoffToken: UPDATE_HANDOFF_TOKEN,
    requestUpdateDrain: targetBuildId => requestedUpdateBuilds.push(targetBuildId),
    allowedOrigins,
    entitlementGate,
    config: {
      environment: 'production' as const,
      host: '127.0.0.1',
      port: 43120,
      publicOrigin: null,
      devOrigin: ALLOWED_ORIGIN,
      version: '0.9.18',
      buildNumber: '54',
      buildId: '0.9.18+54',
      channel: 'test',
      sourceRevision: 'development'
    },
    instanceId: 'test-instance',
    startedAt: new Date().toISOString(),
    tools,
    queue,
    power: new PowerGovernor({ pauseSupported: false }),
    modules: createToolModules({
      compressor: { queue, estimator, imageStore, events: agentEvents, tools },
      mediaActions,
      landing: { optimizer: landingOptimizer, events: landingEvents },
      landingPreview: { catalog: landingPreviewCatalog, events: landingPreviewEvents },
      transcription: { queue: transcriptionQueue, events: transcriptionEvents },
      teamWorkspace: {
        preview: teamPreviewBridge,
        process: teamProcessBridge,
        download: teamDownloadBridge,
        landings: teamLandingRenderBridge,
        library: creativeLibraryProcessBridge,
        events: teamEvents
      }
    }),
    webRoot
  });
  await app.ready();
  handles.push({ app, dir });
  Object.defineProperty(app, 'requestedUpdateBuilds', { value: requestedUpdateBuilds });
  return app as FastifyInstance & { requestedUpdateBuilds: string[] };
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
  it('advertises and guards the registered team workspace preview bridge', async () => {
    const app = await makeServer();
    const health = await app.inject({
      url: '/api/health',
      headers: { 'x-session-token': TOKEN }
    });
    expect(health.json()).toMatchObject({
      capabilities: expect.arrayContaining(['team-workspace']),
      toolContracts: { teamWorkspace: 2 }
    });

    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/team/preview/archive',
      payload: {}
    });
    expect(unauthenticated.statusCode).toBe(401);
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/team/preview/archive',
      headers: { 'x-session-token': TOKEN, 'content-type': 'application/json' },
      payload: {}
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: 'INVALID_INPUT' });
    expect(malformed.headers['cache-control']).toBe('no-store');

    const unauthenticatedRender = await app.inject({
      method: 'POST',
      url: '/api/team/landings/render',
      payload: {}
    });
    expect(unauthenticatedRender.statusCode).toBe(401);
    const malformedRender = await app.inject({
      method: 'POST',
      url: '/api/team/landings/render',
      headers: { 'x-session-token': TOKEN, 'content-type': 'application/json' },
      payload: {}
    });
    expect(malformedRender.statusCode).toBe(400);
    expect(malformedRender.json()).toEqual({ error: 'INVALID_INPUT' });

    const unauthenticatedTeamCatalog = await app.inject({
      method: 'POST',
      url: '/api/landing-preview/team-space',
      payload: {}
    });
    expect(unauthenticatedTeamCatalog.statusCode).toBe(401);
    const malformedTeamCatalog = await app.inject({
      method: 'POST',
      url: '/api/landing-preview/team-space',
      headers: { 'x-session-token': TOKEN, 'content-type': 'application/json' },
      payload: {}
    });
    expect(malformedTeamCatalog.statusCode).toBe(400);
    expect(malformedTeamCatalog.json()).toEqual({ error: 'INVALID_INPUT' });
  });

  it('builds and serves a landing preview catalogue through authenticated routes', async () => {
    const app = await makeServer();
    const dir = handles.at(-1)!.dir;
    const source = path.join(dir, 'preview-source', 'campaign');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'index.html'), '<!doctype html><h1>Campaign</h1>');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/landing-preview/open',
      headers: { 'x-session-token': TOKEN, 'content-type': 'application/json' },
      payload: { paths: [path.dirname(source)] }
    });
    expect(opened.statusCode).toBe(200);

    let state: LandingPreviewState = opened.json();
    const deadline = Date.now() + 5_000;
    while (state.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const response = await app.inject({
        url: '/api/landing-preview/state',
        headers: { 'x-session-token': TOKEN }
      });
      state = response.json();
    }
    expect(state.running).toBe(false);
    expect(state.landings).toHaveLength(1);
    expect(state.landings[0]).toMatchObject({
      name: 'campaign',
      status: 'ready',
      previewAvailable: true
    });

    const image = await app.inject({
      url: `/api/landing-preview/landings/${state.landings[0].id}/image`,
      headers: { 'x-session-token': TOKEN }
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/webp');
    expect(image.body.slice(0, 4)).toBe('RIFF');

    const invalidSegment = await app.inject({
      url: `/api/landing-preview/landings/${state.landings[0].id}/image?segment=-1`,
      headers: { 'x-session-token': TOKEN }
    });
    expect(invalidSegment.statusCode).toBe(400);
  });

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

  it('guards the power throttle exactly like every other tool route', async () => {
    const kit = entitlementKit();

    const open = await makeServer();
    const snapshot = await open.inject({
      url: '/api/power',
      headers: { 'x-session-token': TOKEN }
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ limitPercent: 100, mode: 'unrestricted' });

    // No token, foreign origin, and no entitlement must all be refused. The
    // power routes are deliberately NOT in the entitlement-exempt set: that set
    // is the routes needed to establish a session, and a settings control is
    // not one of them.
    expect((await open.inject({ url: '/api/power' })).statusCode).toBe(401);
    const foreign = await open.inject({
      url: '/api/power',
      headers: { 'x-session-token': TOKEN, origin: 'https://evil.example' }
    });
    expect(foreign.statusCode).toBe(403);

    const gated = await makeServer({ entitlementPublicKey: kit.publicKeyBase64 });
    const blocked = await gated.inject({
      url: '/api/power',
      headers: { 'x-session-token': TOKEN }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: 'ENTITLEMENT_REQUIRED' });
  });

  it('advertises the power contract so an older agent reads as unsupported', async () => {
    const app = await makeServer();
    const health = await app.inject({ url: '/health' });
    // This is the whole mechanism behind "your agent is too old to honour the
    // limit" — no version sniffing anywhere.
    expect(health.json().toolContracts.power).toBe(1);
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

  it('accepts an authenticated update drain without exposing the Finder bridge token', async () => {
    const app = await makeServer();

    const missing = await app.inject({
      method: 'POST',
      url: '/native/update/drain',
      payload: { targetBuildId: '0.9.19+55' }
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: 'Invalid update handoff token.' });

    const wrongBridgeToken = await app.inject({
      method: 'POST',
      url: '/native/update/drain',
      headers: { 'x-wishly-native-token': NATIVE_TOKEN },
      payload: { targetBuildId: '0.9.19+55' }
    });
    expect(wrongBridgeToken.statusCode).toBe(401);

    const malformed = await app.inject({
      method: 'POST',
      url: '/native/update/drain',
      headers: { 'x-wishly-update-token': UPDATE_HANDOFF_TOKEN },
      payload: { targetBuildId: 'not a build id' }
    });
    expect(malformed.statusCode).toBe(400);

    const older = await app.inject({
      method: 'POST',
      url: '/native/update/drain',
      headers: { 'x-wishly-update-token': UPDATE_HANDOFF_TOKEN },
      payload: { targetBuildId: '0.9.17+53' }
    });
    expect(older.statusCode).toBe(409);
    expect(older.json()).toEqual({ error: 'UPDATE_TARGET_NOT_NEWER' });

    const accepted = await app.inject({
      method: 'POST',
      url: '/native/update/drain',
      headers: { 'x-wishly-update-token': UPDATE_HANDOFF_TOKEN },
      payload: { targetBuildId: '0.9.19+55' }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    expect(app.requestedUpdateBuilds).toEqual(['0.9.19+55']);
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
