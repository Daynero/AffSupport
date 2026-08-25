import { generateKeyPairSync, sign as signData } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
import { waitFor } from './support/wait.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

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
    await removeTemporaryDirectory(handle.dir);
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

    // The old loop gave up quietly at its deadline and then asserted `running`
    // was false, so a preview that never finished failed as a puzzling
    // expectation rather than as the timeout it was.
    let state: LandingPreviewState = opened.json();
    await waitFor(
      async () => {
        const response = await app.inject({
          url: '/api/landing-preview/state',
          headers: { 'x-session-token': TOKEN }
        });
        state = response.json();
        return !state.running;
      },
      { timeoutMs: 5_000, describe: 'the landing preview render to finish' }
    );
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

  describe('/local hands the browser back to the page it came from', () => {
    // The hosted site cannot tell "Soty is not installed" apart from "Soty is
    // installed and this browser will not look at loopback", so every one of
    // those screens offers this link. Carrying the destination is what keeps
    // that recovery to a single click.
    it('opens the tool the site asked for, with a pairing token attached', async () => {
      const app = await makeServer();

      const response = await app.inject({ url: '/local?to=%2Ftools%2Ftranscription' });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        `http://127.0.0.1:43120/tools/transcription#agentToken=${TOKEN}`
      );
    });

    it('opens the home screen when the site asks for nothing in particular', async () => {
      const app = await makeServer();

      const response = await app.inject({ url: '/local' });

      expect(response.headers.location).toBe(`http://127.0.0.1:43120/#agentToken=${TOKEN}`);
    });

    it.each([
      ['a protocol-relative host', '//evil.example'],
      ['an absolute URL', 'https://evil.example/x'],
      ['a relative path', 'tools/compressor'],
      ['a fragment of its own', '/tools/compressor%23agentToken=stolen']
    ])('will not be turned into a redirector by %s', async (_case, to) => {
      const app = await makeServer();

      const response = await app.inject({ url: `/local?to=${encodeURIComponent(to)}` });

      // Losing the destination costs one click. Following it costs the token.
      expect(response.headers.location).toBe(`http://127.0.0.1:43120/#agentToken=${TOKEN}`);
    });
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
  describe('request admission', () => {
    // These guard two holes that were confirmed by probing a running Agent, not inferred:
    // `curl -H "Host: evil.example.com" http://127.0.0.1:<port>/health` answered 200, and
    // the browser session token was compared with `!==` while /native/* twelve lines away
    // already used a constant-time compare.
    //
    // The prize behind the Host check is not /health leaking a build id. It is /pair,
    // which hands the session token to anyone who follows its redirect — so a page rebound
    // to loopback that follows it and reads its own fragment would be fully paired. After
    // rebinding the request is same-origin and carries no Origin header at all, so the
    // origin check cannot see it. Only the Host can.

    it('refuses a request whose Host is not this machine', async () => {
      const app = await makeServer();
      for (const url of ['/health', '/api/health', '/pair', '/local', '/']) {
        const response = await app.inject({
          url,
          headers: { host: 'evil.example.com', 'x-session-token': TOKEN }
        });
        expect(response.statusCode, `${url} accepted a spoofed Host`).toBe(403);
        expect(response.json()).toEqual({ error: 'HOST_NOT_ALLOWED' });
      }
    });

    it("refuses a rebound Host that carries this machine's port", async () => {
      const app = await makeServer();
      const response = await app.inject({
        url: '/pair',
        headers: { host: 'evil.example.com:43127' }
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses duplicate Host headers, which arrive joined by a comma', async () => {
      const app = await makeServer();
      const response = await app.inject({
        url: '/health',
        headers: { host: '127.0.0.1, evil.example.com' }
      });
      expect(response.statusCode).toBe(403);
    });

    it("accepts every form of this machine's own loopback address", async () => {
      const app = await makeServer();
      for (const host of ['127.0.0.1', '127.0.0.1:43127', 'localhost', 'localhost:5175']) {
        const response = await app.inject({ url: '/health', headers: { host } });
        expect(response.statusCode, `${host} was refused`).toBe(200);
      }
    });

    it('rejects a repeated token query parameter instead of comparing an array', async () => {
      // Fastify parses `?token=a&token=b` into an array. That value used to reach a raw
      // `!==`, which is neither a string comparison nor a constant-time one.
      const app = await makeServer();
      const response = await app.inject({
        url: `/api/health?token=${TOKEN}&token=${TOKEN}`
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Invalid session token.' });
    });

    it('rejects a token of the wrong length without leaking how far it matched', async () => {
      const app = await makeServer();
      for (const supplied of ['', TOKEN.slice(0, -1), `${TOKEN}x`, `${TOKEN} `]) {
        const response = await app.inject({
          url: '/api/health',
          headers: { 'x-session-token': supplied }
        });
        expect(response.statusCode, `accepted "${supplied}"`).toBe(401);
      }
    });

    it('still accepts the correct token by header and by query', async () => {
      const app = await makeServer();
      expect(
        (await app.inject({ url: '/api/health', headers: { 'x-session-token': TOKEN } })).statusCode
      ).toBe(200);
      expect((await app.inject({ url: `/api/health?token=${TOKEN}` })).statusCode).toBe(200);
    });
  });
});

describe('a refused transition answers with one code', () => {
  /**
   * The interface has to be able to tell "you cannot do that from here" apart from "that
   * broke". Before this it could not: each route answered 409 with its own sentence, so the
   * only way to distinguish them was to match English prose — which is how eleven other
   * messages ended up being translated by wording rather than by code (F13).
   *
   * One code, from the same tables the agent enforces, is also what lets the interface gate
   * the affordance instead of offering an action and reporting a refusal afterwards.
   */
  it('refuses a start when nothing in the selection is in a startable state', async () => {
    const app = await makeServer();
    const started = await app.inject({
      method: 'POST',
      url: '/api/queue/start',
      headers: { 'x-session-token': TOKEN, 'content-type': 'application/json' },
      payload: { ids: ['no-such-job'] }
    });

    expect(started.statusCode).toBe(409);
    expect(started.json()).toEqual({ error: 'TRANSITION_NOT_ALLOWED' });
  });

  it('refuses a stop for a job that is not running or waiting', async () => {
    const app = await makeServer();
    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/jobs/no-such-job/cancel',
      headers: { 'x-session-token': TOKEN }
    });

    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json()).toEqual({ error: 'TRANSITION_NOT_ALLOWED' });
  });

  it('answers with the same code from the transcription and landing tools', async () => {
    const app = await makeServer();

    // The point of a shared table is that every tool answers the same way. A per-tool code
    // would leave the interface with four refusal vocabularies to learn.
    const transcription = await app.inject({
      method: 'POST',
      url: '/api/transcription/jobs/no-such-job/cancel',
      headers: { 'x-session-token': TOKEN }
    });
    expect(transcription.statusCode).toBe(409);
    expect(transcription.json()).toEqual({ error: 'TRANSITION_NOT_ALLOWED' });

    const landing = await app.inject({
      method: 'POST',
      url: '/api/landing/start',
      headers: { 'x-session-token': TOKEN, 'content-type': 'application/json' },
      payload: {}
    });
    expect(landing.statusCode).toBe(409);
    expect(landing.json()).toEqual({ error: 'TRANSITION_NOT_ALLOWED' });
  });
});

