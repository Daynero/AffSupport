import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { CompressionJob } from '../packages/shared/src/types.js';
import { EstimationWorker } from '../apps/agent/src/estimate/worker.js';
import { EstimateCache } from '../apps/agent/src/estimate/cache.js';
import { encodeVideo } from '../apps/agent/src/ffmpeg/encoder.js';
import { probeDuration } from '../apps/agent/src/ffmpeg/tools.js';

let dir = '';
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
describe('estimate accuracy on representative synthetic videos', () => {
  it('compares estimates with full Balanced encodes', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'estimate-accuracy-'));
    const specs = [['dynamic', 4, 0], ['static', 0, 4], ['mixed', 2, 3], ['short', .6, 0], ['dynamic-start-static-end', 2, 18]] as const;
    const rows: { name: string; estimated: number; actual: number; error: number; inRange: boolean }[] = [];
    for (const [name, dynamic, still] of specs) {
      const input = path.join(dir, `${name}.mp4`); expect(await synthetic(input, dynamic, still)).toBe(0); const info = await stat(input), duration = await probeDuration(input);
      const job: CompressionJob = { id: name, inputPath: input, outputPath: path.join(dir, `${name}-compressed.mp4`), fileName: path.basename(input), durationSeconds: duration, originalSize: info.size, finalSize: null, progress: 0, status: 'queued', error: null, preset: 'balanced', estimateStatus: 'waiting' };
      const worker = new EstimationWorker(() => [job], (_id, patch) => Object.assign(job, patch), () => false, new EstimateCache(path.join(dir, `${name}-cache.json`)));
      await worker.init(); await until(() => ['estimated', 'unavailable'].includes(job.estimateStatus!)); expect(job.estimateStatus).toBe('estimated'); await worker.shutdown();
      const operation = encodeVideo(input, job.outputPath, duration, 'balanced', false, () => {}); expect((await operation.done).code).toBe(0);
      const actual = (await stat(job.outputPath)).size, estimated = job.estimatedOutputBytes!; rows.push({ name, estimated, actual, error: Math.round(Math.abs(estimated - actual) / actual * 100), inRange: actual >= job.estimateRangeMinBytes! && actual <= job.estimateRangeMaxBytes! });
    }
    console.log('\nEstimate accuracy:', rows); for (const row of rows.slice(0, 4)) expect(row.error).toBeLessThanOrEqual(35); expect(rows.at(-1)!.inRange || rows.at(-1)!.error <= 45).toBe(true);
  }, 60_000);
});
function synthetic(output: string, dynamic: number, still: number) { const common = ['-hide_banner', '-loglevel', 'error', '-y']; let args: string[]; if (dynamic && still) args = ['-f', 'lavfi', '-t', String(dynamic), '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-t', String(still), '-i', 'color=c=#39434d:size=320x180:rate=24', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', output]; else if (dynamic) args = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', String(dynamic), '-c:v', 'libx264', '-preset', 'veryfast', '-an', output]; else args = ['-f', 'lavfi', '-i', 'color=c=#39434d:size=320x180:rate=24', '-t', String(still), '-c:v', 'libx264', '-preset', 'veryfast', '-an', output]; return new Promise<number | null>((resolve, reject) => { const process = spawn('ffmpeg', [...common, ...args], { shell: false }); process.on('error', reject); process.on('close', resolve); }); }
async function until(check: () => boolean) { const end = Date.now() + 30_000; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } }
