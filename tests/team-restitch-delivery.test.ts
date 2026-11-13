import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageEmbeddingSettings } from '../packages/shared/src/types.js';
import type { TeamRestitchDefaults } from '../packages/shared/src/team/restitch.js';
import { ScreenCacheError } from '../apps/agent/src/team-bridge/screen-cache.js';
import type {
  ScreenRecoveryProvider,
  ScreenRecoveryCandidate
} from '../apps/agent/src/team-bridge/screen-recovery.js';
import {
  clearRestitchInspections,
  createRestitchDelegate,
  type RestitchDelegateDiscovery
} from '../apps/agent/src/team-bridge/restitch.js';
import type { ToolResult, runTool as runToolType } from '../apps/agent/src/stitcher/run.js';
import { diagnostics } from '../apps/agent/src/server/diagnostics-log.js';
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
const runTool = vi.hoisted(() => vi.fn<typeof runToolType>());
vi.mock('../apps/agent/src/stitcher/run.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/stitcher/run.js')>();
  return { ...actual, runTool };
});

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
  sourceMode: 'legacy',
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
const staging = vi.fn(
  async (context: {
    workDir: string;
    request: { screens: { startImageId: string | null; endImageId: string | null } };
  }) => {
    const staged = path.join(context.workDir, 'result.mp4');
    await writeFile(staged, 'stitched');
    return { ok: true as const, stagedPath: staged, verification: null as never };
  }
);

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

function run(
  input: string,
  options: unknown,
  signal = new AbortController().signal,
  checksum: string | null = null
) {
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
    sourceChecksum: checksum,
    options,
    signal,
    onProgress: () => {},
    pausable: () => {}
  });
}