describe('stopping work from the interface', () => {
  it('stops one Finder-initiated conversion through the session-authenticated route', async () => {
    const app = await makeServer();

    // Under /api/ rather than /native/: the person who wants to stop this is looking at the
    // interface, not at Finder. A conversion started from the file manager has no window of
    // its own, so before this the only way to stop a wedged one was to quit (A3).
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/media-actions/no-such-job/cancel'
    });
    expect(unauthenticated.statusCode).toBe(401);

    const refused = await app.inject({
      method: 'POST',
      url: '/api/media-actions/no-such-job/cancel',
      headers: { 'x-session-token': TOKEN }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'TRANSITION_NOT_ALLOWED' });

    const all = await app.inject({
      method: 'POST',
      url: '/api/media-actions/cancel-all',
      headers: { 'x-session-token': TOKEN }
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ stopped: 0 });
  });

  it('stops one landing without stopping the others', async () => {
    const app = await makeServer();

    // The only stop this tool offered was "stop everything", so abandoning the second of
    // four landings meant losing the other three too.
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/landing/jobs/no-such-job/cancel'
    });
    expect(unauthenticated.statusCode).toBe(401);

    const refused = await app.inject({
      method: 'POST',
      url: '/api/landing/jobs/no-such-job/cancel',
      headers: { 'x-session-token': TOKEN }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'TRANSITION_NOT_ALLOWED' });
  });
});

