import { describe, expect, it } from 'vitest';
import {
  AAC_FRAME_SAMPLES,
  planStitch,
  type DetectedStitching,
  type SourceProfile,
  type StitchPlan,
  type StitchScreens
} from '../packages/shared/src/stitcher.js';
import {
  buildVerifyProbeArgs,
  compareToPlan,
  measurementFromProbe,
  toleranceSeconds,
  type MeasuredOutput
} from '../apps/agent/src/stitcher/verify.js';

/**
 * The tolerance is drawn from measurement, not taste: the pipeline rounds silence to whole
 * AAC frames and pictures to whole frames, so a finished file can legitimately sit one of
 * each away from its plan. The two-second track disagreement these assertions refuse is a
 * real defect this feature's own experiments produced.
 */

const profile: SourceProfile = {
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
  keyframeTimes: [0, 8.333333, 16.666667, 25]
};

const detected: DetectedStitching = { startSeconds: 0, endSeconds: 0, adjustedByUser: false };
const screens: StitchScreens = {
  startImageId: 'start',
  endImageId: 'end',
  fitMode: 'cover',
  endDurationSeconds: 45,
  startDurationSeconds: null
};

function makePlan(): StitchPlan {
  const result = planStitch(profile, detected, screens);
  if (!result.ok) throw new Error(`plan failed: ${result.error}`);
  return result.value;
}

function measured(plan: StitchPlan, overrides: Partial<MeasuredOutput> = {}): MeasuredOutput {
  return {
    durationSeconds: plan.promisedDurationSeconds,
    frameCount: plan.promisedFrameCount,
    videoTrackSeconds: plan.promisedDurationSeconds,
    audioTrackSeconds: plan.promisedDurationSeconds,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1080,
    height: 1080,
    pixelFormat: 'yuv420p',
    ...overrides
  };
}

describe('the probe it verifies with', () => {
  it('counts off the index rather than decoding the file', () => {
    const args = buildVerifyProbeArgs('/out/result.mp4');
    expect(args).toContain('-count_packets');
    expect(args).not.toContain('-count_frames');
  });

  it('reads a payload into a measurement, and refuses one with no video', () => {
    const parsed = measurementFromProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1080,
          height: 1080,
          pix_fmt: 'yuv420p',
          duration: '65.06',
          nb_read_packets: '1953'
        },
        { codec_type: 'audio', codec_name: 'aac', duration: '65.07' }
      ],
      format: { duration: '65.07' }
    });
    expect(parsed).toMatchObject({ frameCount: 1953, videoTrackSeconds: 65.06, audioCodec: 'aac' });
    expect(measurementFromProbe({ streams: [], format: {} })).toBeNull();
    expect(measurementFromProbe('nonsense')).toBeNull();
  });
});

describe('the tolerance', () => {
  it('is one AAC frame plus one video frame', () => {
    expect(toleranceSeconds(profile)).toBeCloseTo(AAC_FRAME_SAMPLES / 48000 + 1 / 30, 9);
  });

  it('drops the audio quantum for a source with no audio', () => {
    expect(toleranceSeconds({ ...profile, hasAudio: false })).toBeCloseTo(1 / 30, 9);
  });
});

describe('comparing a finished file with its plan', () => {
  const plan = makePlan();

  it('passes an exact match', () => {
    const verification = compareToPlan(measured(plan), plan, profile);
    expect(verification.withinTolerance).toBe(true);
    expect(verification.mismatches).toEqual([]);
  });

  it('passes the rounding the pipeline cannot avoid', () => {
    const drift = AAC_FRAME_SAMPLES / 48000 + 1 / 30 - 0.001;
    const verification = compareToPlan(
      measured(plan, {
        durationSeconds: plan.promisedDurationSeconds + drift,
        videoTrackSeconds: plan.promisedDurationSeconds + drift,
        audioTrackSeconds: plan.promisedDurationSeconds,
        frameCount: plan.promisedFrameCount + 1
      }),
      plan,
      profile
    );
    expect(verification.withinTolerance).toBe(true);
  });

  it('fails the two-second track disagreement the experiments produced (D7)', () => {
    const verification = compareToPlan(
      measured(plan, {
        videoTrackSeconds: 63.25,
        audioTrackSeconds: 65.26,
        durationSeconds: 65.26
      }),
      plan,
      profile
    );
    expect(verification.withinTolerance).toBe(false);
    expect(verification.mismatches).toContain('tracks-disagree');
  });

  it('allows the container header to round past the last sample', () => {
    // Measured: a correct file whose tracks agreed to within 8 ms, and whose container
    // duration sat 54 ms beyond both. Judging the derived number failed a good file.
    const verification = compareToPlan(
      measured(plan, {
        durationSeconds: plan.promisedDurationSeconds + 0.054,
        videoTrackSeconds: plan.promisedDurationSeconds,
        audioTrackSeconds: plan.promisedDurationSeconds - 0.008
      }),
      plan,
      profile
    );
    expect(verification.mismatches).toEqual([]);
  });

  it('still catches a container whose header disagrees wildly with its tracks', () => {
    const verification = compareToPlan(
      measured(plan, { durationSeconds: plan.promisedDurationSeconds + 5 }),
      plan,
      profile
    );
    expect(verification.mismatches).toContain('container-duration');
  });

  it('fails a file that is not the length it promised', () => {
    const verification = compareToPlan(
      measured(plan, {
        durationSeconds: plan.promisedDurationSeconds - 2,
        videoTrackSeconds: plan.promisedDurationSeconds - 2,
        audioTrackSeconds: plan.promisedDurationSeconds - 2
      }),
      plan,
      profile
    );
    expect(verification.mismatches).toContain('duration');
  });

  it('fails a file whose frames were lost', () => {
    const verification = compareToPlan(
      measured(plan, { frameCount: plan.promisedFrameCount - 5 }),
      plan,
      profile
    );
    expect(verification.mismatches).toContain('frame-count');
  });

  it.each([
    ['video-codec', { videoCodec: 'hevc' }],
    ['audio-codec', { audioCodec: 'opus' }],
    ['dimensions', { width: 720 }],
    ['pixel-format', { pixelFormat: 'yuvj420p' }]
  ] as const)('always fails a changed %s', (mismatch, overrides) => {
    const verification = compareToPlan(measured(plan, overrides), plan, profile);
    expect(verification.withinTolerance).toBe(false);
    expect(verification.mismatches).toContain(mismatch);
  });

  it('does not judge a frame count the probe could not read', () => {
    const verification = compareToPlan(measured(plan, { frameCount: 0 }), plan, profile);
    expect(verification.mismatches).not.toContain('frame-count');
  });
});
