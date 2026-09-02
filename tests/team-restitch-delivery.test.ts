import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageEmbeddingSettings } from '../packages/shared/src/types.js';
import type { TeamRestitchDefaults } from '../packages/shared/src/team/restitch.js';
import { createRestitchDelegate } from '../apps/agent/src/team-bridge/restitch.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * What a re-stitched delivery must be true of.
 *
 * The media half is feature 014's and is proved against a real engine next door; what is
 * proved here is the half this feature added — that a prepared record removes the expensive
 * step entirely, that an unprepared run hands back what it found so nobody pays twice, and
 * that neither one touches the member's own file.
 */

const probeSource = vi.hoisted(() => vi.fn());
const detectStitching = vi.hoisted(() => vi.fn());

vi.mock('../apps/agent/src/stitcher/probe.js', () => ({ probeSource }));
vi.mock('../apps/agent/src/stitcher/plan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/stitcher/plan.js')>();
  return { ...actual, detectStitching };
});

let workspace = '';

const profile = (input: string) => ({
  path: input,
  sizeBytes: 1_000,
  modifiedAtMs: 1_700_000_000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  profile: 'High',
  level: 40,
  width: 1080,
  height: 1080,
  pixelFormat: 'yuv420p',
  colorRange: 'tv' as const,
  frameRate: 30,
  variableFrameRate: false,
  videoTimescale: 15360,
  durationSeconds: 123.7,
  hasAudio: true,
  audioCodec: 'aac',
  audioSampleRate: 48000,
  audioChannels: 2,
  audioBitrateKbps: 96,
  keyframeTimes: [0, 8.3]
});

const library: ImageEmbeddingSettings = {
  enabled: true,
  startEnabled: true,
  endEnabled: true,
  startImages: [
    {
      id: 'start-a',
      fileName: 'a.png',
      width: 1080,
      height: 1080,
      size: 10,
      mimeType: 'image/png',
      extension: '.png'
    }
  ],
  endImages: [
    {
      id: 'end-a',
      fileName: 'b.png',
      width: 1080,
      height: 1080,
      size: 10,
      mimeType: 'image/png',
      extension: '.png'
    }
  ],
  disabledImageIds: [],
  replaceExisting: true,
  finalDurationMode: 'random-30-40',
  customFinalDurationSeconds: 2700,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100,
  fitMode: 'cover'
};

const defaults: TeamRestitchDefaults = {
  operation: 'restitch',
  startImageIds: ['start-a'],
  endImageIds: ['end-a'],
  fitMode: 'cover',
  finalDurationMode: 'random-30-40',
  customFinalDurationSeconds: 2700,
  configured: true,
  updatedAt: '2026-09-02T00:00:00.000Z',
  updatedBy: 'someone'
};

/** A pipeline that writes a believable staged file without touching a media engine. */
const staging = vi.fn(async (context: { workDir: string }) => {
  const staged = path.join(context.workDir, 'result.mp4');
  await writeFile(staged, 'stitched');
  return { ok: true as const, stagedPath: staged, verification: null as never };
});

async function source(name = 'creative.mp4'): Promise<string> {
  const file = path.join(workspace, name);
  await writeFile(file, 'the member’s own bytes');
  return file;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

function run(input: string, options: unknown, signal = new AbortController().signal) {
  const delegate = createRestitchDelegate({
    embedding: () => library,
    imagePathFor: async () => path.join(workspace, 'photo.png'),
    pipeline: staging as never
  });
  return delegate({
    operationId: 'op-1',
    workspace,
    sourceFile: input,
    sourceSizeBytes: 1_000,
    sourceVersion: '7',
    sourceChecksum: null,
    options,
    signal,
    onProgress: () => {},
    pausable: () => {}
  });
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'restitch-delivery-'));
  probeSource.mockReset();
  detectStitching.mockReset();
  staging.mockClear();
  probeSource.mockImplementation(async (input: string) => ({ ok: true, value: profile(input) }));
  detectStitching.mockResolvedValue({
    startSeconds: 0.033333,
    endSeconds: 1800,
    adjustedByUser: false
  });
});

afterEach(async () => {
  await removeTemporaryDirectory(workspace);
  vi.restoreAllMocks();
});

