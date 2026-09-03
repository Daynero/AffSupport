import { describe, expect, it } from 'vitest';
import {
  AAC_FRAME_SAMPLES,
  STITCH_MAX_SCREEN_FRAMES,
  STITCH_MAX_SCREEN_FPS,
  STITCH_MIN_BODY_SECONDS,
  STITCH_MIN_SCREEN_FRAMES,
  believableDetection,
  clampStitchEndDuration,
  endScreenFrameRate,
  isOnKeyframe,
  nextKeyframeAfter,
  planStitch,
  snapToAacFrames,
  stitchUnsupportedReason,
  type DetectedStitching,
  type SourceProfile,
  type StitchScreens
} from '../packages/shared/src/stitcher.js';
import { movingFrameBytes } from '../apps/agent/src/stitcher/plan.js';

/**
 * The planner is the only place the promise shown to the user is computed, and the finished
 * file is checked against that same object. Everything the measurements in research.md fixed
 * — AAC snapping, the two-sample minimum, the 1 fps end screen, the keyframe decision — is
 * decided here, so this is where it is pinned.
 */

/**
 * Narrowing that fails the test rather than skipping it.
 *
 * A bare `if (!result.ok) return` would report as passed — the exact failure mode the lint
 * rule in this repository exists to catch.
 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected a plan, got ${String(result.error)}`);
  return result.value;
}

const KEYFRAMES = [0, 8.333333, 16.666667, 25];

function profile(overrides: Partial<SourceProfile> = {}): SourceProfile {
  return {
    path: '/videos/creative.mp4',
    sizeBytes: 7_356_009,
    modifiedAtMs: 1_700_000_000_000,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    profile: 'High',
    level: 32,
    width: 1080,
    height: 1080,
    pixelFormat: 'yuv420p',
    colorRange: 'tv',
    frameRate: 30,
    variableFrameRate: false,
    videoTimescale: 15360,
    durationSeconds: 50.033333,
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 96,
    keyframeTimes: [...KEYFRAMES],
    ...overrides
  };
}

const detected = (start: number, end: number): DetectedStitching => ({
  startSeconds: start,
  endSeconds: end,
  adjustedByUser: false
});

const screens = (overrides: Partial<StitchScreens> = {}): StitchScreens => ({
  startImageId: 'img-start',
  endImageId: 'img-end',
  fitMode: 'cover',
  endDurationSeconds: 45,
  startDurationSeconds: null,
  ...overrides
});

describe('snapToAacFrames', () => {
  it('returns whole AAC frames and the exact seconds they occupy', () => {
    const snapped = snapToAacFrames(5, 48000);
    expect(snapped.aacFrames).toBe(234);
    expect(snapped.seconds).toBeCloseTo((234 * AAC_FRAME_SAMPLES) / 48000, 9);
  });

  it('never returns zero frames for a positive duration', () => {
    expect(snapToAacFrames(0.001, 48000).aacFrames).toBe(1);
  });

  it('degrades safely when the sample rate is unusable', () => {
    expect(snapToAacFrames(3, 0)).toEqual({ aacFrames: 0, seconds: 3 });
  });
});

describe('operation inference', () => {
  it('replaces the screens it found without being asked (FR-027)', () => {
    const value = unwrap(planStitch(profile(), detected(0.033333, 30), screens()));
    expect(value.operation).toBe('restitch');
    expect(value.bodyStartSeconds).toBeCloseTo(0.033333, 6);
    expect(value.bodyEndSeconds).toBeCloseTo(20.033333, 6);
  });

  it('adds screens when none were found', () => {
    const value = unwrap(planStitch(profile(), detected(0, 0), screens()));
    expect(value.operation).toBe('stitch');
    expect(value.bodyStartSeconds).toBe(0);
    expect(value.bodyEndSeconds).toBeCloseTo(50.033333, 6);
  });

  it('refuses to remove what is not there (FR-008)', () => {
    expect(planStitch(profile(), detected(0, 0), screens(), 'unstitch')).toEqual({
      ok: false,
      error: 'nothing-to-remove'
    });
  });

  it('removes both screens and adds none', () => {
    const value = unwrap(planStitch(profile(), detected(0.033333, 30), screens(), 'unstitch'));
    expect(value.startScreen).toBeNull();
    expect(value.endScreen).toBeNull();
    expect(value.promisedDurationSeconds).toBeCloseTo(20, 3);
  });

  it('requires at least one photo when it is not removing', () => {
    expect(
      planStitch(profile(), detected(0, 0), screens({ startImageId: null, endImageId: null }))
    ).toEqual({ ok: false, error: 'no-screens' });
  });
});

describe('a detection that would swallow the video', () => {
  it('is refused: a body has to remain', () => {
    // What the detector actually returned for a twenty-second clip of moving test footage:
    // it read almost the whole file as one held frame, and the run produced a photo with a
    // single frame of video attached.
    const twentySeconds = profile({ durationSeconds: 20 });
    const value = unwrap(planStitch(twentySeconds, detected(19.933333, 0.033334), screens()));
    expect(value.operation).toBe('stitch');
    expect(value.bodyStartSeconds).toBe(0);
    expect(value.bodyEndSeconds).toBeCloseTo(20, 6);
  });

  it('answers honestly when removal is asked of such a file', () => {
    expect(planStitch(profile(), detected(49, 1), screens(), 'unstitch')).toEqual({
      ok: false,
      error: 'nothing-to-remove'
    });
  });

  it('still accepts a creative that is mostly its end screen', () => {
    // 30 s of screen on a 50 s file is the ordinary case, not an implausible one.
    const value = unwrap(planStitch(profile(), detected(0.033333, 30), screens()));
    expect(value.operation).toBe('restitch');
    expect(value.bodyEndSeconds).toBeCloseTo(20.033333, 6);
  });

  it('leaves a boundary the user set alone', () => {
    const moved = { startSeconds: 19.9, endSeconds: 30, adjustedByUser: true };
    const value = unwrap(planStitch(profile(), moved, screens()));
    expect(value.bodyStartSeconds).toBeCloseTo(19.9, 6);
  });

  it('names the floor it applies', () => {
    expect(STITCH_MIN_BODY_SECONDS).toBe(1);
    expect(believableDetection(profile(), detected(49.9, 0))).toMatchObject({ startSeconds: 0 });
  });

  it('believes a short body under a very long screen, because that is what we make', () => {
    // The real shape of a stitched creative, measured: 3573.8 s of file, 3504 s of held photo
    // at the end, seventy seconds of content. A proportional floor called this implausible
    // and threw the detection away, so the old screen was kept and a new one added after it.
    const long = { ...profile(), durationSeconds: 3573.8 };
    expect(
      believableDetection(long, { startSeconds: 0.033333, endSeconds: 3504, adjustedByUser: false })
    ).toMatchObject({ endSeconds: 3504 });
  });
});

describe('screen segments', () => {
  it('never produces a single-sample screen (D3)', () => {
    const value = unwrap(
      planStitch(profile(), detected(0, 0), screens({ startDurationSeconds: 0.001 }))
    );
    expect(value.startScreen?.frames).toBe(STITCH_MIN_SCREEN_FRAMES);
  });

  it('caps a long end screen at a fixed number of pictures (D17)', () => {
    // The compressor's ranges are in minutes. At one picture a second a 45-minute screen is
    // 2700 frames and 18 seconds of encoding; capped, it is 300 frames and under two.
    const value = unwrap(
      planStitch(profile(), detected(0, 0), screens({ endDurationSeconds: 45 * 60 }))
    );
    expect(value.endScreen?.frames).toBe(STITCH_MAX_SCREEN_FRAMES);
    expect(value.endScreen?.durationSeconds).toBeCloseTo(45 * 60, 0);
    expect(endScreenFrameRate(45 * 60, 30)).toBeCloseTo(STITCH_MAX_SCREEN_FRAMES / (45 * 60), 6);
  });

  it('encodes a short end screen at one picture per second (D2)', () => {
    const value = unwrap(
      planStitch(profile(), detected(0, 0), screens({ endDurationSeconds: 45 }))
    );
    expect(value.endScreen).toMatchObject({
      frameRate: STITCH_MAX_SCREEN_FPS,
      frames: 45,
      durationSeconds: 45
    });
  });

  it('falls back to the body frame rate for an end screen too short for 1 fps', () => {
    const value = unwrap(planStitch(profile(), detected(0, 0), screens({ endDurationSeconds: 1 })));
    // A one-second screen at 1 fps could only be one sample; thirty static frames cost
    // nothing and keep the promised length honest.
    expect(value.endScreen).toMatchObject({ frameRate: 30, frames: 30, durationSeconds: 1 });
  });

  it('gives every screen a whole number of AAC frames within one frame of its picture', () => {
    const value = unwrap(planStitch(profile(), detected(0, 0), screens()));
    for (const screen of [value.startScreen, value.endScreen]) {
      expect(screen).not.toBeNull();
      if (!screen) continue;
      expect(Number.isInteger(screen.aacFrames)).toBe(true);
      const audioSeconds = (screen.aacFrames * AAC_FRAME_SAMPLES) / 48000;
      expect(Math.abs(audioSeconds - screen.durationSeconds)).toBeLessThanOrEqual(
        AAC_FRAME_SAMPLES / 48000
      );
    }
  });

  it('asks for no silence at all when the source has no audio', () => {
    const value = unwrap(
      planStitch(profile({ hasAudio: false, audioCodec: null }), detected(0, 0), screens())
    );
    expect(value.startScreen?.aacFrames).toBe(0);
    expect(value.endScreen?.aacFrames).toBe(0);
  });
});

describe('the edge cases the spec names', () => {
  it('states the resulting duration for a clip shorter than its own end screen', () => {
    const short = profile({ durationSeconds: 2, keyframeTimes: [0] });
    const value = unwrap(planStitch(short, detected(0, 0), screens({ endDurationSeconds: 45 })));
    expect(value.promisedDurationSeconds).toBeCloseTo(2 + 45 + 2 / 30, 3);
    // The output is mostly screen, and the plan says so rather than refusing.
    expect(value.endScreen?.durationSeconds).toBe(45);
  });

  it('invents no audio track for a silent source', () => {
    const silent = profile({ hasAudio: false, audioCodec: null, audioSampleRate: null });
    const value = unwrap(planStitch(silent, detected(0, 0), screens()));
    expect(value.startScreen?.aacFrames).toBe(0);
    expect(value.endScreen?.aacFrames).toBe(0);
  });

  it('reads only the edges, so a held frame in the middle is never a screen', () => {
    // The planner is given edges; nothing it computes can be influenced by the middle.
    const value = unwrap(planStitch(profile(), detected(0.033333, 30), screens()));
    expect(value.bodyStartSeconds).toBeCloseTo(0.033333, 6);
    expect(value.bodyEndSeconds).toBeCloseTo(20.033333, 6);
  });
});

describe('the keyframe decision (D6)', () => {
  it('needs no head rebuild when the body starts on a keyframe', () => {
    const value = unwrap(planStitch(profile(), detected(0, 30), screens()));
    expect(value.headReencodeUntilSeconds).toBeNull();
  });

  it('rebuilds only as far as the next keyframe when it does not', () => {
    const value = unwrap(planStitch(profile(), detected(0.033333, 30), screens()));
    expect(value.headReencodeUntilSeconds).toBeCloseTo(8.333333, 6);
  });

  it('treats a boundary within half a frame of a keyframe as being on it', () => {
    expect(isOnKeyframe(profile(), 8.333333 + 0.01)).toBe(true);
    expect(isOnKeyframe(profile(), 8.333333 + 0.02)).toBe(false);
    expect(nextKeyframeAfter(profile(), 8.4)).toBeCloseTo(16.666667, 6);
    expect(nextKeyframeAfter(profile(), 40)).toBeNull();
  });
});

describe('the promise', () => {
  it('adds up body plus screens', () => {
    const value = unwrap(planStitch(profile(), detected(0.033333, 30), screens()));
    const body = value.bodyEndSeconds - value.bodyStartSeconds;
    expect(value.promisedDurationSeconds).toBeCloseTo(
      body + (value.startScreen?.durationSeconds ?? 0) + (value.endScreen?.durationSeconds ?? 0),
      6
    );
    expect(value.promisedFrameCount).toBe(
      Math.round(body * 30) + (value.startScreen?.frames ?? 0) + (value.endScreen?.frames ?? 0)
    );
  });
});

describe('sources the fast path cannot serve (FR-023)', () => {
  it.each([
    ['video-codec', { videoCodec: 'hevc' }],
    ['audio-codec', { audioCodec: 'opus' }],
    ['variable-frame-rate', { variableFrameRate: true }],
    ['container', { container: 'matroska,webm' }],
    ['unreadable', { durationSeconds: 0 }]
  ] as const)('names %s rather than a sentence', (reason, overrides) => {
    const candidate = profile(overrides);
    expect(stitchUnsupportedReason(candidate)).toBe(reason);
    expect(planStitch(candidate, detected(0, 0), screens())).toEqual({ ok: false, error: reason });
  });

  it('serves a source with no audio at all', () => {
    expect(stitchUnsupportedReason(profile({ hasAudio: false, audioCodec: null }))).toBeNull();
  });
});

describe('end duration', () => {
  it('clamps out-of-range and unusable values', () => {
    expect(clampStitchEndDuration(0)).toBe(1);
    expect(clampStitchEndDuration(10 * 60 * 60)).toBe(60 * 60);
    expect(clampStitchEndDuration('nonsense')).toBe(45 * 60);
  });
});

/**
 * What a moving frame costs, when most of the "body" is not moving.
 *
 * A video that had been stitched once was stitched again. Its body — everything the trailing
 * search had not claimed — was fifty-two minutes, of which the first two were the creative and
 * the other fifty were the previous screen. Sampled at a tenth, a quarter and two fifths of
 * that body, every sample landed inside the old screen, and a moving frame was reported as 27
 * bytes. The walk that exists to remove exactly that old screen then refused it for costing
 * more than a third of "the body", and fifty minutes of held photograph were delivered as
 * content.
 *
 * Samples far below the busiest one are held picture. They are dropped, not averaged in.
 */
describe('the body figure the tail search is compared against', () => {
  it('ignores the samples that landed in a held picture', () => {
    // The real file: 1848 and 463 bytes in the creative, 27 in the old screen.
    expect(movingFrameBytes([1848, 463, 27, 27, 27])).toBe(1848);
  });

  it('keeps every sample when the body is moving throughout', () => {
    expect(movingFrameBytes([900, 1000, 1100])).toBe(1000);
  });

  it('answers with the held figure when the whole body is held', () => {
    // Nothing here is far below anything else, so nothing is dropped — and a file that is
    // held from end to end has no moving frame to report.
    expect(movingFrameBytes([27, 26, 28])).toBe(27);
  });

  it('has no answer without a sample', () => {
    expect(movingFrameBytes([])).toBeNull();
    expect(movingFrameBytes([0, 0])).toBeNull();
  });
});
