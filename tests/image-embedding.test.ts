import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultImageEmbeddingSettings,
  finalImageDurationRange,
  randomFinalImageDurationSeconds,
  type ImageAsset,
  type JobImageEmbedding
} from '../packages/shared/src/types.js';
import {
  freezeImageEmbedding,
  outputDurationSeconds,
  refreshEstimateFromBreakdown
} from '../apps/agent/src/images/embedding.js';
import {
  buildEmbeddedFfmpegArgs,
  imageAdaptationFilter
} from '../apps/agent/src/ffmpeg/presets.js';
import { calculateEncodeProgress } from '../apps/agent/src/ffmpeg/encoder.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { makeJob, optimalEncoding, optimalSettings } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('final image duration configuration', () => {
  it('generates inclusive values inside all three minute ranges', () => {
    for (const mode of ['random-30-40', 'random-40-50', 'random-50-60'] as const) {
      const [minimum, maximum] = finalImageDurationRange(mode);
      expect(randomFinalImageDurationSeconds(mode, () => 0)).toBe(minimum);
      expect(randomFinalImageDurationSeconds(mode, () => 0.999999999)).toBe(maximum);
      expect(randomFinalImageDurationSeconds(mode, () => 0.5)).toBeGreaterThanOrEqual(minimum);
      expect(randomFinalImageDurationSeconds(mode, () => 0.5)).toBeLessThanOrEqual(maximum);
    }
  });

  it('freezes custom and random values without requiring both images', () => {
    const endOnly = {
      ...defaultImageEmbeddingSettings(),
      enabled: true,
      endImage: asset('end'),
      finalDurationMode: 'random-40-50' as const
    };
    expect(freezeImageEmbedding(endOnly, () => 0.25)?.finalDurationSeconds).toBe(2550);
    expect(
      freezeImageEmbedding(
        { ...endOnly, finalDurationMode: 'custom', customFinalDurationSeconds: 3723 },
        () => 0.9
      )?.finalDurationSeconds
    ).toBe(3723);
    expect(
      freezeImageEmbedding({ ...endOnly, endImage: null, startImage: asset('start') })
    ).toMatchObject({ startImage: { id: asset('start').id }, endImage: null });
  });

  it('assigns a separate frozen random duration to every queued job', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding-freeze-'));
    const imageStore = new ImageAssetStore(path.join(directory, 'images'));
    const settings = {
      ...optimalSettings,
      outputMode: 'chosen-folder' as const,
      outputFolder: directory,
      imageEmbedding: {
        ...defaultImageEmbeddingSettings(),
        enabled: true,
        endImage: asset('end'),
        finalDurationMode: 'random-40-50' as const
      }
    };
    const values = [0.1, 0.9];
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [
        makeJob('first', 'ready', { inputPath: path.join(directory, 'missing-first.mp4') }),
        makeJob('second', 'ready', { inputPath: path.join(directory, 'missing-second.mp4') })
      ],
      settings,
      null,
      imageStore,
      () => values.shift() ?? 0.5
    );
    expect(await queue.start(['first', 'second'])).toBe(true);
    const [first, second] = queue.state().jobs;
    expect(first.imageEmbedding?.finalDurationSeconds).toBe(2460);
    expect(second.imageEmbedding?.finalDurationSeconds).toBe(2940);
    expect(first.imageEmbedding?.finalDurationSeconds).not.toBe(
      second.imageEmbedding?.finalDurationSeconds
    );
    await queue.updateSettings({
      imageEmbedding: { ...settings.imageEmbedding, fitMode: 'stretch' }
    });
    expect(queue.state().jobs[1].imageEmbedding?.fitMode).toBe('cover');
    await until(() => !queue.state().running);
  });

  it('clears a persisted image that is no longer available to the agent', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding-missing-image-'));
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [],
      {
        ...optimalSettings,
        imageEmbedding: {
          ...defaultImageEmbeddingSettings(),
          enabled: true,
          startImage: asset('start')
        }
      },
      null,
      new ImageAssetStore(path.join(directory, 'missing-images'))
    );
    await queue.revalidateSettingsImages();
    expect(queue.state().settings.imageEmbedding).toMatchObject({
      enabled: true,
      startImage: null
    });
    expect(queue.embeddingConfigurationError()).toBe('EMBED_IMAGES_REQUIRED');
  });
});

