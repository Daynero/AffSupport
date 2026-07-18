import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EstimateCache } from '../apps/agent/src/estimate/cache.js';
import { EstimationWorker } from '../apps/agent/src/estimate/worker.js';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import { probeDuration } from '../apps/agent/src/ffmpeg/tools.js';
import { makeJob, optimalEncoding } from './helpers.js';

let directory = '';
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('estimate accuracy on representative synthetic videos', () => {
  it('compares estimates with full Optimal encodes', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'estimate-accuracy-'));
    const specifications = [
      ['dynamic', 4, 0],
      ['static', 0, 4],
      ['mixed', 2, 3],
      ['short', 0.6, 0],
      ['dynamic-start-static-end', 2, 18]
    ] as const;
    const rows: { name: string; error: number; inRange: boolean }[] = [];
    for (const [name, dynamic, still] of specifications) {
      const input = path.join(directory, `${name}.mp4`);
      expect(await synthetic(input, dynamic, still)).toBe(0);
      const info = await stat(input);
      const duration = await probeDuration(input);
      const job = makeJob(name, 'ready', {
        inputPath: input,
        outputPath: path.join(directory, `${name}-compressed.mp4`),
        fileName: path.basename(input),
        durationSeconds: duration,
        originalSize: info.size,
        encoding: { ...optimalEncoding }
      });
      const worker = new EstimationWorker(
        () => [job],
        (_id, patch) => Object.assign(job, patch),
        () => false,
        new EstimateCache(path.join(directory, `${name}-cache.json`))
      );
      await worker.init();
      await until(() => ['estimated', 'unavailable'].includes(job.estimateStatus));
      expect(job.estimateStatus).toBe('estimated');
      await worker.shutdown();
      const operation = encodeVideo(input, job.outputPath, duration, optimalEncoding, false, () => {});
      expect((await operation.done).code).toBe(0);
      const actual = (await stat(job.outputPath)).size;
      const estimated = job.estimatedOutputBytes!;
      rows.push({
        name,
        error: Math.round((Math.abs(estimated - actual) / actual) * 100),
        inRange: actual >= job.estimateRangeMinBytes! && actual <= job.estimateRangeMaxBytes!
      });
    }
    for (const row of rows.slice(0, 4)) expect(row.error).toBeLessThanOrEqual(35);
    expect(rows.at(-1)!.inRange || rows.at(-1)!.error <= 45).toBe(true);
  }, 60_000);
});

function synthetic(output: string, dynamic: number, still: number) {
  const common = ['-hide_banner', '-loglevel', 'error', '-y'];
  let args: string[];
  if (dynamic && still) {
    args = [
      '-f',
      'lavfi',
      '-t',
      String(dynamic),
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-f',
      'lavfi',
      '-t',
      String(still),
      '-i',
      'color=c=#39434d:size=320x180:rate=24',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      output
    ];
  } else if (dynamic) {
    args = [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-t',
      String(dynamic),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-an',
      output
    ];
  } else {
    args = [
      '-f',
      'lavfi',
      '-i',
      'color=c=#39434d:size=320x180:rate=24',
      '-t',
      String(still),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-an',
      output
    ];
  }
  return new Promise<number | null>((resolve, reject) => {
    const process = spawn('ffmpeg', [...common, ...args], { shell: false });
    process.on('error', reject);
    process.on('close', resolve);
  });
}

async function until(check: () => boolean) {
  const end = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
