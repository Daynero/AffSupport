import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache.js';
import { probeSource } from '../apps/agent/src/stitcher/probe.js';
import { measureOutput } from '../apps/agent/src/stitcher/verify.js';
import { runTool } from '../apps/agent/src/stitcher/run.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * Production 2026-11-24 (onemedia, «KZ v12»): every re-stitch of one creative failed with
 * BODY_RECOVERY_VERIFICATION_FAILED, three files in a row, while its siblings stitched. The
 * whole-body re-encode rebuilt the picture to the planned length, but its sound ended where the
 * source's sound ended, so the rebuilt body failed the same track check it was made to pass.
 */
async function sourceWith(directory: string, audio: string[]) {
  const video = path.join(directory, 'video.mp4');
  const sound = path.join(directory, 'sound.m4a');
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
      '30',
      video
    ],
    ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=9', '-c:a', 'aac', sound],
    ['-i', video, ...audio, '-i', sound, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', source]
  ]) {
    const made = await runTool('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    expect(made.code, made.stderr).toBe(0);
  }
  const probed = await probeSource(source);
  if (!probed.ok) throw new Error(probed.error);
  return probed.value;
}

describeRequiring(ffmpegBinaries, 'prepared body whose sound is shorter than its picture', () => {
  it.each([
    ['ends early', []],
    ['starts late', ['-itsoffset', '1.5']]
  ])(
    're-encodes a body whose sound %s into matching tracks',
    async (_, audio) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-body-short-audio-'));
      try {
        const profile = await sourceWith(directory, audio);
        expect(profile.hasAudio).toBe(true);
        const prepared = await new PreparedBodyCache({ root: directory }).prepare({
          profile,
          plan: {
            bodyStartSeconds: 0,
            bodyEndSeconds: 11,
            headReencodeUntilSeconds: null
          } as Parameters<PreparedBodyCache['prepare']>[0]['plan']
        });
        expect(prepared.ok, prepared.ok ? '' : prepared.error).toBe(true);
        if (!prepared.ok) return;
        const measured = await measureOutput(prepared.value.path);
        expect(measured?.videoTrackSeconds).toBeCloseTo(11, 0);
        expect(
          Math.abs((measured?.videoTrackSeconds ?? 0) - (measured?.audioTrackSeconds ?? 0))
        ).toBeLessThan(0.25);
      } finally {
        await removeTemporaryDirectory(directory);
      }
    },
    120_000
  );
});
