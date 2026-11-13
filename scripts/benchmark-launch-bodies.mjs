// Local synthetic benchmark. Run with node --import tsx after building shared.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runStitchPipeline } from '../apps/agent/src/stitcher/pipeline.js';
import { probeSource } from '../apps/agent/src/stitcher/probe.js';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache.js';
import { planStitch } from '../packages/shared/src/stitcher.js';
const root = await mkdtemp(path.join(tmpdir(), 'soty-bulk-benchmark-'));
try {
  const source = path.join(root, 'source.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30:d=12',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-preset',
    'veryfast',
    '-g',
    '60',
    '-pix_fmt',
    'yuv420p',
    source
  ]);
  const probe = await probeSource(source);
  if (!probe.ok) throw new Error(probe.error);
  const planned = planStitch(
    probe.value,
    { startSeconds: 0.3, endSeconds: 0.3, adjustedByUser: true },
    {
      startImageId: null,
      endImageId: null,
      startDurationSeconds: null,
      endDurationSeconds: 0,
      fitMode: 'cover'
    },
    'unstitch'
  );
  if (!planned.ok) throw new Error(planned.error);
  const sourceIdentity = createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
  const results = [];
  for (const mode of ['isolated-cold', 'shared-sequential', 'shared-batch']) {
    const directory = path.join(root, mode);
    await mkdir(directory);
    const shared = new PreparedBodyCache({ root: directory });
    let hits = 0,
      misses = 0;
    const job = async index => {
      const cache =
        mode === 'isolated-cold'
          ? new PreparedBodyCache({ root: path.join(directory, `cache-${index}`) })
          : shared;
      const result = await cache.prepare({
        profile: probe.value,
        plan: planned.value,
        sourceIdentity,
        threads: 1,
        workspacePath: path.join(directory, `output-${index}.mp4`)
      });
      if (!result.ok) throw new Error(result.error);
      if (result.value.fromCache) hits++;
      else misses++;
    };
    const start = performance.now();
    for (let i = 0; i < 20; i += mode === 'shared-batch' ? 2 : 1) {
      if (mode === 'shared-batch') await Promise.all([job(i), job(i + 1)]);
      else await job(i);
    }
    results.push({
      mode,
      milliseconds: Math.round(performance.now() - start),
      hits,
      preparations: misses,
      consumers: 20
    });
  }
  const pipelineResults = [];
  for (const concurrency of [1, 2]) {
    const directory = path.join(root, `pipeline-${concurrency}`);
    await mkdir(directory);
    const bodies = new PreparedBodyCache({ root: directory });
    const job = async index => {
      const workDir = path.join(directory, `run-${index}`);
      await mkdir(workDir);
      const result = await runStitchPipeline({
        request: {
          profile: probe.value,
          plan: planned.value,
          screens: {
            startImageId: null,
            endImageId: null,
            startDurationSeconds: null,
            endDurationSeconds: 0,
            fitMode: 'cover'
          },
          destination: { kind: 'beside' },
          outputSuffix: ''
        },
        workDir,
        threads: 1,
        signal: new AbortController().signal,
        onChild: () => {},
        onStage: () => {},
        imagePathFor: async () => null,
        bodies,
        sourceIdentity
      });
      if (!result.ok) throw new Error(result.error);
    };
    const start = performance.now();
    for (let i = 0; i < 20; i += concurrency)
      await Promise.all(Array.from({ length: concurrency }, (_, n) => job(i + n)));
    pipelineResults.push({
      concurrency,
      milliseconds: Math.round(performance.now() - start),
      outputs: 20
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        pipelineResults,
        fixture: '12s 640x360 H264 no audio, trim 0.3s both ends',
        scope:
          'prepared bodies and local native pipeline; not provider or end-to-end launch latency',
        results
      },
      null,
      2
    ) + '\n'
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
