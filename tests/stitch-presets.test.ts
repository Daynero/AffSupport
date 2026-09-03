import { describe, expect, it } from 'vitest';
import type { SourceProfile, StitchScreenSegmentPlan } from '../packages/shared/src/stitcher.js';
import {
  StitchArgumentError,
  buildBodyRemuxArgs,
  buildConcatArgs,
  buildHeadReencodeArgs,
  buildScreenVideoArgs,
  buildSegmentMuxArgs,
  buildSilenceBankArgs,
  buildSilenceSliceArgs,
  concatListContents,
  h264ProfileArgs
} from '../apps/agent/src/ffmpeg/stitch-presets.js';

/**
 * The argument builders are where every measured finding in research.md turns into a flag.
 * They are pure, so the findings can be pinned without running FFmpeg — and pinning them is
 * the point: each of these flags was arrived at by watching the alternative fail.
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

const endScreen: StitchScreenSegmentPlan = {
  frames: 45,
  frameRate: 1,
  durationSeconds: 45,
  aacFrames: 2109
};

const startScreen: StitchScreenSegmentPlan = {
  frames: 2,
  frameRate: 30,
  durationSeconds: 2 / 30,
  aacFrames: 3
};

/** The value that follows a flag, so assertions read as pairs rather than as indexes. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.lastIndexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('screen segments carry the body’s own parameters (D5)', () => {
  const args = buildScreenVideoArgs({
    imagePath: '/photos/a.jpg',
    output: '/tmp/screen.mp4',
    profile,
    screen: endScreen,
    fitMode: 'cover'
  });

  it('renders at the body’s frame size and pixel format', () => {
    const filter = valueAfter(args, '-vf') ?? '';
    expect(filter).toContain('1080:1080');
    expect(filter).toContain('format=yuv420p');
  });

  it('converts the photo out of JPEG full range, in the filter and on the encoder', () => {
    expect(valueAfter(args, '-vf')).toContain('in_range=full:out_range=tv');
    expect(valueAfter(args, '-color_range')).toBe('tv');
  });

  it('copies the body’s timescale rather than a house number', () => {
    expect(valueAfter(args, '-video_track_timescale')).toBe('15360');
    expect(
      valueAfter(
        buildScreenVideoArgs({
          imagePath: '/photos/a.jpg',
          output: '/tmp/screen.mp4',
          profile: { ...profile, videoTimescale: 12800 },
          screen: endScreen,
          fitMode: 'cover'
        }),
        '-video_track_timescale'
      )
    ).toBe('12800');
  });

  it('keeps the body’s H.264 profile, and only when it is one that can be asked for', () => {
    expect(valueAfter(args, '-profile:v')).toBe('high');
    // ffprobe reports names x264 does not accept; passing one through is an invalid
    // argument, and FFmpeg exits before encoding anything.
    expect(h264ProfileArgs('Constrained Baseline')).toEqual(['-profile:v', 'baseline']);
    expect(h264ProfileArgs('High 4:4:4 Predictive')).toEqual([]);
    expect(h264ProfileArgs(null)).toEqual([]);
  });

  it('encodes the long end screen at one picture per second (D2)', () => {
    expect(valueAfter(args, '-framerate')).toBe('1');
    expect(valueAfter(args, '-t')).toBe('45');
    expect(args).toContain('-loop');
  });

  it('carries no audio — silence is added at the mux (D4)', () => {
    expect(args).toContain('-an');
  });

  it('encodes without B-frames, so a 1 fps screen cannot reorder into the body', () => {
    // At one frame a second the decode-order lag a B-frame introduces is measured in
    // seconds; the measured symptom was a video track ending two seconds before its audio.
    expect(valueAfter(args, '-bf')).toBe('0');
  });

  it('never runs through a shell: every argument is its own array entry', () => {
    expect(args.every(argument => typeof argument === 'string')).toBe(true);
    expect(args.some(argument => argument.includes(' && ') || argument.includes('|'))).toBe(false);
  });
});

describe('the start screen', () => {
  it('is encoded at the body\u2019s own frame rate, for at least two samples (D3)', () => {
    const args = buildScreenVideoArgs({
      imagePath: '/photos/a.jpg',
      output: '/tmp/intro.mp4',
      profile,
      screen: startScreen,
      fitMode: 'contain'
    });
    expect(valueAfter(args, '-framerate')).toBe('30');
    expect(valueAfter(args, '-vf')).toContain('pad=1080:1080');
    expect(Number(valueAfter(args, '-t'))).toBeCloseTo(2 / 30, 6);
  });
});

describe('the guards research.md paid for', () => {
  it('refuses a looped image shorter than one frame period (D8)', () => {
    expect(() =>
      buildScreenVideoArgs({
        imagePath: '/photos/a.jpg',
        output: '/tmp/screen.mp4',
        profile,
        screen: { frames: 2, frameRate: 1, durationSeconds: 0.042667, aacFrames: 2 },
        fitMode: 'cover'
      })
    ).toThrow(StitchArgumentError);
  });

  it('refuses a single-sample screen (D3)', () => {
    expect(() =>
      buildScreenVideoArgs({
        imagePath: '/photos/a.jpg',
        output: '/tmp/screen.mp4',
        profile,
        screen: { frames: 1, frameRate: 1, durationSeconds: 1, aacFrames: 47 },
        fitMode: 'cover'
      })
    ).toThrow(StitchArgumentError);
  });

  it('accepts the short end screen that falls back to the body frame rate', () => {
    expect(() =>
      buildScreenVideoArgs({
        imagePath: '/photos/a.jpg',
        output: '/tmp/screen.mp4',
        profile,
        screen: { frames: 30, frameRate: 30, durationSeconds: 1, aacFrames: 47 },
        fitMode: 'cover'
      })
    ).not.toThrow();
  });
});

describe('silence (D4)', () => {
  it('builds the bank as raw ADTS, which carries no priming edit list', () => {
    const args = buildSilenceBankArgs({
      output: '/support/silence-48000-2.aac',
      sampleRate: 48000,
      channels: 2,
      bitrateKbps: 96,
      seconds: 60
    });
    expect(valueAfter(args, '-f')).toBe('adts');
    expect(valueAfter(args, '-i')).toContain('anullsrc=r=48000:cl=stereo');
    expect(valueAfter(args, '-t')).toBe('60');
  });

  it('slices by exact frame count, never by a duration', () => {
    const args = buildSilenceSliceArgs({
      bankPath: '/support/silence-48000-2.aac',
      aacFrames: 2109,
      output: '/tmp/silence.aac'
    });
    expect(valueAfter(args, '-frames:a')).toBe('2109');
    expect(args).not.toContain('-t');
    expect(valueAfter(args, '-c')).toBe('copy');
  });

  it('refuses to slice nothing', () => {
    expect(() =>
      buildSilenceSliceArgs({ bankPath: '/bank.aac', aacFrames: 0, output: '/tmp/s.aac' })
    ).toThrow(StitchArgumentError);
  });
});

describe('muxing a segment', () => {
  it('copies both tracks and zeroes the timestamps', () => {
    const args = buildSegmentMuxArgs({
      videoPath: '/tmp/screen.mp4',
      audioPath: '/tmp/silence.aac',
      output: '/tmp/segment.mp4',
      videoTimescale: 15360
    });
    expect(valueAfter(args, '-c')).toBe('copy');
    expect(valueAfter(args, '-avoid_negative_ts')).toBe('make_zero');
    // A movie timescale we choose. Left to FFmpeg it becomes the tracks' common multiple —
    // 180,633,600 for a held screen against 44.1 kHz — the duration then needs 64 bits, and
    // CoreAudio truncates the edit list it writes: a forty-minute film reads as five seconds
    // of valid audio and the track is refused outright.
    expect(valueAfter(args, '-movie_timescale')).toBe('1000');
    expect(valueAfter(args, '-muxdelay')).toBe('0');
    expect(valueAfter(args, '-video_track_timescale')).toBe('15360');
  });

  it('produces a video-only segment when the source has no audio', () => {
    const args = buildSegmentMuxArgs({
      videoPath: '/tmp/screen.mp4',
      audioPath: null,
      output: '/tmp/segment.mp4',
      videoTimescale: 15360
    });
    expect(args.filter(argument => argument === '-i')).toHaveLength(1);
  });
});

describe('preparing the body (D6)', () => {
  it('copies the streams and normalises the timestamps', () => {
    const args = buildBodyRemuxArgs({
      input: '/videos/creative.mp4',
      output: '/cache/body.mp4',
      startSeconds: 0,
      endSeconds: 20.033333,
      videoTimescale: 15360,
      frameRate: 30
    });
    // The picture is copied; the sound is not, and deliberately. The screen's silence is
    // AAC-LC, a phone-shot creative is often HE-AAC, and two AAC configurations in one track
    // is a file CoreAudio refuses outright.
    expect(valueAfter(args, '-c:v')).toBe('copy');
    expect(valueAfter(args, '-c:a')).toBe('aac');
    expect(valueAfter(args, '-avoid_negative_ts')).toBe('make_zero');
    expect(valueAfter(args, '-movie_timescale')).toBe('1000');
    // A length rather than an end time: with input seeking FFmpeg reads `-to` from the seek
    // point, which once produced a body twice as long as promised.
    expect(valueAfter(args, '-t')).toBe('20.033333');
    expect(args).not.toContain('-to');
  });

  it('omits an -ss of zero rather than seeking to the start', () => {
    const args = buildBodyRemuxArgs({
      input: '/videos/creative.mp4',
      output: '/cache/body.mp4',
      startSeconds: 0,
      endSeconds: 20,
      videoTimescale: 15360,
      frameRate: 30
    });
    expect(args).not.toContain('-ss');
  });

  it("announces the source's own level on everything it encodes", () => {
    const args = buildHeadReencodeArgs({
      input: '/videos/creative.mp4',
      output: '/cache/head.mp4',
      startSeconds: 0.033333,
      endSeconds: 8.333333,
      profile: { ...profile, level: 40 }
    });
    /* One track, one decoder requirement. x264 picks a level to suit its own small job — 3.2
       against the source's 4.0 — and a track that changes level halfway through is a track a
       strict player may have allocated the wrong buffers for. */
    expect(valueAfter(args, '-level:v')).toBe('40');
  });

  it('cuts the picture by counting pictures, not by length alone', () => {
    const args = buildBodyRemuxArgs({
      input: '/videos/creative.mp4',
      output: '/cache/body.mp4',
      startSeconds: 0.033333,
      endSeconds: 113.067,
      videoTimescale: 15360,
      frameRate: 30
    });
    // A length alone lets the frames that trail in presentation order come along — four to
    // six of them, which on a body that ends where an old photo card begins is that card
    // showing in front of the new screen.
    expect(valueAfter(args, '-frames:v')).toBe('3391');
    expect(valueAfter(args, '-t')).toBe('113.033667');
  });

  it('rebuilds only the head, and only up to the next keyframe', () => {
    const args = buildHeadReencodeArgs({
      input: '/videos/creative.mp4',
      output: '/cache/head.mp4',
      startSeconds: 0.033333,
      endSeconds: 8.333333,
      profile
    });
    expect(valueAfter(args, '-ss')).toBe('0.033333');
    expect(valueAfter(args, '-t')).toBe('8.3');
    expect(args).not.toContain('-to');
    expect(valueAfter(args, '-c:v')).toBe('libx264');
    // The audio is never re-encoded even here: only the picture cannot be copied mid-GOP.
    expect(valueAfter(args, '-c:a')).toBe('copy');
    expect(valueAfter(args, '-video_track_timescale')).toBe('15360');
  });
});

describe('joining (D1)', () => {
  it('uses the concat demuxer and copies, straight into MP4', () => {
    const args = buildConcatArgs({ listPath: '/tmp/list.txt', output: '/out/result.mp4' });
    expect(valueAfter(args, '-f')).toBe('concat');
    expect(valueAfter(args, '-safe')).toBe('0');
    expect(valueAfter(args, '-c')).toBe('copy');
    expect(valueAfter(args, '-movflags')).toBe('+faststart');
    // The MPEG-TS intermediate route measured 21 decode errors and a wrong duration.
    expect(args.join(' ')).not.toContain('mpegts');
  });

  it('writes a list whose quoting survives a path with a quote in it', () => {
    const contents = concatListContents(["/tmp/it's here/intro.mp4", '/tmp/body.mp4']);
    expect(contents.split('\n')[0]).toBe("file '/tmp/it'\\''s here/intro.mp4'");
    expect(contents.trimEnd().split('\n')).toHaveLength(2);
  });

  it('refuses an empty join', () => {
    expect(() => concatListContents([])).toThrow(StitchArgumentError);
  });
});
