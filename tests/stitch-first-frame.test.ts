import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { planStitch, type StitchScreens } from '../packages/shared/src/stitcher.js';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache.js';
import { runStitchPipeline } from '../apps/agent/src/stitcher/pipeline.js';
import { probeSource } from '../apps/agent/src/stitcher/probe.js';
import { runTool } from '../apps/agent/src/stitcher/run.js';
import {
  DiagnosticsLog,
  setActiveDiagnosticsLog
} from '../apps/agent/src/server/diagnostics-log.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../apps/agent/src/files/support-dir.js', () => ({
  applicationSupportRoot: () => state.root
}));

async function media(args: string[]) {
  const result = await runTool('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function frameHashes(file: string, decoded = false) {
  return (
    await media([
      '-i',
      file,
      '-map',
      '0:v',
      ...(decoded ? ['-fps_mode', 'passthrough'] : ['-c', 'copy']),
      '-f',
      'framemd5',
      '-'
    ])
  )
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.trim().split(/\s+/).pop());
}

describeRequiring(ffmpegBinaries, 'first-frame-only stitching with real media', () => {
  it.each([48000, 44100, null])(
    'preserves the entire B-frame body with audio rate %s on cold and warm runs',
    async sampleRate => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-first-frame-'));
      state.root = directory;
      const journal = new DiagnosticsLog({ file: null });
      setActiveDiagnosticsLog(journal);
      try {
        const source = path.join(directory, 'source.mp4');
        const image = path.join(directory, 'screen.png');
        await media([
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=640x360:r=30:d=30',
          ...(sampleRate
            ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sampleRate}:duration=30`]
            : []),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-bf',
          '2',
          '-g',
          '60',
          ...(sampleRate ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []),
          source
        ]);
        await media(['-f', 'lavfi', '-i', 'color=blue:s=640x360', '-frames:v', '1', image]);
        const before = createHash('sha256')
          .update(await readFile(source))
          .digest('hex');
        const probed = await probeSource(source);
        if (!probed.ok) throw new Error(probed.error);
        const screens: StitchScreens = {
          startImageId: 'start',
          endImageId: null,
          fitMode: 'cover',
          endDurationSeconds: 0,
          startDurationSeconds: null
        };
        const planned = planStitch(
          probed.value,
          {
            startSeconds: 0,
            endSeconds: 0,
            adjustedByUser: false
          },
          screens
        );
        if (!planned.ok) throw new Error(planned.error);
        expect(planned.value.headReencodeUntilSeconds).toBeNull();
        const sourceHashes = await frameHashes(source);
        expect(sourceHashes).toHaveLength(900);
        const bodies = new PreparedBodyCache({ root: directory });
        for (const cache of ['cold', 'warm']) {
          const started = performance.now();
          const stages: Record<string, number> = {};
          const produced = await runStitchPipeline({
            runId: '00000000-0000-4000-8000-000000000032',
            request: {
              profile: probed.value,
              plan: planned.value,
              screens,
              destination: { kind: 'beside' },
              outputSuffix: ''
            },
            workDir: await mkdtemp(path.join(directory, 'run-')),
            threads: null,
            signal: new AbortController().signal,
            onChild: () => {},
            onStage: stage => {
              stages[stage] = Math.round(performance.now() - started);
            },
            imagePathFor: async () => image,
            bodies
          });
          const elapsedMs = Math.round(performance.now() - started);
          console.info(
            'stitch-first-frame',
            JSON.stringify({
              sampleRate,
              cache,
              elapsedMs,
              stages,
              ...(!produced.ok ? { failure: produced } : {})
            })
          );
          if (!produced.ok) throw new Error(produced.error);
          expect(produced.verification.mismatches).toEqual([]);
          const completed = journal
            .since(0)
            .filter(record => record.code === 'pipeline_stage_completed');
          expect(completed.slice(-6).map(record => record.props?.stage)).toEqual([
            'silence',
            'body',
            'measurement',
            'screens',
            'joining',
            'verification'
          ]);
          expect(completed.at(-5)?.props?.fromCache).toBe(cache === 'warm');
          expect(
            completed.every(
              record => record.props?.runId === '00000000-0000-4000-8000-000000000032'
            )
          ).toBe(true);
          expect(
            journal.since(0).filter(record => record.code === 'body_recovery_started')
          ).toEqual([]);
          expect(JSON.stringify(completed)).not.toContain(directory);
          const hashes = await frameHashes(produced.stagedPath);
          const bodyHashes = hashes.slice(-sourceHashes.length);
          // Concat repeats SPS/PPS headers at keyframes; compare the copied interframes
          // byte-for-byte and every decoded picture, including keyframes, pixel-for-pixel.
          expect(bodyHashes.filter((_, index) => index % 60 !== 0)).toEqual(
            sourceHashes.filter((_, index) => index % 60 !== 0)
          );
          expect((await frameHashes(produced.stagedPath, true)).slice(-900)).toEqual(
            await frameHashes(source, true)
          );
          const decoded = await runTool('ffmpeg', [
            '-v',
            'error',
            '-i',
            produced.stagedPath,
            '-f',
            'null',
            '-'
          ]);
          expect(decoded.code, decoded.stderr).toBe(0);
          expect(decoded.stderr).toBe('');
          if (sampleRate !== null) {
            const sound = await runTool('ffmpeg', [
              '-hide_banner',
              '-ss',
              '15',
              '-i',
              produced.stagedPath,
              '-t',
              '1',
              '-vn',
              '-af',
              'volumedetect',
              '-f',
              'null',
              '-'
            ]);
            expect(sound.code, sound.stderr).toBe(0);
            const volume = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/u.exec(sound.stderr);
            expect(volume, 'the original tone must remain audible inside the body').not.toBeNull();
            expect(Number(volume![1])).toBeGreaterThan(-40);
          }
        }
        expect(
          createHash('sha256')
            .update(await readFile(source))
            .digest('hex')
        ).toBe(before);
      } finally {
        setActiveDiagnosticsLog(null);
        await removeTemporaryDirectory(directory);
      }
    },
    120_000
  );
});
