import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CompressionJob } from '../packages/shared/src/types.js';
import { EstimateCache, estimateCacheKey } from '../apps/agent/src/estimate/cache.js';
import { createSamplePlan, estimateFromSamples } from '../apps/agent/src/estimate/sampler.js';
import { EstimationWorker } from '../apps/agent/src/estimate/worker.js';
import { customEncoding, makeJob, optimalEncoding } from './helpers.js';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('estimate planning and cache', () => {
  it('samples long videos across the whole timeline and keeps short points valid', () => {
    const points = createSamplePlan(3600);
    expect(points).toHaveLength(8);
    expect(points[0].start).toBe(0);
    expect(points.at(-1)!.start).toBeCloseTo(3595);
    for (const duration of [0.2, 2, 8, 15]) {
      for (const point of createSamplePlan(duration)) {
        expect(point.start).toBeGreaterThanOrEqual(0);
        expect(point.duration).toBeGreaterThan(0);
        expect(point.start + point.duration).toBeLessThanOrEqual(duration + 0.001);
      }
    }
  });

  it('includes every active encoding parameter in the cache key', () => {
    const base = estimateCacheKey('/a', 10, 20, optimalEncoding);
    expect(estimateCacheKey('/b', 10, 20, optimalEncoding)).not.toBe(base);
    expect(estimateCacheKey('/a', 11, 20, optimalEncoding)).not.toBe(base);
    expect(estimateCacheKey('/a', 10, 21, optimalEncoding)).not.toBe(base);
    expect(estimateCacheKey('/a', 10, 20, customEncoding)).not.toBe(base);
    expect(
      estimateCacheKey('/a', 10, 20, {
        ...customEncoding,
        rateControl: 'bitrate',
        videoBitrateKbps: 2000
      })
    ).not.toBe(estimateCacheKey('/a', 10, 20, customEncoding));
  });

  it('creates an honest range and reports a larger forecast as a negative saving', () => {
    const estimate = estimateFromSamples([100, 200, 100], [1, 1, 1], 10, 0, 5000)!;
    expect(estimate.estimateRangeMinBytes).toBeLessThan(estimate.estimatedOutputBytes);
    expect(estimate.estimateRangeMaxBytes).toBeGreaterThan(estimate.estimatedOutputBytes);
    expect(estimateFromSamples([1000], [1], 10, 0, 100)!.estimatedSavingPercent).toBeLessThan(0);
  });
});

describe('sequential estimation worker', () => {
  it('estimates ten jobs strictly one at a time and exposes the estimating state', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'estimate-worker-'));
    const source = path.join(directory, 'source.mp4');
    expect(await makeVideo(source, 0.25, '96x54', 5)).toBe(0);
    const jobs: CompressionJob[] = [];
    for (let index = 0; index < 10; index++) {
      const file = path.join(directory, `clip-${index}.mp4`);
      await copyFile(source, file);
      jobs.push(makeEstimationJob(String(index), file));
    }
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const worker = new EstimationWorker(
      () => jobs,
      (id, patch, event) => {
        Object.assign(
          jobs.find(job => job.id === id)!,
          patch
        );
        if (event === 'estimate:started') {
          active++;
          maxActive = Math.max(maxActive, active);
          order.push(id);
          expect(jobs.find(job => job.id === id)!.estimateStatus).toBe('estimating');
        }
        if (['estimate:completed', 'estimate:failed', 'estimate:cancelled'].includes(event))
          active--;
      },
      () => false,
      new EstimateCache(path.join(directory, 'cache.json'))
    );
    await worker.init();
    try {
      await until(
        () => jobs.every(job => ['estimated', 'unavailable'].includes(job.estimateStatus)),
        60_000
      );
      expect(maxActive).toBe(1);
      expect(order).toEqual(Array.from({ length: 10 }, (_, index) => String(index)));
    } finally {
      await worker.shutdown();
    }
  }, 90_000);

  it('cancels normal estimation before compression and resumes it later', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'estimate-pause-'));
    const source = path.join(directory, 'source.mp4');
    expect(await makeVideo(source, 3, '640x360', 24)).toBe(0);
    const jobs = [makeEstimationJob('pause', source)];
    const worker = new EstimationWorker(
      () => jobs,
      (id, patch) =>
        Object.assign(
          jobs.find(job => job.id === id)!,
          patch
        ),
      () => false,
      new EstimateCache(path.join(directory, 'cache.json'))
    );
    await worker.init();
    await until(() => jobs[0].estimateStatus === 'estimating');
    await worker.pause();
    expect(jobs[0].estimateStatus).toBe('cancelled');
    worker.resume();
    await until(() => ['estimated', 'unavailable'].includes(jobs[0].estimateStatus), 20_000);
    await worker.shutdown();
  }, 25_000);
});

describe('prioritized estimation', () => {
  it('runs queued priority estimates in FIFO order', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'estimate-priority-'));
    const source = path.join(directory, 'source.mp4');
    expect(await makeVideo(source, 0.25, '96x54', 5)).toBe(0);
    const jobs: CompressionJob[] = [];
    for (const id of ['later', 'first', 'regular']) {
      const file = path.join(directory, `${id}.mp4`);
      await copyFile(source, file);
      jobs.push(makeEstimationJob(id, file, 'queued'));
    }
    jobs[0].estimatePriorityOrder = 2;
    jobs[1].estimatePriorityOrder = 1;
    const order: string[] = [];
    const worker = new EstimationWorker(
      () => jobs,
      (id, patch, event) => {
        Object.assign(
          jobs.find(job => job.id === id)!,
          patch
        );
        if (event === 'estimate:started') order.push(id);
      },
      () => false,
      new EstimateCache(path.join(directory, 'cache.json'))
    );
    await worker.pause();
    await worker.init();
    await worker.runPrioritized();
    expect(order).toEqual(['first', 'later']);
    expect(jobs[2].estimateStatus).toBe('waiting');
    await worker.shutdown();
  }, 20_000);
});

function makeEstimationJob(id: string, inputPath: string, status: 'ready' | 'queued' = 'ready') {
  return makeJob(id, status, {
    inputPath,
    outputPath: `${inputPath}.out.mp4`,
    fileName: path.basename(inputPath),
    originalSize: 10_000,
    durationSeconds: null,
    sourceWidth: null,
    sourceHeight: null,
    sourceFrameRate: null,
    sourceBitrate: null,
    sourceCodec: null
  });
}

function makeVideo(file: string, duration: number, size: string, rate: number) {
  return new Promise<number | null>((resolve, reject) => {
    const process = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=${rate}`,
        '-t',
        String(duration),
        '-c:v',
        'libx264',
        '-an',
        file
      ],
      { shell: false }
    );
    process.on('error', reject);
    process.on('close', resolve);
  });
}

async function until(check: () => boolean, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
