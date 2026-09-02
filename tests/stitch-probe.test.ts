import { describe, expect, it } from 'vitest';
import { stitchUnsupportedReason } from '../packages/shared/src/stitcher.js';
import {
  buildKeyframeProbeArgs,
  buildSourceProbeArgs,
  parseKeyframeTimes,
  parseRational,
  parseTimescale,
  sourceProfileFromProbe
} from '../apps/agent/src/stitcher/probe.js';

/**
 * `ffprobe` output is the untrusted payload this feature depends on most: the screens are
 * rendered to it, the plan is computed from it, and the finished file is checked against it.
 * So it is narrowed, never cast — and a payload that cannot be narrowed says so.
 */

/**
 * Narrowing that fails the test rather than skipping it: a bare early return inside a test
 * callback reports as passed, which is the failure mode this repository lints against.
 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected a profile, got ${String(result.error)}`);
  return result.value;
}

const FILE = { path: '/videos/creative.mp4', sizeBytes: 7_356_009, modifiedAtMs: 1_700_000_000 };

const probePayload = (
  overrides: { video?: object; audio?: object | null; format?: object } = {}
) => ({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      level: 32,
      width: 1080,
      height: 1080,
      pix_fmt: 'yuv420p',
      color_range: 'tv',
      avg_frame_rate: '30/1',
      r_frame_rate: '30/1',
      time_base: '1/15360',
      duration: '50.033333',
      ...overrides.video
    },
    ...(overrides.audio === null
      ? []
      : [
          {
            codec_type: 'audio',
            codec_name: 'aac',
            sample_rate: '48000',
            channels: 2,
            bit_rate: '96165',
            ...overrides.audio
          }
        ])
  ],
  format: { duration: '50.033333', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', ...overrides.format }
});

describe('probe arguments', () => {
  it('asks for everything a screen has to match', () => {
    const args = buildSourceProbeArgs('/videos/creative.mp4').join(' ');
    for (const entry of ['pix_fmt', 'color_range', 'time_base', 'sample_rate', 'channels'])
      expect(args).toContain(entry);
  });

  it('reads keyframes off the index instead of decoding the file', () => {
    const args = buildKeyframeProbeArgs('/videos/creative.mp4');
    expect(args).toContain('-skip_frame');
    expect(args).toContain('nokey');
  });
});

describe('parsing helpers', () => {
  it('reads rationals and refuses the ones audio streams report', () => {
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 3);
    expect(parseRational('30/1')).toBe(30);
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });

  it('reads the timescale only from a unit time base', () => {
    expect(parseTimescale('1/15360')).toBe(15360);
    expect(parseTimescale('2/30')).toBeNull();
    expect(parseTimescale(null)).toBeNull();
  });

  it('reads and sorts keyframe times, ignoring anything that is not one', () => {
    expect(parseKeyframeTimes('8.333333,\n0.000000,\n\nnot-a-time\n16.666667,\n')).toEqual([
      0, 8.333333, 16.666667
    ]);
  });
});

describe('narrowing a payload', () => {
  it('produces a profile a screen can be rendered against', () => {
    const result = unwrap(sourceProfileFromProbe(probePayload(), FILE, [0, 8.333333]));
    expect(result).toMatchObject({
      videoCodec: 'h264',
      width: 1080,
      height: 1080,
      pixelFormat: 'yuv420p',
      colorRange: 'tv',
      frameRate: 30,
      videoTimescale: 15360,
      hasAudio: true,
      audioCodec: 'aac',
      audioSampleRate: 48000,
      audioChannels: 2,
      keyframeTimes: [0, 8.333333]
    });
    expect(stitchUnsupportedReason(result)).toBeNull();
  });

  it.each([
    ['not an object', 42],
    ['no streams at all', { format: { duration: '10' } }],
    ['audio only', { streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} }],
    ['a video stream with no size', probePayload({ video: { width: 0, height: 0 } })],
    [
      'a file whose duration is nowhere',
      {
        streams: probePayload({ video: { duration: undefined } }).streams,
        format: { format_name: 'mov,mp4' }
      }
    ]
  ])('refuses %s rather than casting it', (_label, payload) => {
    expect(sourceProfileFromProbe(payload, FILE)).toEqual({ ok: false, error: 'unreadable' });
  });

  it('reports a variable frame rate rather than averaging it away', () => {
    const result = unwrap(
      sourceProfileFromProbe(
        probePayload({ video: { r_frame_rate: '30/1', avg_frame_rate: '23.4/1' } }),
        FILE
      )
    );
    expect(result.variableFrameRate).toBe(true);
    expect(stitchUnsupportedReason(result)).toBe('variable-frame-rate');
  });

  it('treats a hundredth of a percent of jitter as constant', () => {
    const result = unwrap(
      sourceProfileFromProbe(
        probePayload({ video: { r_frame_rate: '30000/1001', avg_frame_rate: '29.97/1' } }),
        FILE
      )
    );
    expect(result.variableFrameRate).toBe(false);
  });

  it('accepts a video with no audio track', () => {
    const result = unwrap(sourceProfileFromProbe(probePayload({ audio: null }), FILE));
    expect(result.hasAudio).toBe(false);
    expect(result.audioSampleRate).toBeNull();
    expect(stitchUnsupportedReason(result)).toBeNull();
  });

  it('names the codec that cannot be served', () => {
    const hevc = unwrap(
      sourceProfileFromProbe(probePayload({ video: { codec_name: 'hevc' } }), FILE)
    );
    expect(stitchUnsupportedReason(hevc)).toBe('video-codec');

    const opus = unwrap(
      sourceProfileFromProbe(probePayload({ audio: { codec_name: 'opus' } }), FILE)
    );
    expect(stitchUnsupportedReason(opus)).toBe('audio-codec');
  });

  it('falls back to a derived timescale when the time base is unusable', () => {
    const result = unwrap(
      sourceProfileFromProbe(probePayload({ video: { time_base: '2/30' } }), FILE)
    );
    expect(result.videoTimescale).toBe(15360);
  });
});
