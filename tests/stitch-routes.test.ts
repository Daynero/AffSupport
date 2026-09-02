import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultImageEmbeddingSettings } from '../packages/shared/src/types.js';
import type { ImageEmbeddingSettings } from '../packages/shared/src/types.js';
import type { SourceProfile } from '../packages/shared/src/stitcher.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * The HTTP contract, against a real assembled server.
 *
 * Every status and every machine code in `contracts/agent-http.md` is asserted here, because
 * the codes are what the interface branches on: a route that answers a sentence, or the
 * wrong status, silently turns a specific message into a generic failure.
 *
 * The probe is stubbed rather than run: what these assertions are about is the routes'
 * decisions, and a real `ffprobe` would make them depend on which fixture files exist.
 */

const probeSource = vi.hoisted(() =>
  vi.fn<
    (
      input: string
    ) => Promise<
      { ok: true; value: SourceProfile } | { ok: false; error: 'unreadable' | 'tool-unavailable' }
    >
  >()
);
const detectStaticEdgeTrims = vi.hoisted(() =>
  vi.fn(async () => ({ startSeconds: 0, endSeconds: 0 }))
);
/* The scan the detector runs on: `trims` is what these tests steer, and `runEndingAt` — the
   walk back through anything else held at the tail — finds nothing, so the routes see exactly
   the edges each test asked for. */
const staticEdgeScan = vi.hoisted(() => () => ({
  trims: detectStaticEdgeTrims,
  runEndingAt: async () => 0
}));

vi.mock('../apps/agent/src/stitcher/probe.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/stitcher/probe.js')>();
  return { ...actual, probeSource };
});
vi.mock('../apps/agent/src/images/static-edges.js', () => ({
  detectStaticEdgeTrims,
  staticEdgeScan
}));

const { registerStitcherRoutes } = await import('../apps/agent/src/stitcher/routes.js');
const { StitchQueue } = await import('../apps/agent/src/stitcher/queue.js');

const apps: FastifyInstance[] = [];
let workspace = '';
let source = '';

function profileFor(overrides: Partial<SourceProfile> = {}): SourceProfile {
  return {
    path: source,
    sizeBytes: 1_000,
    modifiedAtMs: 1_700_000_000,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    profile: 'High',
    level: 32,
    width: 1080,
    height: 1080,
    pixelFormat: 'yuv420p',
    colorRange: 'tv',
    frameRate: 30,
    variableFrameRate: false,
    videoTimescale: 15360,
    durationSeconds: 20,
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 96,
    keyframeTimes: [0],
    ...overrides
  };
}

interface Harness {
  app: FastifyInstance;
  queue: InstanceType<typeof StitchQueue>;
}

function harness(
  options: { accepting?: boolean; ffmpeg?: boolean; images?: unknown[] } = {}
): Harness {
  const app = Fastify({ logger: false });
  apps.push(app);
  const queue = new StitchQueue({
    imagePathFor: async () => path.join(workspace, 'photo.png'),
    onChange: () => {},
    // Never reaches a media engine: these assertions are about the routes.
    pipeline: async context => {
      const staged = path.join(context.workDir, 'result.mp4');
      await writeFile(staged, 'stitched');
      return {
        ok: true,
        stagedPath: staged,
        verification: {
          durationSeconds: 20,
          frameCount: 600,
          videoTrackSeconds: 20,
          audioTrackSeconds: 20,
          videoCodec: 'h264',
          audioCodec: 'aac',
          width: 1080,
          height: 1080,
          pixelFormat: 'yuv420p',
          withinTolerance: true,
          mismatches: []
        }
      };
    }
  });
  registerStitcherRoutes(app, {
    queue,
    events: { handler: async (_request, reply) => reply.send('') },
    acceptingNewTasks: () => options.accepting ?? true,
    tools: () => ({ ffmpeg: options.ffmpeg ?? true, ffprobe: options.ffmpeg ?? true }),
    // The screens are the compressor's library; the routes read it live.
    embedding: () => ({
      ...defaultImageEmbeddingSettings(),
      enabled: true,
      endImages: (options.images ?? [
        {
          id: 'photo',
          fileName: 'promo.png',
          width: 1080,
          height: 1080,
          size: 1024,
          mimeType: 'image/png' as const,
          extension: '.png' as const
        }
      ]) as ImageEmbeddingSettings['endImages'],
      finalDurationMode: 'custom' as const,
      customFinalDurationSeconds: 45 * 60
    })
  });
  return { app, queue };
}