describe('embedded output model and FFmpeg graph', () => {
  it('uses the full output duration for progress while estimating static video separately', () => {
    const embedding: JobImageEmbedding = {
      startImage: asset('start'),
      endImage: asset('end'),
      finalDurationMode: 'custom',
      finalDurationSeconds: 100,
      fitMode: 'cover'
    };
    const job = makeJob('estimate', 'ready', {
      durationSeconds: 10,
      sourceFrameRate: 25,
      imageEmbedding: embedding,
      estimateBreakdown: {
        dynamicVideoBytesPerSecond: 1000,
        staticVideoBytesPerSecond: 20,
        audioBytesPerSecond: 10,
        uncertainty: 0.2
      }
    });
    expect(outputDurationSeconds(job)).toBeCloseTo(110.04, 5);
    expect(refreshEstimateFromBreakdown(job)).toBe(true);
    expect(job.estimatedOutputBytes).toBeLessThan(20_000);
    expect(job.estimatedOutputBytes).toBeGreaterThan(14_000);
    expect(calculateEncodeProgress(10_000_000, outputDurationSeconds(job))).toBeCloseTo(9.09, 1);
    expect(calculateEncodeProgress(110_040_000, outputDurationSeconds(job))).toBe(99.9);
    expect(calculateEncodeProgress(Number.NaN, outputDurationSeconds(job))).toBeNull();
  });

  it('builds real cover, contain and stretch filters with compatible output parameters', () => {
    expect(imageAdaptationFilter(1080, 1920, 'cover')).toContain(
      'force_original_aspect_ratio=increase'
    );
    expect(imageAdaptationFilter(1080, 1920, 'cover')).toContain('crop=1080:1920');
    expect(imageAdaptationFilter(1920, 1080, 'contain')).toContain(
      'force_original_aspect_ratio=decrease'
    );
    expect(imageAdaptationFilter(1920, 1080, 'contain')).toContain('pad=1920:1080');
    expect(imageAdaptationFilter(1080, 1080, 'stretch')).toContain('scale=1080:1080');
    for (const mode of ['cover', 'contain', 'stretch'] as const) {
      const filter = imageAdaptationFilter(640, 360, mode);
      expect(filter).toContain('setsar=1');
      expect(filter).toContain('format=yuv420p');
    }
  });

  it('keeps special paths as individual arguments and uses one filter graph/encode', () => {
    const startPath = '/tmp/кадр $(touch nope); &.png';
    const endPath = '/tmp/final image.webp';
    const args = buildEmbeddedFfmpegArgs({
      input: '/tmp/відео file.mp4',
      output: '/tmp/result embedded.mp4',
      sourceDurationSeconds: 2,
      sourceHasAudio: false,
      width: 640,
      height: 360,
      frameRate: 24,
      settings: optimalEncoding,
      imageEmbedding: {
        startImage: asset('start'),
        endImage: asset('end'),
        finalDurationMode: 'custom',
        finalDurationSeconds: 3,
        fitMode: 'cover'
      },
      startImagePath: startPath,
      endImagePath: endPath
    });
    expect(args).toContain(startPath);
    expect(args).toContain(endPath);
    expect(args.filter(value => value === '-filter_complex')).toHaveLength(1);
    expect(args.filter(value => value === '-c:v')).toHaveLength(1);
    expect(args.join(' ')).toContain('trim=duration=0.041666667');
    expect(args.join(' ')).toContain('anullsrc=r=48000:cl=stereo');
    expect(args).toContain('[vout]');
    expect(args).toContain('[aout]');
  });
});

function asset(name: string): ImageAsset {
  const hex = name === 'start' ? '1' : '2';
  return {
    id: `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-8${hex.repeat(3)}-${hex.repeat(12)}`,
    fileName: `${name}.png`,
    width: 640,
    height: 360,
    size: 100,
    mimeType: 'image/png',
    extension: '.png'
  };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
