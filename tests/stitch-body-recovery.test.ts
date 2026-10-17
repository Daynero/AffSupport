import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache.js';
import {
  DiagnosticsLog,
  setActiveDiagnosticsLog
} from '../apps/agent/src/server/diagnostics-log.js';
import { probeSource } from '../apps/agent/src/stitcher/probe.js';
import { measureOutput } from '../apps/agent/src/stitcher/verify.js';
import { runTool } from '../apps/agent/src/stitcher/run.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

describeRequiring(ffmpegBinaries, 'prepared body with video preroll', () => {
  it('recovers when a seek copies old video packets and delays the audio track', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-body-recovery-'));
    const journal = new DiagnosticsLog({ file: null });
    setActiveDiagnosticsLog(journal);
    try {
      const video = path.join(directory, 'video.mp4');
      const audio = path.join(directory, 'audio.m4a');
      const source = path.join(directory, 'source.mp4');
      for (const args of [
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x160:rate=30:duration=12',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-g',
          '171',
          '-output_ts_offset',
          '-2.7',
          '-avoid_negative_ts',
          'disabled',
          video
        ],
        [
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=44100:duration=12',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          audio
        ],
        [
          '-copyts',
          '-avoid_negative_ts',
          'disabled',
          '-i',
          video,
          '-i',
          audio,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          source
        ]
      ]) {
        const result = await runTool('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          ...args
        ]);
        expect(result.code, result.stderr).toBe(0);
      }

      const probed = await probeSource(source);
      expect(probed.ok).toBe(true);
      if (!probed.ok) throw new Error(probed.error);
      expect(probed.value.keyframeTimes).toContain(3);
      const prepared = await new PreparedBodyCache({ root: directory }).prepare({
        runId: '00000000-0000-4000-8000-000000000031',
        profile: probed.value,
        plan: {
          bodyStartSeconds: 0.066667,
          bodyEndSeconds: 8,
          headReencodeUntilSeconds: 2.999
        } as Parameters<PreparedBodyCache['prepare']>[0]['plan']
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error(prepared.error);
      const measured = await measureOutput(prepared.value.path);
      expect(measured).not.toBeNull();
      expect(measured?.videoTrackSeconds).toBeCloseTo(8 - 0.066667, 0);
      expect(
        Math.abs((measured?.videoTrackSeconds ?? 0) - (measured?.audioTrackSeconds ?? 0))
      ).toBeLessThan(0.25);
      expect(
        journal
          .since(0)
          .filter(record => record.category === 'stitcher')
          .map(record => [record.category, record.code, record.props?.reason, record.props?.runId])
      ).toEqual([
        [
          'stitcher',
          'body_recovery_started',
          'audio_shape_mismatch',
          '00000000-0000-4000-8000-000000000031'
        ],
        [
          'stitcher',
          'body_recovery_completed',
          'audio_shape_mismatch',
          '00000000-0000-4000-8000-000000000031'
        ]
      ]);
    } finally {
      setActiveDiagnosticsLog(null);
      await removeTemporaryDirectory(directory);
    }
  }, 120_000);
});