const body = (overrides: Record<string, unknown> = {}) => ({ path: source, ...overrides });

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'stitch-routes-'));
  source = path.join(workspace, 'creative.mp4');
  await writeFile(source, 'not really a video');
  probeSource.mockReset();
  probeSource.mockResolvedValue({ ok: true, value: profileFor() });
  detectStaticEdgeTrims.mockReset();
  detectStaticEdgeTrims.mockResolvedValue({ startSeconds: 0, endSeconds: 0 });
});

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
  await removeTemporaryDirectory(workspace);
});

describe('GET /api/stitcher', () => {
  it('answers with the tool state snapshot', async () => {
    const { app } = harness();
    const response = await app.inject({ method: 'GET', url: '/api/stitcher' });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toMatchObject({ jobs: [], busy: false });
  });
});

describe('POST /api/stitcher/inspect', () => {
  it('returns the profile, what was found, and the plan', async () => {
    detectStaticEdgeTrims.mockResolvedValue({ startSeconds: 0.033333, endSeconds: 5 });
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body()
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.detected).toMatchObject({ startSeconds: 0.033333, endSeconds: 5 });
    expect(payload.plan.operation).toBe('restitch');
    expect(payload.profile.videoCodec).toBe('h264');
  });

  it('refuses a path that is not an absolute local one', async () => {
    const { app } = harness();
    for (const candidate of ['relative/path.mp4', '', 42]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/stitcher/inspect',
        payload: { path: candidate }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'STITCH_PATH_INVALID' });
    }
  });

  it('names the property that makes a file unservable', async () => {
    probeSource.mockResolvedValue({ ok: true, value: profileFor({ videoCodec: 'hevc' }) });
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body()
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'STITCH_SOURCE_UNSUPPORTED', reason: 'video-codec' });
  });

  it('reports an unreadable file as unsupported rather than as a server error', async () => {
    probeSource.mockResolvedValue({ ok: false, error: 'unreadable' });
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body()
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().reason).toBe('unreadable');
  });

  it('reports a missing media engine as unavailable', async () => {
    probeSource.mockResolvedValue({ ok: false, error: 'tool-unavailable' });
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body()
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'MEDIA_TOOL_UNAVAILABLE' });
  });

  it('says there is nothing to remove rather than producing an empty result', async () => {
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body({ operation: 'unstitch' })
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'STITCH_NOTHING_TO_REMOVE' });
  });

  it('asks for a photo when both slots were cleared', async () => {
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: { path: source, startImageId: null, endImageId: null }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'STITCH_NO_SCREENS_CHOSEN' });
  });

  it('repeats the end-screen length the preview promised, rather than drawing again', async () => {
    const { app } = harness();
    const first = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body({ endDurationSeconds: 41.5 })
    });
    // A screen is a whole number of pictures, and 41.5 s at one a second is 42 of them.
    expect(first.json().plan.endScreen.durationSeconds).toBe(42);
    const second = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body({ endDurationSeconds: 41 })
    });
    expect(second.json().plan.endScreen.durationSeconds).toBe(41);
  });

  it('honours boundaries the user moved', async () => {
    detectStaticEdgeTrims.mockResolvedValue({ startSeconds: 0, endSeconds: 0 });
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/inspect',
      payload: body({ boundaries: { startSeconds: 1, endSeconds: 2 } })
    });
    expect(response.json().detected).toMatchObject({
      startSeconds: 1,
      endSeconds: 2,
      adjustedByUser: true
    });
    expect(response.json().plan.operation).toBe('restitch');
  });
});

describe('POST /api/stitcher/files', () => {
  it('adds a row per readable file and names what it refused', async () => {
    const other = path.join(workspace, 'wrong-codec.mp4');
    await writeFile(other, 'not really a video');
    probeSource.mockImplementation(async (input: string) =>
      input === other
        ? { ok: true as const, value: profileFor({ path: other, videoCodec: 'hevc' }) }
        : { ok: true as const, value: profileFor() }
    );
    const { app, queue } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/files',
      payload: { paths: [source, other] }
    });
    expect(response.statusCode).toBe(200);
    // The row exists before anything runs — that is what makes the list a queue.
    expect(response.json().state.jobs).toMatchObject([
      { sourceName: 'creative.mp4', status: 'ready' }
    ]);
    expect(response.json().refused).toEqual([{ path: other, reason: 'video-codec' }]);
    // Nothing was looked for yet: finding the screens already on a file costs seconds, and a
    // dropped file has to appear in the list at once.
    expect(response.json().state.jobs[0].detected).toBeNull();
    expect(detectStaticEdgeTrims).not.toHaveBeenCalled();
    await queue.shutdown();
  });

  it('refuses a path that is not an absolute local one', async () => {
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/files',
      payload: { paths: ['relative/path.mp4'] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'STITCH_PATH_INVALID' });
  });

  it('reports a missing media engine rather than adding an unexamined row', async () => {
    const { app } = harness({ ffmpeg: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/files',
      payload: { paths: [source] }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'MEDIA_TOOL_UNAVAILABLE' });
  });
});