describe('request budgets', () => {
  /**
   * The local app is only reachable from this machine, so what these bounds
   * protect against is not a distributed attack — it is a runaway loop in a tab
   * and a script on a page that has found the port, both of which turn into a
   * warm laptop and a busy disk if the server answers every time.
   */

  it('keeps answering an ordinary burst', async () => {
    const app = await makeServer();
    // A page can legitimately be busy: several tools polling, a queue updating,
    // a user clicking. A bound that fires here would be a bug of its own.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'x-session-token': TOKEN }
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('stops answering a token that keeps being wrong', async () => {
    const app = await makeServer();
    let refused = 0;
    let cooled = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'x-session-token': 'f'.repeat(64) }
      });
      if (response.statusCode === 401) refused += 1;
      if (response.statusCode === 429) cooled += 1;
    }
    // A handful of wrong tokens is ordinary — the local app restarted and
    // minted a new one. Sixty in a row is something enumerating.
    expect(refused).toBeGreaterThan(0);
    expect(cooled).toBeGreaterThan(0);
  });

  it('lets a real token through again once it works', async () => {
    const app = await makeServer();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'x-session-token': 'f'.repeat(64) }
      });
    }
    // The ordinary case: a tab that re-pairs must not spend the rest of the
    // minute in a cooldown it earned before it had the new token.
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-session-token': TOKEN }
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('ticket issuing', () => {
  /**
   * The route exists so access can travel where a header cannot — into an
   * `<img>` or a `<video>` the browser fetches itself. It is not a way to *get*
   * access, and the allowlist is what keeps that true: without it this would
   * mint a five-minute bearer token for any endpoint, which is the problem it
   * was built to solve, relocated.
   */

  async function ask(app: FastifyInstance, body: unknown, token: string = TOKEN) {
    return app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { 'x-session-token': token, 'content-type': 'application/json' },
      payload: body as Record<string, unknown>
    });
  }

  it('mints a ticket for a subresource', async () => {
    const app = await makeServer();
    const response = await ask(app, { path: '/api/images/abc/content' });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().ticket).toBe('string');
  });

  it('refuses a path outside the allowlist', async () => {
    const app = await makeServer();
    // A ticket for /api/queue would be a five-minute bearer token for the
    // queue, in a URL.
    const response = await ask(app, { path: '/api/queue' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('PATH_NOT_TICKETABLE');
  });

  it('refuses a method that changes anything', async () => {
    const app = await makeServer();
    const response = await ask(app, { path: '/api/images/abc/content', method: 'DELETE' });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a path carrying its own query string', async () => {
    const app = await makeServer();
    // The ticket travels in the query; signing a path that already has one
    // would mean signing a value that contains its own signature.
    const response = await ask(app, { path: '/api/images/abc/content?ticket=x' });
    expect(response.statusCode).toBe(400);
  });

  it('cannot be reached without the session token', async () => {
    const app = await makeServer();
    const response = await ask(app, { path: '/api/images/abc/content' }, 'f'.repeat(64));
    expect(response.statusCode).toBe(401);
  });

  it('lets the minted ticket fetch that resource without a token', async () => {
    const app = await makeServer();
    const minted = await ask(app, { path: '/api/images/missing/content' });
    const { ticket } = minted.json();

    const used = await app.inject({
      method: 'GET',
      url: `/api/images/missing/content?ticket=${encodeURIComponent(ticket)}`
    });
    // 404 rather than 401: the request got past authentication on the ticket
    // alone and failed on the resource not existing, which is the whole point.
    expect(used.statusCode).not.toBe(401);
  });

  it('does not let it fetch a different resource', async () => {
    const app = await makeServer();
    const minted = await ask(app, { path: '/api/images/one/content' });
    const { ticket } = minted.json();

    const used = await app.inject({
      method: 'GET',
      url: `/api/images/two/content?ticket=${encodeURIComponent(ticket)}`
    });
    expect(used.statusCode).toBe(401);
  });
});