describe('a re-stitched delivery', () => {
  it('never looks at a file somebody has already looked at', async () => {
    const input = await source();
    const result = await run(input, {
      defaults,
      prepared: {
        materialId: 'material-1',
        driveVersion: '7',
        detectedStartSeconds: 0.033333,
        detectedEndSeconds: 1800,
        // Prepared on somebody else's machine, so the path in it is theirs, not ours.
        profile: profile('/somewhere/else/creative.mp4'),
        unsupportedReason: null,
        preparedAt: '2026-09-02T00:00:00.000Z'
      }
    });

    // The whole point: six to fourteen seconds of reading, not done.
    expect(probeSource).not.toHaveBeenCalled();
    expect(detectStitching).not.toHaveBeenCalled();
    // And the run works on the copy in front of it, not on the path the record remembers.
    expect(staging.mock.calls[0]?.[0]).toMatchObject({
      request: { profile: { path: input } }
    });
    expect((await stat(result.file)).size).toBeGreaterThan(0);
  });

  it('looks for itself when nobody has, and hands back what it found', async () => {
    const input = await source();
    const result = await run(input, { defaults, prepared: null });

    expect(probeSource).toHaveBeenCalledTimes(1);
    expect(detectStitching).toHaveBeenCalledTimes(1);
    // Handed back rather than written anywhere: the bridge does not talk to the cloud.
    expect(result.discovered).toMatchObject({
      detectedStartSeconds: 0.033333,
      detectedEndSeconds: 1800
    });
  });

  it('treats a record it cannot trust as no record at all', async () => {
    const input = await source();
    // A wrong preparation makes a wrong file, so anything doubtful is re-derived.
    await run(input, { defaults, prepared: { materialId: 'm', driveVersion: '' } });
    expect(probeSource).toHaveBeenCalledTimes(1);
  });

  it('refuses a material the fast path cannot serve, and says which', async () => {
    const input = await source('hevc.mp4');
    await expect(
      run(input, {
        defaults,
        prepared: {
          materialId: 'material-2',
          driveVersion: '7',
          detectedStartSeconds: 0,
          detectedEndSeconds: 0,
          profile: profile(input),
          unsupportedReason: 'video-codec',
          preparedAt: '2026-09-02T00:00:00.000Z'
        }
      })
    ).rejects.toThrow('UNSUPPORTED_MEDIA');
    // A refusal that was already known costs nothing to repeat.
    expect(probeSource).not.toHaveBeenCalled();
  });

  it('says there is nothing to remove rather than calling the file unsupported', async () => {
    const input = await source();
    detectStitching.mockResolvedValue({ startSeconds: 0, endSeconds: 0, adjustedByUser: false });
    await expect(
      run(input, { defaults: { ...defaults, operation: 'unstitch' }, prepared: null })
    ).rejects.toThrow('WRONG_STATE');
  });

  it('will not run at all against a space that is not configured', async () => {
    const input = await source();
    await expect(run(input, { defaults: { ...defaults, configured: false } })).rejects.toThrow(
      'INVALID_INPUT'
    );
  });

  it('reports a stop as a stop rather than as a failure', async () => {
    const input = await source();
    staging.mockResolvedValueOnce({ ok: false, error: 'STITCH_CANCELLED' } as never);
    await expect(run(input, { defaults, prepared: null })).rejects.toThrow('PROCESS_CANCELED');
  });

  it('leaves the member’s own file exactly as it was', async () => {
    const input = await source();
    const before = await sha256(input);
    await run(input, { defaults, prepared: null });
    // The one guarantee this cannot be forgiven for breaking (FR-024, SC-008).
    expect(await sha256(input)).toBe(before);
  });
});

describe('the photos a space draws from', () => {
  it('ignores an image this machine does not have', async () => {
    const input = await source();
    await run(input, {
      defaults: { ...defaults, endImageIds: ['end-a', 'a-photo-from-another-machine'] },
      prepared: null
    });
    const screens = staging.mock.calls[0]?.[0].request.screens;
    // Drawn from what is here; a missing id drops out rather than failing the delivery.
    expect(screens.endImageId).toBe('end-a');
  });

  it('asks for no screens at all when the space removes stitching', async () => {
    const input = await source();
    // Edges that leave a body behind — a detection longer than the file is not a detection.
    detectStitching.mockResolvedValue({
      startSeconds: 0.033333,
      endSeconds: 30,
      adjustedByUser: false
    });
    await run(input, { defaults: { ...defaults, operation: 'unstitch' }, prepared: null });
    const screens = staging.mock.calls[0]?.[0].request.screens;
    expect(screens.startImageId).toBeNull();
    expect(screens.endImageId).toBeNull();
  });
});

/** Keeps the workspace tidy even when a test throws before its own cleanup. */
afterEach(async () => {
  await rm(path.join(workspace, 'result.mp4'), { force: true }).catch(() => undefined);
});