describe('POST /api/stitcher/start', () => {
  /** Adds one row and answers with its id, the way the page does before it starts anything. */
  async function readyRow(app: FastifyInstance): Promise<string> {
    const added = await app.inject({
      method: 'POST',
      url: '/api/stitcher/files',
      payload: { paths: [source] }
    });
    return added.json().state.jobs[0].id as string;
  }

  it('runs the rows it was given and reports them queued', async () => {
    const { app, queue } = harness();
    const id = await readyRow(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/start',
      payload: { ids: [id], operation: 'stitch' }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().failures).toEqual([]);
    expect(response.json().state.jobs[0]).toMatchObject({ operation: 'stitch' });
    await queue.shutdown();
  });

  it('says at once when no photo has been chosen, rather than starting a run to find out', async () => {
    const { app, queue } = harness({ images: [] });
    const id = await readyRow(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/start',
      payload: { ids: [id], operation: 'restitch' }
    });
    expect(response.statusCode).toBe(202);
    // The one refusal that needs nothing from the file. Everything the planner can only
    // decide after looking at the source is answered by the run, on the row itself.
    expect(response.json().failures).toEqual([{ id, error: 'no-screens' }]);
    expect(response.json().state.jobs[0].status).toBe('ready');
    await queue.shutdown();
  });

  it('starts a row again after a restart forgot its profile', async () => {
    const { app, queue } = harness();
    const id = await readyRow(app);
    // What a restart leaves behind: the row is persisted, the profile behind it is not.
    (queue as unknown as { profiles: Map<string, unknown> }).profiles.clear();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/start',
      payload: { ids: [id], operation: 'stitch' }
    });
    expect(response.json().failures).toEqual([]);
    expect(response.json().state.jobs[0].status).not.toBe('ready');
    await queue.shutdown();
  });

  it('refuses new work while an update is draining', async () => {
    const { app } = harness({ accepting: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/start',
      payload: { ids: ['whatever'] }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'UPDATE_PENDING' });
  });

  it('refuses to run without a media engine', async () => {
    const { app } = harness({ ffmpeg: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/start',
      payload: { ids: ['whatever'] }
    });
    expect(response.statusCode).toBe(503);
  });

  it('says nothing was selected rather than starting the whole list', async () => {
    const { app } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/stitcher/start',
      payload: { ids: [] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'STITCH_NOTHING_SELECTED' });
  });
});

describe('POST /api/stitcher/jobs/:id/cancel', () => {
  it('tells an unknown job apart from a finished one', async () => {
    const { app, queue } = harness();
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/stitcher/jobs/does-not-exist/cancel'
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'STITCH_JOB_UNKNOWN' });

    const added = await app.inject({
      method: 'POST',
      url: '/api/stitcher/files',
      payload: { paths: [source] }
    });
    const id = added.json().state.jobs[0].id as string;
    await app.inject({
      method: 'POST',
      url: '/api/stitcher/start',
      payload: { ids: [id], operation: 'stitch' }
    });
    // Let the run finish before asking to stop it.
    await queue.shutdown();
    const finished = await app.inject({ method: 'POST', url: `/api/stitcher/jobs/${id}/cancel` });
    expect(finished.statusCode).toBe(409);
    expect(finished.json()).toEqual({ error: 'STITCH_JOB_FINISHED' });
  });
});

describe('POST /api/stitcher/settings', () => {
  it('applies a valid patch and refuses an invalid one', async () => {
    const { app } = harness();
    const good = await app.inject({
      method: 'POST',
      url: '/api/stitcher/settings',
      payload: { outputSuffix: '(перезашив)', destination: { kind: 'overwrite' } }
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().state.settings).toMatchObject({
      outputSuffix: '(перезашив)',
      destination: { kind: 'overwrite' }
    });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/stitcher/settings',
      payload: { destination: { kind: 'somewhere' } }
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'STITCH_SETTINGS_INVALID' });
  });
});
