import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImageAsset } from '../packages/shared/src/types.js';
import { EstimateCache, estimateCacheKey } from '../apps/agent/src/estimate/cache.js';
import { EstimationWorker } from '../apps/agent/src/estimate/worker.js';
import { ImageAssetStore } from '../apps/agent/src/images/store.js';
import { makeJob, optimalEncoding } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('embedded static-section estimation', () => {
  it('runs one sequential static sample and does not apply dynamic bitrate to the whole final image', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'embedding estimate '));
    const video = path.join(directory, 'dynamic.mp4');
    const imageRoot = path.join(directory, 'images');
    await mkdir(imageRoot, { recursive: true });
    const asset = imageAsset();
    expect(await createVideo(video)).toBe(0);
    expect(await createImage(path.join(imageRoot, `${asset.id}.png`))).toBe(0);
    const info = await stat(video);
    const job = makeJob('embedded-estimate', 'ready', {
      inputPath: video,
      outputPath: path.join(directory, 'out.mp4'),
      originalSize: info.size,
      durationSeconds: 1,
      sourceWidth: 320,
      sourceHeight: 180,
      sourceFrameRate: 24,
      sourceHasAudio: false,
      imageEmbedding: {
        startImage: null,
        endImage: asset,
        finalDurationMode: 'custom',
        finalDurationSeconds: 120,
        fitMode: 'contain'
      }
    });
    const progressTotals: number[] = [];
    const worker = new EstimationWorker(
      () => [job],
      (_id, patch) => {
        Object.assign(job, patch);
        if (patch.estimateProgress) progressTotals.push(patch.estimateProgress.total);
      },
      () => false,
      new EstimateCache(path.join(directory, 'cache.json')),
      new ImageAssetStore(imageRoot)
    );
    await worker.init();
    await until(() => ['estimated', 'unavailable'].includes(job.estimateStatus));
    await worker.shutdown();
    expect(job.estimateStatus, job.estimateError ?? '').toBe('estimated');
    expect(job.estimateBreakdown?.staticVideoBytesPerSecond).toBeGreaterThan(0);
    expect(job.estimateBreakdown?.dynamicVideoBytesPerSecond).toBeGreaterThan(
      job.estimateBreakdown?.staticVideoBytesPerSecond ?? Infinity
    );
    expect(job.estimateBreakdown?.audioBytesPerSecond).toBe(12_000);
    expect(progressTotals).toContain(2);
    const naiveDynamicEstimate =
      (job.estimateBreakdown?.dynamicVideoBytesPerSecond ?? 0) * 121 + 12_000 * 121;
    expect(job.estimatedOutputBytes).toBeLessThan(naiveDynamicEstimate * 0.6);
  }, 20_000);

  it('invalidates the cache key for image, fit and frozen-duration changes', () => {
    const asset = imageAsset();
    const embedding = {
      startImage: null,
      endImage: asset,
      finalDurationMode: 'custom' as const,
      finalDurationSeconds: 60,
      fitMode: 'cover' as const
    };
    const base = estimateCacheKey('/video', 10, 20, optimalEncoding, embedding);
    expect(
      estimateCacheKey('/video', 10, 20, optimalEncoding, {
        ...embedding,
        finalDurationSeconds: 61
      })
    ).not.toBe(base);
    expect(
      estimateCacheKey('/video', 10, 20, optimalEncoding, { ...embedding, fitMode: 'contain' })
    ).not.toBe(base);
    expect(
      estimateCacheKey('/video', 10, 20, optimalEncoding, {
        ...embedding,
        endImage: { ...asset, id: '55555555-5555-4555-8555-555555555555' }
      })
    ).not.toBe(base);
  });
});

function imageAsset(): ImageAsset {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    fileName: 'static.png',
    width: 200,
    height: 100,
    size: 100,
    mimeType: 'image/png',
    extension: '.png'
  };
}

function createVideo(file: string) {
  return run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-an',
    file
  ]);
}

function createImage(file: string) {
  return run([
    '-f',
    'lavfi',
    '-i',
    'color=c=#39434d:size=200x100',
    '-frames:v',
    '1',
    '-threads',
    '1',
    file
  ]);
}

function run(args: string[]) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      shell: false
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
