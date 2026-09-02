import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
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
  buildHeldScreenArgs,
  heldFinalImageSeconds,
  imageAdaptationFilter
} from '../apps/agent/src/ffmpeg/presets.js';
import { calculateEncodeProgress } from '../apps/agent/src/ffmpeg/encoder.js';
import { JobQueue } from '../apps/agent/src/queue/queue.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import {
  makeEmbedding,
  makeEmbeddingSettings,
  makeJob,
  optimalEncoding,
  optimalSettings
} from './helpers.js';
import { waitFor } from './support/wait.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

let directory = '';
afterEach(async () => {
  if (directory) await removeTemporaryDirectory(directory);
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
      endImages: [asset('end')],
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
      freezeImageEmbedding({ ...endOnly, endImages: [], startImages: [asset('start')] })
    ).toMatchObject({ startImage: { id: asset('start').id }, endImage: null });
  });

  it('assigns a separate frozen random duration to every queued job', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding-freeze-'));
    const imageStore = new ImageAssetStore(path.join(directory, 'images'));
    const settings = {
      ...optimalSettings,
      outputMode: 'chosen-folder' as const,
      outputFolder: directory,
      imageEmbedding: makeEmbeddingSettings({
        ...defaultImageEmbeddingSettings(),
        enabled: true,
        endImages: [asset('end')],
        finalDurationMode: 'random-40-50' as const
      })
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
      imageEmbedding: makeEmbeddingSettings({ ...settings.imageEmbedding, fitMode: 'stretch' })
    });
    expect(queue.state().jobs[1].imageEmbedding?.fitMode).toBe('cover');
    await waitFor(() => !queue.state().running, {
      timeoutMs: 3_000,
      describe: 'the queue to go idle'
    });
  });

  it('keeps estimated replacement trims when image choices are frozen for the queue', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding-replacement-trims-'));
    const image = asset('end');
    const settings = {
      ...optimalSettings,
      outputMode: 'chosen-folder' as const,
      outputFolder: directory,
      imageEmbedding: makeEmbeddingSettings({
        ...defaultImageEmbeddingSettings(),
        enabled: true,
        endImages: [image],
        replaceExisting: true,
        finalDurationMode: 'custom' as const,
        customFinalDurationSeconds: 60
      })
    };
    const job = makeJob('replacement-trims', 'ready', {
      inputPath: path.join(directory, 'missing.mp4'),
      durationSeconds: 100,
      imageEmbedding: makeEmbedding({
        startImage: null,
        endImage: image,
        finalDurationMode: 'custom',
        finalDurationSeconds: 60,
        fitMode: 'cover',
        replaceExisting: true,
        sourceTrimStartSeconds: 10,
        sourceTrimEndSeconds: 40
      })
    });
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [job],
      settings,
      null,
      new ImageAssetStore(path.join(directory, 'images'))
    );

    expect(await queue.start([job.id])).toBe(true);
    const queued = queue.state().jobs[0];
    expect(queued.imageEmbedding).toMatchObject({
      sourceTrimStartSeconds: 10,
      sourceTrimEndSeconds: 40
    });
    expect(outputDurationSeconds(queued)).toBe(110);
    await waitFor(() => !queue.state().running, {
      timeoutMs: 3_000,
      describe: 'the queue to go idle'
    });
  });

  it('draws each image once before refreshing the random pool', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding-image-pool-'));
    const images = [poolAsset('3'), poolAsset('4'), poolAsset('5')];
    const jobs = ['one', 'two', 'three', 'four'].map(id =>
      makeJob(id, 'ready', { inputPath: path.join(directory, `missing-${id}.mp4`) })
    );
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      jobs,
      {
        ...optimalSettings,
        outputMode: 'chosen-folder',
        outputFolder: directory,
        imageEmbedding: makeEmbeddingSettings({
          ...defaultImageEmbeddingSettings(),
          enabled: true,
          startImages: images
        })
      },
      null,
      new ImageAssetStore(path.join(directory, 'images')),
      () => 0.999999
    );

    expect(await queue.start(jobs.map(job => job.id))).toBe(true);
    const selected = queue.state().jobs.map(job => job.imageEmbedding?.startImage?.id);
    expect(new Set(selected.slice(0, 3))).toEqual(new Set(images.map(image => image.id)));
    expect(selected[3]).toBe(selected[0]);
    await waitFor(() => !queue.state().running, {
      timeoutMs: 3_000,
      describe: 'the queue to go idle'
    });
  });

  it('clears a persisted image that is no longer available to the agent', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding-missing-image-'));
    const queue = new JobQueue(
      { ffmpeg: true, ffprobe: true },
      () => {},
      [],
      {
        ...optimalSettings,
        imageEmbedding: makeEmbeddingSettings({
          ...defaultImageEmbeddingSettings(),
          enabled: true,
          startImages: [asset('start')]
        })
      },
      null,
      new ImageAssetStore(path.join(directory, 'missing-images'))
    );
    await queue.revalidateSettingsImages();
    expect(queue.state().settings.imageEmbedding).toMatchObject({
      enabled: true,
      startImages: []
    });
    expect(queue.embeddingConfigurationError()).toBe('EMBED_IMAGES_REQUIRED');
  });
});