beforeEach(async () => {
  clearRestitchInspections();
  workspace = await mkdtemp(path.join(os.tmpdir(), 'restitch-delivery-'));
  runTool.mockReset();
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
  it.each([
    ['BODY_HEAD_FAILED', 'BODY_HEAD_FAILED'],
    ['/private/media/source.mp4 provider detail', 'PROCESS_FAILED']
  ])('reports a bounded media failure from %s as %s', async (failure, code) => {
    const record = vi.spyOn(diagnostics, 'record');
    const input = await source();
    staging.mockResolvedValueOnce({ ok: false, error: failure } as never);
    await expect(run(input, { defaults, prepared: null })).rejects.toThrow(code);
    expect(record).toHaveBeenCalledWith('stitcher', 'pipeline_failed', {
      errorCode: code,
      runId: 'op-1'
    });
  });

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

  it('reuses verified content inspection across workspaces without reusing their file paths', async () => {
    const first = await source('first-copy.mp4');
    const second = await source('second-copy.mp4');
    const checksum = 'a'.repeat(32);
    const result = await run(first, { defaults, prepared: null }, undefined, checksum);
    (result.discovered as RestitchDelegateDiscovery).profile.width = 1;
    const reused = await run(second, { defaults, prepared: null }, undefined, checksum);
    expect(probeSource).toHaveBeenCalledTimes(1);
    expect(detectStitching).toHaveBeenCalledTimes(1);
    expect(reused.discovered).toMatchObject({ profile: { path: second, width: 1080 } });
  });

  it('bounds the inspection cache and keeps a recently used source when older entries expire', async () => {
    const input = await source();
    const key = (n: number) => n.toString(16).padStart(32, '0');
    const inspect = (n: number) => run(input, { defaults, prepared: null }, undefined, key(n));
    for (let n = 0; n < 16; n++) await inspect(n);
    await inspect(0);
    expect(probeSource).toHaveBeenCalledTimes(16);
    await inspect(16);
    await inspect(0);
    expect(probeSource).toHaveBeenCalledTimes(17);
    await inspect(1);
    expect(probeSource).toHaveBeenCalledTimes(18);
    clearRestitchInspections();
    await inspect(0);
    expect(probeSource).toHaveBeenCalledTimes(19);
  });

  it('keeps a missing screen selection distinct from an unsupported source', async () => {
    const input = await source();
    await expect(
      run(input, {
        defaults: {
          ...defaults,
          startImageIds: ['missing-start'],
          endImageIds: ['missing-end']
        },
        prepared: null
      })
    ).rejects.toMatchObject({ message: 'INVALID_INPUT', reason: 'no-screens' });
    probeSource.mockResolvedValueOnce({
      ok: true,
      value: { ...profile(input), variableFrameRate: true }
    });
    await expect(run(input, { defaults, prepared: null })).rejects.toMatchObject({
      message: 'UNSUPPORTED_MEDIA',
      reason: 'variable-frame-rate'
    });
    expect(staging).not.toHaveBeenCalled();
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

describe('automatic source end-frame safety', () => {
  const exit = (code: number): ToolResult => ({
    code,
    stdout: '',
    stderr: '',
    spawnErrorCode: null,
    cancelled: false
  });
  it.each([false, true])(
    'does not enter stitching after extraction fails (cancelled=%s)',
    async cancelled => {
      const input = await source();
      const journal = vi.spyOn(diagnostics, 'record').mockReturnValue(true);
      const controller = new AbortController();
      if (cancelled) controller.abort();
      runTool.mockResolvedValue(exit(1));
      await expect(
        run(
          input,
          { defaults: { ...defaults, automaticEndFrame: true }, prepared: null },
          controller.signal
        )
      ).rejects.toThrow(cancelled ? 'PROCESS_CANCELED' : 'PROCESS_FAILED');
      expect(staging).not.toHaveBeenCalled();
      expect(journal).toHaveBeenCalledWith('stitcher', 'automatic_frame_failed', {
        runId: 'op-1',
        cancelled
      });
      expect(journal.mock.calls.some(([, code]) => code === 'automatic_frame_completed')).toBe(
        false
      );
    }
  );
  it.each(['absent', 'empty'] as const)(
    'refuses an extraction success receipt with an %s image',
    async state => {
      const input = await source();
      const journal = vi.spyOn(diagnostics, 'record').mockReturnValue(true);
      runTool.mockImplementation(async () => {
        if (state === 'empty') await writeFile(path.join(workspace, 'launch-end-frame.png'), '');
        return exit(0);
      });
      await expect(
        run(input, { defaults: { ...defaults, automaticEndFrame: true }, prepared: null })
      ).rejects.toThrow('PROCESS_FAILED');
      expect(staging).not.toHaveBeenCalled();
      expect(journal).toHaveBeenCalledWith('stitcher', 'automatic_frame_failed', {
        runId: 'op-1',
        cancelled: false
      });
    }
  );
  it.each([0, 30])(
    'hands the extracted frame to stitching with bounded decoding for detected end %ss',
    async endSeconds => {
      const input = await source();
      detectStitching.mockResolvedValue({ startSeconds: 0, endSeconds, adjustedByUser: false });
      const journal = vi.spyOn(diagnostics, 'record').mockReturnValue(true);
      runTool.mockImplementation(async () => {
        await writeFile(path.join(workspace, 'launch-end-frame.png'), 'frame-bytes');
        return exit(0);
      });
      await run(input, { defaults: { ...defaults, automaticEndFrame: true }, prepared: null });
      const args = runTool.mock.calls[0]?.[1];
      expect(args).toContain(endSeconds ? '-frames:v' : '-update');
      expect(args).not.toContain(endSeconds ? '-update' : '-frames:v');
      expect(staging.mock.calls[0]?.[0].request.screens).toMatchObject({
        startImageId: null,
        endImageId: 'launch-source-end-frame'
      });
      expect(journal).toHaveBeenCalledWith('stitcher', 'automatic_frame_completed', {
        runId: 'op-1'
      });
    }
  );
});

describe('one requested delivery with protected image recovery', () => {
  const id = (n: number) => 'b1800000-0000-4000-8000-' + String(n).padStart(12, '0');
  function candidate(slot: 'start' | 'end', n: number): ScreenRecoveryCandidate {
    return {
      versionId: id(n),
      acquisition: 0,
      screen: {
        slot,
        materialId: id(n + 10),
        checksum: 'a'.repeat(32),
        mimeType: 'image/png',
        sizeBytes: 4,
        fileName: 'fixture.png',
        transfer: null
      }
    };
  }
  async function delivery(
    provider: ScreenRecoveryProvider,
    signal = new AbortController().signal,
    withDrawn = true
  ) {
    const cache = {
      resolve: vi.fn(async () => {
        throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
      }),
      pathFor: () => path.join(workspace, 'healthy.png'),
      evict: vi.fn(async () => 0)
    };
    const screenRecovery = vi.fn(async () => provider);
    const delegate = createRestitchDelegate({
      embedding: () => library,
      imagePathFor: async () => null,
      screenCache: cache as never,
      pipeline: staging as never,
      screenRecovery
    });
    const sourceFile = await source();
    const result = delegate({
      operationId: id(1),
      teamId: id(2),
      workspace,
      sourceFile,
      sourceSizeBytes: 1000,
      sourceVersion: '7',
      sourceChecksum: null,
      options: {
        defaults: { ...defaults, sourceMode: 'drive', startEnabled: true, endEnabled: true },
        screens: withDrawn ? [candidate('start', 3).screen, candidate('end', 4).screen] : null,
        teamId: id(2)
      },
      signal,
      onProgress: () => {},
      pausable: () => {}
    });
    return { result, cache, screenRecovery };
  }
  it('keeps the healthy first slot and replaces a broken second image before invoking the pipeline once', async () => {
    const first = candidate('start', 3),
      bad = candidate('end', 4),
      healthy = candidate('end', 5);
    let end = 0;
    const provider: ScreenRecoveryProvider = {
      next: vi.fn<ScreenRecoveryProvider['next']>(async slot => ({
        kind: 'candidate',
        candidate: slot === 'start' ? first : ++end === 1 ? bad : healthy
      })),
      resolve: vi.fn(async c => {
        if (c.versionId === bad.versionId)
          throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
        return {
          candidate: c,
          resolved: {
            slot: c.screen.slot,
            id: c.versionId,
            path: path.join(workspace, 'healthy.png')
          }
        };
      }),
      reject: vi.fn(async () => {}),
      accept: vi.fn(async () => {}),
      refresh: vi.fn(async c => c)
    };
    const f = await delivery(provider);
    const output = await f.result;
    expect(await readFile(output.file, 'utf8')).toBe('stitched');
    expect(staging).toHaveBeenCalledTimes(1);
    expect(staging.mock.calls[0]![0].request.screens).toMatchObject({
      startImageId: first.versionId,
      endImageId: healthy.versionId
    });
    expect(provider.reject).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: bad.versionId }),
      'unsupported',
      expect.any(AbortSignal)
    );
    expect(provider.accept).toHaveBeenCalledTimes(2);
    expect(provider.next).toHaveBeenCalledTimes(3);
    expect(f.cache.resolve).not.toHaveBeenCalled();
  });
  it('uses the trusted frozen slot settings without browser-drawn image placeholders', async () => {
    const provider: ScreenRecoveryProvider = {
      next: vi.fn<ScreenRecoveryProvider['next']>(async slot => ({
        kind: 'candidate',
        candidate: candidate(slot, slot === 'start' ? 3 : 4)
      })),
      resolve: vi.fn(async c => ({
        candidate: c,
        resolved: {
          slot: c.screen.slot,
          id: c.versionId,
          path: path.join(workspace, 'healthy.png')
        }
      })),
      reject: vi.fn(),
      accept: vi.fn(async () => {}),
      refresh: vi.fn()
    };
    const f = await delivery(provider, new AbortController().signal, false);
    await f.result;
    expect(provider.next).toHaveBeenCalledTimes(2);
    expect(staging.mock.calls[0]![0].request.screens).toMatchObject({
      startImageId: candidate('start', 3).versionId,
      endImageId: candidate('end', 4).versionId
    });
    expect(f.cache.resolve).not.toHaveBeenCalled();
  });
  it('reports a fully exhausted image pool without starting the video pipeline or generic download', async () => {
    const provider: ScreenRecoveryProvider = {
      next: vi.fn<ScreenRecoveryProvider['next']>(async () => ({
        kind: 'exhausted',
        reason: 'unusable',
        complete: true
      })),
      resolve: vi.fn(),
      reject: vi.fn(),
      accept: vi.fn(),
      refresh: vi.fn()
    };
    const f = await delivery(provider);
    await expect(f.result).rejects.toThrow('RESTITCH_SCREEN_CANDIDATES_EXHAUSTED');
    expect(staging).not.toHaveBeenCalled();
    expect(f.cache.resolve).not.toHaveBeenCalled();
  });
  it('does not start video processing after cancellation while persisting a rejected image', async () => {
    const controller = new AbortController();
    const provider: ScreenRecoveryProvider = {
      next: vi.fn<ScreenRecoveryProvider['next']>(async () => ({
        kind: 'candidate',
        candidate: candidate('start', 3)
      })),
      resolve: vi.fn(async () => {
        throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
      }),
      reject: vi.fn(async () => {
        controller.abort();
      }),
      accept: vi.fn(),
      refresh: vi.fn()
    };
    const f = await delivery(provider, controller.signal);
    await expect(f.result).rejects.toBeTruthy();
    expect(provider.reject).toHaveBeenCalledTimes(1);
    expect(provider.next).toHaveBeenCalledTimes(1);
    expect(staging).not.toHaveBeenCalled();
    expect(f.cache.resolve).not.toHaveBeenCalled();
  });
});
