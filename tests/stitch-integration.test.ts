import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { planStitch, type StitchScreens } from '../packages/shared/src/stitcher.js';
import { PreparedBodyCache } from '../apps/agent/src/stitcher/body-cache.js';
import { runStitchPipeline } from '../apps/agent/src/stitcher/pipeline.js';
import { detectStitching } from '../apps/agent/src/stitcher/plan.js';
import { probeSource } from '../apps/agent/src/stitcher/probe.js';
import { runTool } from '../apps/agent/src/stitcher/run.js';
import { measureSegment } from '../apps/agent/src/stitcher/verify.js';
import { describeRequiring } from './support/requires.js';
import { ffmpegBinaries } from './support/toolchain.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * The whole pipeline against a real media engine, on a creative shaped like the ones this
 * tool exists for: a one-frame photo intro, moving content, and a long photo outro, all
 * encoded in one pass — which is what the compressor produces and therefore what has to be
 * taken apart again.
 *
 * Small on purpose (320×320). Every assertion here is about structure and correctness;
 * the performance numbers belong to `quickstart.md`, where they are measured at full size.
 */

let directory = '';
let legacy = '';
let clean = '';
let photoTail = '';
let cardThenPhoto = '';
let photo = '';

const SCREENS: StitchScreens = {
  startImageId: 'start',
  endImageId: 'end',
  fitMode: 'cover',
  endDurationSeconds: 6,
  startDurationSeconds: null
};

/**
 * Narrowing that fails rather than skips: a bare early return inside a test callback reports
 * as passed, which is the failure mode this repository lints against.
 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(String(result.error));
  return result.value;
}

async function ffmpeg(args: string[]): Promise<void> {
  const result = await runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
  expect(result.code, result.stderr).toBe(0);
}

/** The colour of one pixel, so a screen can be told from the body without eyes. */
async function pixelAt(file: string, seconds: number): Promise<string> {
  const result = await runTool('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(seconds),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'scale=1:1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ]);
  return Buffer.from(result.stdout, 'binary').toString('hex');
}

async function stitch(source: string, screens = SCREENS) {
  const probed = await probeSource(source);
  expect(probed.ok).toBe(true);
  if (!probed.ok) throw new Error(probed.error);
  const detected = await detectStitching(probed.value);
  const planned = planStitch(probed.value, detected, screens);
  expect(planned.ok).toBe(true);
  if (!planned.ok) throw new Error(planned.error);

  const workDir = await mkdtemp(path.join(directory, 'run-'));
  const produced = await runStitchPipeline({
    request: {
      profile: probed.value,
      plan: planned.value,
      screens,
      destination: { kind: 'beside' },
      outputSuffix: ''
    },
    workDir,
    threads: null,
    signal: new AbortController().signal,
    onChild: () => {},
    onStage: () => {},
    imagePathFor: async () => photo,
    bodies: new PreparedBodyCache({ root: directory })
  });
  return { produced, plan: planned.value, detected, profile: probed.value };
}

