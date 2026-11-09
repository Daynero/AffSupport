import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { SourceProfile, StitchPlan } from '@video-compressor/shared';
import {
  preparedBodyNeedsRecovery,
  PreparedBodyCache
} from '../apps/agent/src/stitcher/body-cache';
import {
  compareToPlan,
  toleranceSeconds,
  type MeasuredOutput
} from '../apps/agent/src/stitcher/verify';
const profile: SourceProfile = {
  path: '/fixtures/audio-60fps.mp4',
  sizeBytes: 8236376,
  modifiedAtMs: 1700000000000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  profile: 'High',
  level: 42,
  width: 1080,
  height: 1920,
  pixelFormat: 'yuv420p',
  colorRange: 'tv',
  frameRate: 60,
  variableFrameRate: false,
  videoTimescale: 15360,
  durationSeconds: 10.05,
  hasAudio: true,
  audioCodec: 'aac',
  audioSampleRate: 44100,
  audioChannels: 2,
  audioBitrateKbps: 96,
  keyframeTimes: [0]
};
const body = { bodyStartSeconds: 0.05, bodyEndSeconds: 10 };
const measured: MeasuredOutput = {
  durationSeconds: 10.006236,
  startTimeSeconds: 0,
  concatDurationSeconds: 10.055013,
  frameCount: 597,
  videoTrackSeconds: 10.055013,
  audioTrackSeconds: 10.006236,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1080,
  height: 1920,
  pixelFormat: 'yuv420p'
};
it('routes the actual 48.778ms 60fps/AAC body drift to existing recovery before the strict final join', () => {
  expect(toleranceSeconds(profile)).toBeCloseTo(0.0398866213, 9);
  expect(Math.abs(measured.videoTrackSeconds - measured.audioTrackSeconds)).toBeLessThan(0.25);
  expect(preparedBodyNeedsRecovery(measured, profile, body)).toBe(true);
  const final = {
    ...measured,
    durationSeconds: 10.039569,
    videoTrackSeconds: 10.088347,
    audioTrackSeconds: 10.039569,
    frameCount: 599
  };
  expect(
    compareToPlan(
      final,
      { promisedDurationSeconds: 10.088347, promisedFrameCount: 599 } as StitchPlan,
      profile
    ).mismatches
  ).toEqual(['tracks-disagree']);
});
it('retains a healthy body at the same final AAC-plus-video boundary and recovers just beyond it', () => {
  const video = 9.95,
    tolerance = toleranceSeconds(profile);
  expect(
    preparedBodyNeedsRecovery(
      { ...measured, videoTrackSeconds: video, audioTrackSeconds: video - tolerance + 0.000001 },
      profile,
      body
    )
  ).toBe(false);
  expect(
    preparedBodyNeedsRecovery(
      { ...measured, videoTrackSeconds: video, audioTrackSeconds: video - tolerance - 0.000001 },
      profile,
      body
    )
  ).toBe(true);
});
it('keeps silent media and content-loss protection separate from audio alignment recovery', () => {
  expect(preparedBodyNeedsRecovery({ ...measured, audioCodec: null }, profile, body)).toBe(true);
  expect(
    preparedBodyNeedsRecovery(
      { ...measured, audioCodec: null },
      { ...profile, hasAudio: false },
      body
    )
  ).toBe(false);
  expect(
    preparedBodyNeedsRecovery(
      { ...measured, videoTrackSeconds: 7 },
      { ...profile, hasAudio: false },
      body
    )
  ).toBe(true);
  expect(preparedBodyNeedsRecovery(null, profile, body)).toBe(true);
});
it('keeps strict final verification unchanged for the repaired actual 60fps fixture', () => {
  const fixed = {
    ...measured,
    durationSeconds: 9.997007,
    videoTrackSeconds: 10.006315,
    audioTrackSeconds: 9.997007,
    frameCount: 599
  };
  expect(
    compareToPlan(
      fixed,
      { promisedDurationSeconds: 10.006315, promisedFrameCount: 599 } as StitchPlan,
      profile
    )
  ).toMatchObject({ withinTolerance: true, mismatches: [] });
});

it('does not reuse a v8 body accepted under the old 250ms audio threshold', () => {
  // Fixed legacy cache schema, deliberately independent of the current key version.
  const legacy = createHash('sha256')
    .update(
      [
        'v8',
        path.resolve(profile.path),
        profile.sizeBytes,
        Math.round(profile.modifiedAtMs),
        profile.frameRate,
        body.bodyStartSeconds.toFixed(6),
        body.bodyEndSeconds.toFixed(6)
      ].join('|')
    )
    .digest('hex')
    .slice(0, 32);
  expect(
    new PreparedBodyCache({ root: '/cache' }).pathFor(profile, body as StitchPlan)
  ).not.toContain(legacy + '.mp4');
});
it('triggers recovery strictly but accepts a re-encoded body within the body tolerance', () => {
  // A B-frame cut leaves ~3 frames of video past the planned body; re-encoding cannot remove that.
  // Failing the recovered body there broke stitching that the final verification accepts.
  const quantised = { ...measured, videoTrackSeconds: 10.0249, audioTrackSeconds: 9.95 };
  expect(preparedBodyNeedsRecovery(quantised, profile, body)).toBe(true);
  expect(preparedBodyNeedsRecovery(quantised, profile, body, false)).toBe(false);
  const shifted = { ...measured, videoTrackSeconds: 9.95, audioTrackSeconds: 9.6 };
  expect(preparedBodyNeedsRecovery(shifted, profile, body, false)).toBe(true);
});