describe('embedded output model and FFmpeg graph', () => {
  it('uses the full output duration for progress while estimating static video separately', () => {
    const embedding: JobImageEmbedding = makeEmbedding({
      startImage: asset('start'),
      endImage: asset('end'),
      finalDurationMode: 'custom',
      finalDurationSeconds: 100,
      fitMode: 'cover'
    });
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
    expect(outputDurationSeconds(job)).toBeCloseTo(110 + 1 / 30, 5);
    expect(refreshEstimateFromBreakdown(job)).toBe(true);
    expect(job.estimatedOutputBytes).toBeLessThan(20_000);
    expect(job.estimatedOutputBytes).toBeGreaterThan(14_000);
    expect(calculateEncodeProgress(10_000_000, outputDurationSeconds(job))).toBeCloseTo(9.09, 1);
    expect(calculateEncodeProgress(110_034_000, outputDurationSeconds(job))).toBe(99.9);
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

  it('builds a long final image as its own segment, and a short one inside the encode', () => {
    const held = makeEmbedding({
      endImage: asset('end'),
      finalDurationMode: 'custom',
      finalDurationSeconds: 45 * 60
    });
    // Long enough that a picture a second is fewer than a picture a frame: build it apart.
    expect(heldFinalImageSeconds(held, 30)).toBe(45 * 60);
    // A second and a half is a handful of frames either way, and a join costs two processes.
    expect(
      heldFinalImageSeconds(
        makeEmbedding({
          endImage: asset('end'),
          finalDurationMode: 'custom',
          finalDurationSeconds: 1.5
        }),
        30
      )
    ).toBeNull();
    expect(heldFinalImageSeconds(makeEmbedding({ endImage: null }), 30)).toBeNull();
  });

  it('spreads a held final image over a few hundred pictures', () => {
    const args = buildHeldScreenArgs({
      imagePath: '/tmp/end.png',
      output: '/tmp/screen.mp4',
      width: 720,
      height: 720,
      frameRate: 30,
      durationSeconds: 45 * 60,
      fitMode: 'cover',
      settings: optimalEncoding
    });
    const line = args.join(' ');
    /* Forty-five minutes at thirty frames a second is eighty-one thousand copies of one
       photograph — seven hundred seconds of encoding, measured. Three hundred pictures over
       the same time cost nothing and the run stops growing with the image. */
    expect(line).toContain('-framerate 0.111111111 -t 2700');
    expect(line).toContain('anullsrc=r=48000:cl=stereo:d=2700');
    /* No B-frames: a picture held nine seconds reorders decode against presentation by nine
       seconds, and the join then lands on a timestamp that has gone backwards. */
    expect(args[args.indexOf('-bf') + 1]).toBe('0');
    // Both halves of the join count time the same way.
    expect(args[args.indexOf('-video_track_timescale') + 1]).toBe('15360');
  });

  it('gives the body pass the join timescale and no final image', () => {
    const args = buildEmbeddedFfmpegArgs({
      input: '/tmp/creative.mp4',
      output: '/tmp/body.mp4',
      sourceStartSeconds: 0,
      sourceDurationSeconds: 120,
      sourceHasAudio: true,
      width: 720,
      height: 720,
      frameRate: 30,
      settings: optimalEncoding,
      imageEmbedding: makeEmbedding({
        endImage: asset('end'),
        finalDurationMode: 'custom',
        finalDurationSeconds: 45 * 60
      }),
      startImagePath: null,
      endImagePath: null,
      videoTrackTimescale: 15360
    });
    expect(args.join(' ')).not.toContain('[endv]');
    expect(args[args.indexOf('-video_track_timescale') + 1]).toBe('15360');
    // The body is still exactly what it always was.
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('cfr');
  });

  it('keeps special paths as individual arguments and uses one filter graph/encode', () => {
    const startPath = '/tmp/кадр $(touch nope); &.png';
    const endPath = '/tmp/final image.webp';
    const args = buildEmbeddedFfmpegArgs({
      input: '/tmp/відео file.mp4',
      output: '/tmp/result embedded.mp4',
      sourceStartSeconds: 0.25,
      sourceDurationSeconds: 2,
      sourceHasAudio: false,
      width: 640,
      height: 360,
      frameRate: 24,
      settings: optimalEncoding,
      imageEmbedding: makeEmbedding({
        startImage: asset('start'),
        endImage: asset('end'),
        finalDurationMode: 'custom',
        finalDurationSeconds: 3,
        fitMode: 'cover'
      }),
      startImagePath: startPath,
      endImagePath: endPath
    });
    expect(args).toContain(startPath);
    expect(args).toContain(endPath);
    expect(args.filter(value => value === '-filter_complex')).toHaveLength(1);
    expect(args.filter(value => value === '-c:v')).toHaveLength(1);
    expect(args.join(' ')).toContain('trim=duration=0.041666667');
    expect(args.join(' ')).toContain('trim=start=0.25:duration=2');
    expect(args.join(' ')).toContain('anullsrc=r=48000:cl=stereo');
    expect(args).toContain('[vout]');
    expect(args).toContain('[aout]');
    expect(args).toContain('-map_metadata');
    expect(args).toContain('-map_metadata:s');
    expect(args).toContain('-map_chapters');
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

function poolAsset(hex: string): ImageAsset {
  return {
    ...asset('start'),
    id: `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-8${hex.repeat(3)}-${hex.repeat(12)}`,
    fileName: `${hex}.png`
  };
}