describeRequiring(ffmpegBinaries, 'stitching a real creative', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'soty-stitch-it-'));
    legacy = path.join(directory, 'legacy.mp4');
    clean = path.join(directory, 'clean.mp4');
    photoTail = path.join(directory, 'photo-tail.mp4');
    cardThenPhoto = path.join(directory, 'card-then-photo.mp4');
    photo = path.join(directory, 'photo.png');

    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x320:d=1',
      '-frames:v',
      '1',
      photo
    ]);
    // A creative in the shape the compressor makes: one photo frame, 6 s of motion, a 6 s
    // photo outro, all in a single encode — so the body does not start on a keyframe.
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x320:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x320:d=1',
      '-filter_complex',
      '[2:v]scale=320:320,setsar=1,format=yuv420p,fps=30,trim=end_frame=1,setpts=PTS-STARTPTS[sv];' +
        'anullsrc=r=48000:cl=stereo:d=0.0333[sa];' +
        '[0:v]setsar=1,format=yuv420p[mv];[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ma];' +
        '[2:v]scale=320:320,setsar=1,format=yuv420p,fps=30,trim=duration=6,setpts=PTS-STARTPTS[ev];' +
        'anullsrc=r=48000:cl=stereo:d=6[ea];' +
        '[sv][sa][mv][ma][ev][ea]concat=n=3:v=1:a=1[v][a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      // A keyframe every second, so the body has one to copy from after the group of frames
      // at the cut has been rebuilt. Real creatives carry one roughly every eight seconds;
      // this keeps the fixture short without removing the case being tested.
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-fps_mode',
      'cfr',
      '-movflags',
      '+faststart',
      legacy
    ]);
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x320:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-fps_mode',
      'cfr',
      '-movflags',
      '+faststart',
      clean
    ]);
    /*
     * The shape that broke the detector on a real file: a long tail held on a *detailed*
     * picture.
     *
     * The other fixtures end on a flat colour, whose keyframe costs almost nothing — so any
     * way of measuring the tail called it cheap. A photograph's keyframe is enormous, and a
     * measurement that averaged it over the two seconds after it declared a 50-minute screen
     * more expensive than the footage it followed and threw the screen away. Noise is the
     * cheapest way to ask for an expensive keyframe; held from a file rather than generated
     * per frame, because the point is a picture that does not change.
     */
    const noise = path.join(directory, 'noise.png');
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'nullsrc=s=320x320:d=1,geq=random(1)*255:128:128,format=yuv420p',
      '-frames:v',
      '1',
      noise
    ]);
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x320:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '20',
      '-i',
      noise,
      '-filter_complex',
      '[0:v]setsar=1,format=yuv420p[mv];[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ma];' +
        '[2:v]scale=320:320,setsar=1,format=yuv420p,fps=30[ev];' +
        'anullsrc=r=48000:cl=stereo:d=20[ea];' +
        '[mv][ma][ev][ea]concat=n=2:v=1:a=1[v][a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-fps_mode',
      'cfr',
      '-movflags',
      '+faststart',
      photoTail
    ]);
    /*
     * Two held pictures at the tail, which is what a real creative looks like: its own end
     * card, and then the photo screen someone appended after it.
     *
     * The card hides from the search that anchors on the last frame of the file — it does not
     * match the photo, so the run stops at the card's last frame and the card is left behind,
     * five seconds of the previous stitching sitting in front of the new one. The card is a
     * flat colour rather than a photograph, and cheap, which is exactly why telling it from
     * the body needs more than one measurement.
     */
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x320:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=6',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x101828:s=320x320:rate=30:duration=5',
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '20',
      '-i',
      noise,
      '-filter_complex',
      '[0:v]setsar=1,format=yuv420p[mv];[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ma];' +
        '[2:v]setsar=1,format=yuv420p,fps=30[cv];anullsrc=r=48000:cl=stereo:d=5[ca];' +
        '[3:v]scale=320:320,setsar=1,format=yuv420p,fps=30[ev];' +
        'anullsrc=r=48000:cl=stereo:d=20[ea];' +
        '[mv][ma][cv][ca][ev][ea]concat=n=3:v=1:a=1[v][a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-fps_mode',
      'cfr',
      '-movflags',
      '+faststart',
      cardThenPhoto
    ]);
  }, 180_000);

  afterAll(async () => {
    await removeTemporaryDirectory(directory);
  });

  it('finds the screens a one-pass creative was built with', async () => {
    const probed = { ok: true as const, value: unwrap(await probeSource(legacy)) };
    const detected = await detectStitching(probed.value);
    expect(detected.startSeconds).toBeGreaterThan(0);
    expect(detected.startSeconds).toBeLessThan(0.5);
    expect(detected.endSeconds).toBeGreaterThan(5);
  }, 60_000);

  it('re-stitches it into a file that matches what it promised', async () => {
    const { produced } = await stitch(legacy);
    if (!produced.ok) throw new Error(produced.error);
    expect(produced.verification.mismatches).toEqual([]);
    expect(produced.verification.withinTolerance).toBe(true);
    // The two tracks agreeing is the assertion that catches a screen whose timestamps run
    // backwards into the body — the defect that B-frames at 1 fps produced.
    expect(
      Math.abs(produced.verification.videoTrackSeconds - produced.verification.audioTrackSeconds)
    ).toBeLessThan(0.1);
    expect(produced.verification.width).toBe(320);
    expect(produced.verification.pixelFormat).toBe('yuv420p');
  }, 120_000);

  it('leaves the new end screen seekable (D2)', async () => {
    const { produced, plan } = await stitch(legacy);
    if (!produced.ok) throw new Error(produced.error);
    const middleOfEndScreen =
      produced.verification.durationSeconds - (plan.endScreen?.durationSeconds ?? 0) / 2;
    // A single-frame end screen returns nothing here; a 1 fps one returns the photo.
    expect(await pixelAt(produced.stagedPath, middleOfEndScreen)).not.toBe('');
  }, 120_000);

  it('carries the body over without re-encoding it', async () => {
    const { produced, plan } = await stitch(legacy);
    if (!produced.ok) throw new Error(produced.error);
    // Past the one group of frames that had to be rebuilt at the cut, every packet is the
    // source's own — compared by encoded-frame hash, so "the same" means bit-for-bit rather
    // than merely looking alike.
    expect(plan.headReencodeUntilSeconds).not.toBeNull();
    expect(plan.headReencodeUntilSeconds ?? 0).toBeLessThan(plan.bodyEndSeconds);
    const output = await frameHashes(produced.stagedPath);
    const source = await frameHashes(legacy);
    const shared = source.filter(hash => output.includes(hash));
    // The copied stretch of this fixture is about four of its six body seconds.
    expect(shared.length).toBeGreaterThan(100);
  }, 120_000);

  it('finds a long screen held on a detailed photograph', async () => {
    const probed = { ok: true as const, value: unwrap(await probeSource(photoTail)) };
    const detected = await detectStitching(probed.value);
    // Twenty seconds of held picture after six of motion. The figure that matters is that
    // the screen was found at all: measured the wrong way it came back as zero.
    expect(detected.endSeconds).toBeGreaterThan(15);
    expect(probed.value.durationSeconds - detected.endSeconds).toBeGreaterThan(2);
  }, 120_000);

  it('takes the end card in front of the screen, not just the screen', async () => {
    const probed = { ok: true as const, value: unwrap(await probeSource(cardThenPhoto)) };
    const detected = await detectStitching(probed.value);
    // Twenty seconds of photo plus five of card. Finding only the photo is the defect: it
    // leaves the card between the body and the new screen.
    expect(detected.endSeconds).toBeGreaterThan(24);
    // …and the six seconds of motion in front of it are still there.
    expect(probed.value.durationSeconds - detected.endSeconds).toBeGreaterThan(4);
  }, 120_000);

  it('adds screens to a video that has none, and never trims one that is all motion', async () => {
    const probed = { ok: true as const, value: unwrap(await probeSource(clean)) };
    const detected = await detectStitching(probed.value);
    const planned = {
      ok: true as const,
      value: unwrap(planStitch(probed.value, detected, SCREENS))
    };
    // Whatever the detector thought it saw, a body has to remain.
    expect(planned.value.bodyEndSeconds - planned.value.bodyStartSeconds).toBeGreaterThan(1);

    const { produced } = await stitch(clean);
    if (!produced.ok) throw new Error(produced.error);
    expect(produced.verification.mismatches).toEqual([]);
    const measured = await measureSegment(produced.stagedPath);
    expect(measured?.durationSeconds ?? 0).toBeGreaterThan(6);
  }, 120_000);

  it('removes the screens and gives back the body', async () => {
    const probed = await probeSource(legacy);
    if (!probed.ok) throw new Error(probed.error);
    const detected = await detectStitching(probed.value);
    const planned = {
      ok: true as const,
      value: unwrap(planStitch(probed.value, detected, SCREENS, 'unstitch'))
    };
    expect(planned.value.startScreen).toBeNull();
    expect(planned.value.endScreen).toBeNull();

    const workDir = await mkdtemp(path.join(directory, 'unstitch-'));
    const produced = await runStitchPipeline({
      request: {
        profile: probed.value,
        plan: planned.value,
        screens: { ...SCREENS, startImageId: null, endImageId: null },
        destination: { kind: 'beside' },
        outputSuffix: ''
      },
      workDir,
      threads: null,
      signal: new AbortController().signal,
      onChild: () => {},
      onStage: () => {},
      imagePathFor: async () => photo,
      bodies: new PreparedBodyCache({ root: directory })
    });
    if (!produced.ok) throw new Error(produced.error);
    expect(produced.verification.mismatches).toEqual([]);
    // Six seconds of motion, back on its own, without the seven seconds of photo.
    expect(produced.verification.durationSeconds).toBeGreaterThan(5.5);
    expect(produced.verification.durationSeconds).toBeLessThan(7);
  }, 120_000);

  it('declines a source the fast path cannot serve, without touching it', async () => {
    const hevc = path.join(directory, 'hevc.mp4');
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x320:rate=30:duration=2',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-tag:v',
      'hvc1',
      '-an',
      hevc
    ]);
    const probed = { ok: true as const, value: unwrap(await probeSource(hevc)) };
    expect(planStitch(probed.value, await detectStitching(probed.value), SCREENS)).toEqual({
      ok: false,
      error: 'video-codec'
    });
  }, 120_000);
});

/** Every encoded video frame's hash, so "the same frames" means bit-for-bit. */
async function frameHashes(file: string): Promise<string[]> {
  const result = await runTool('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:v',
    '-c',
    'copy',
    '-f',
    'framemd5',
    '-'
  ]);
  return result.stdout
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.trim().split(/\s+/).pop() ?? '');
}
