/**
 * Every FFmpeg invocation the stitcher makes, as a pure argument array.
 *
 * Pure because each flag here is a measurement rather than a preference (see
 * `specs/014-video-stitcher/research.md`), and a measurement that lives in a testable
 * function stays true. The two guards below are the ones that cost real time to discover:
 * a looped image shorter than one frame period hangs FFmpeg outright, and a screen muxed as
 * a single sample disappears at the join.
 */

import {
  STITCH_MIN_SCREEN_FRAMES,
  type ImageFitMode,
  type SourceProfile,
  type StitchScreenSegmentPlan
} from '@video-compressor/shared';
import { imageAdaptationFilter, threadArgs } from './presets.js';

export class StitchArgumentError extends Error {
  readonly code = 'STITCH_ARGUMENT_INVALID';

  constructor(reason: string) {
    super(reason);
    this.name = 'StitchArgumentError';
  }
}

export function isStitchArgumentError(error: unknown): error is StitchArgumentError {
  return error instanceof StitchArgumentError;
}

/** Trims trailing zeroes so `20.033333` stays readable and `45` never becomes `45.000000`. */
function decimal(value: number, maximumFractionDigits = 6): string {
  return Number(value.toFixed(maximumFractionDigits)).toString();
}

const BASE = ['-hide_banner', '-nostdin', '-y'] as const;

/**
 * `-profile:v`, but only when the source's profile is one x264 can be asked for.
 *
 * `ffprobe` reports names like `Constrained Baseline`, `High 10` and `High 4:4:4 Predictive`;
 * passing those through verbatim is not a mismatch, it is an invalid argument, and FFmpeg
 * exits before encoding anything. Anything unrecognised is left to the encoder's own default,
 * which is what the segments were matched on before this flag existed.
 */
export function h264ProfileArgs(profile: string | null): string[] {
  const name = (profile ?? '').trim().toLowerCase();
  if (name === 'high') return ['-profile:v', 'high'];
  if (name === 'main') return ['-profile:v', 'main'];
  if (name === 'baseline' || name === 'constrained baseline') return ['-profile:v', 'baseline'];
  return [];
}

/**
 * Encoder settings copied from the source, so what we add carries the body's own header.
 *
 * A finished file is one video track holding four pieces — two screens, sometimes a rebuilt
 * head, and the copied body — and every H.264 stream carries a sequence parameter set that
 * says how to decode it. An MP4's sample description holds **one**. FFmpeg reads the ones
 * carried in-band and plays such a file correctly; QuickTime, Safari and most phone players
 * read the sample description and stop at the first piece that disagrees with it. That is a
 * file that looks fine here and freezes three seconds in for the person it was made for.
 *
 * The one field that is both ours to set and worth setting is the **level**: the source said
 * 4.0 and x264 chose 3.2 for its own smaller job, so a single track announced two different
 * decoder requirements. FFmpeg and Apple's own decoder both cope, but a level is exactly the
 * kind of thing a stricter player allocates its buffers from, and a track has no business
 * changing it halfway through. Two fields are left — a screen's reference count and its
 * picture order type, which x264 derives from having no B-frames and offers no switch for.
 */
export function h264MatchArgs(profile: SourceProfile): string[] {
  return [
    ...h264ProfileArgs(profile.profile),
    ...(profile.level ? ['-level:v', String(profile.level)] : [])
  ];
}

export interface ScreenVideoOptions {
  imagePath: string;
  output: string;
  profile: SourceProfile;
  screen: StitchScreenSegmentPlan;
  fitMode: ImageFitMode;
  threads?: number | null;
}

/**
 * One static screen, encoded to the body's own parameters.
 *
 * `in_range=full:out_range=tv` plus `-color_range tv` are not decoration: a photo decoded
 * from JPEG is full-range `yuvj420p`, and without the conversion the segment disagrees with
 * the body at the seam and the photo shifts colour.
 */
export function buildScreenVideoArgs(options: ScreenVideoOptions): string[] {
  const { screen, profile } = options;
  if (screen.frames < STITCH_MIN_SCREEN_FRAMES)
    throw new StitchArgumentError('SCREEN_NEEDS_AT_LEAST_TWO_SAMPLES');
  if (!(screen.frameRate > 0) || !(screen.durationSeconds > 0))
    throw new StitchArgumentError('SCREEN_DURATION_INVALID');
  // `-loop 1 -framerate F -t D` with D below one frame period never terminates.
  if (screen.durationSeconds * screen.frameRate < 1)
    throw new StitchArgumentError('SCREEN_SHORTER_THAN_ONE_FRAME');

  const fit = imageAdaptationFilter(profile.width, profile.height, options.fitMode).replace(
    'flags=lanczos',
    'flags=lanczos:in_range=full:out_range=tv'
  );
  return [
    ...BASE,
    ...threadArgs(options.threads ?? null),
    '-loop',
    '1',
    '-framerate',
    decimal(screen.frameRate, 9),
    '-i',
    options.imagePath,
    '-t',
    decimal(screen.durationSeconds, 9),
    '-vf',
    fit,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    profile.pixelFormat || 'yuv420p',
    ...h264MatchArgs(profile),
    '-color_range',
    'tv',
    /*
     * No B-frames, and this one is not an optimisation.
     *
     * A B-frame makes decode order lag presentation order by a frame or two. At the body's
     * thirty frames a second that is a few milliseconds; at the end screen's **one** frame a
     * second it is two whole seconds, and the screen's timestamps then run backwards into the
     * body it is appended to. The measured result was an output whose video track ended two
     * seconds before its audio. A static picture gains nothing from B-frames anyway.
     */
    '-bf',
    '0',
    // Nothing to reference across a GOP boundary either: one keyframe at the front and none
    // after keeps a forty-second screen at a few kilobytes.
    '-g',
    String(Math.max(1, screen.frames)),
    '-an',
    '-video_track_timescale',
    String(profile.videoTimescale),
    options.output
  ];
}

export interface SilenceBankOptions {
  output: string;
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
  seconds: number;
}

/**
 * The silence bank, cut once per (sample rate, channels) and reused for every screen.
 *
 * Raw ADTS rather than `.m4a`: an MP4 audio track carries the encoder's priming delay in an
 * edit list, and every segment sliced from such a bank started 21 ms late — an offset the
 * concat demuxer then baked into the timeline as a seam.
 */
export function buildSilenceBankArgs(options: SilenceBankOptions): string[] {
  if (!(options.seconds > 0)) throw new StitchArgumentError('SILENCE_BANK_LENGTH_INVALID');
  const layout = options.channels >= 2 ? 'stereo' : 'mono';
  return [
    ...BASE,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=${options.sampleRate}:cl=${layout}`,
    '-t',
    decimal(options.seconds),
    '-c:a',
    'aac',
    '-b:a',
    `${options.bitrateKbps}k`,
    '-f',
    'adts',
    options.output
  ];
}

export interface SilenceSliceOptions {
  bankPath: string;
  aacFrames: number;
  output: string;
}

/**
 * Exactly N frames of silence.
 *
 * `-frames:a N`, never `-t D`: a duration returns the frame that *covers* it, so the audio
 * comes out longer than the picture it was supposed to match.
 */
export function buildSilenceSliceArgs(options: SilenceSliceOptions): string[] {
  if (!Number.isInteger(options.aacFrames) || options.aacFrames < 1)
    throw new StitchArgumentError('SILENCE_FRAME_COUNT_INVALID');
  return [
    ...BASE,
    '-i',
    options.bankPath,
    '-frames:a',
    String(options.aacFrames),
    '-c',
    'copy',
    '-f',
    'adts',
    options.output
  ];
}

/*
 * A movie timescale we choose, rather than one FFmpeg derives.
 *
 * Left alone, the muxer picks a timescale that can express both tracks exactly — for a held
 * screen at 15360 against 44.1 kHz audio that is 180,633,600 — and the movie duration then
 * needs 64 bits, so it writes version-1 `mvhd` and `elst` boxes. CoreAudio truncates that
 * edit list to 32 bits, which at such a timescale overflows after **twenty-four seconds**:
 * it then reads a forty-minute film as five seconds of valid audio and refuses the track
 * outright (`ExtAudioFileRead 'bada'`).
 *
 * The visible result was a re-stitched video that played with no sound at all in QuickTime,
 * Safari, Telegram and Finder's preview — while FFmpeg, which reads the tracks' own headers
 * and ignores the broken edit list, decoded it perfectly and reported nothing wrong. Every
 * check we had was an FFmpeg check.
 *
 * A thousand ticks a second is the muxer's own default elsewhere, keeps a forty-minute film
 * at 2.4 million units, and holds every box in 32 bits.
 */
const MOVIE_TIMESCALE = ['-movie_timescale', '1000'];

export interface SegmentMuxOptions {
  videoPath: string;
  audioPath: string | null;
  output: string;
  videoTimescale: number;
}

/** Joins a screen's picture and its silence into the segment the concat list will name. */
export function buildSegmentMuxArgs(options: SegmentMuxOptions): string[] {
  return [
    ...BASE,
    '-i',
    options.videoPath,
    ...(options.audioPath ? ['-i', options.audioPath] : []),
    '-c',
    'copy',
    '-video_track_timescale',
    String(options.videoTimescale),
    ...MOVIE_TIMESCALE,
    '-avoid_negative_ts',
    'make_zero',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    options.output
  ];
}

export interface BodyRemuxOptions {
  input: string;
  output: string;
  startSeconds: number;
  endSeconds: number;
  videoTimescale: number;
  /** The source's audio rate, so the one re-encode it takes is not a downgrade. */
  audioBitrateKbps?: number | null;
  /** The source's frame rate, which turns the range into an exact number of pictures. */
  frameRate: number;
}

/**
 * The body, copied rather than encoded, with its timestamps zeroed.
 *
 * Zeroing matters as much as copying: a body with B-frames starts at a negative DTS, and
 * concatenating it after a screen made that the loudest complaint at the seam.
 */
export function buildBodyRemuxArgs(options: BodyRemuxOptions): string[] {
  if (!(options.endSeconds > options.startSeconds))
    throw new StitchArgumentError('BODY_RANGE_INVALID');
  return [
    ...BASE,
    ...(options.startSeconds > 0 ? ['-ss', decimal(options.startSeconds)] : []),
    '-i',
    options.input,
    // A length, never an end time. With `-ss` as an input option FFmpeg counts `-to` from
    // the seek point rather than from the start of the file, and reading it the other way
    // produced a body twice as long as the plan promised — caught by the verification step,
    // which is precisely what that step is for.
    '-t',
    decimal(options.endSeconds - options.startSeconds),
    /*
     * …and the picture is cut by counting pictures.
     *
     * A length alone overshoots: the copy stops on a packet boundary, and with B-frames the
     * frames that trail in presentation order come along too — measured at four to six frames
     * past the cut, which on a body that ends where an old photo card begins is four to six
     * frames of that card left in front of the new one. The source is refused unless its
     * frame rate is constant, so the range is a whole number of pictures and can be asked for
     * as one. Audio still follows `-t`.
     */
    ...(options.frameRate > 0
      ? [
          '-frames:v',
          String(Math.round((options.endSeconds - options.startSeconds) * options.frameRate))
        ]
      : []),
    '-map',
    '0',
    '-c:v',
    'copy',
    /*
     * The audio is re-encoded, and only the audio.
     *
     * The screen's silence is AAC-LC, because that is what our encoder makes. A phone-shot
     * creative is very often HE-AAC, and joining the two puts two incompatible AAC
     * configurations in one track: CoreAudio reads the track description, meets frames it
     * does not fit, and refuses the whole track — a re-stitched video that plays with no
     * sound at all in QuickTime, Safari and Telegram. FFmpeg re-syncs per frame and never
     * noticed, so nothing we measured saw it.
     *
     * One AAC-LC generation on a body of seconds-to-minutes is the price of a track that
     * every player can read. The video is still copied, which is where the cost would be.
     */
    '-c:a',
    'aac',
    '-b:a',
    String(Math.max(128, Math.round(options.audioBitrateKbps ?? 128))) + 'k',
    '-video_track_timescale',
    String(options.videoTimescale),
    ...MOVIE_TIMESCALE,
    '-avoid_negative_ts',
    'make_zero',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    options.output
  ];
}

export interface HeadReencodeOptions {
  input: string;
  output: string;
  startSeconds: number;
  endSeconds: number;
  profile: SourceProfile;
  crf?: number;
  threads?: number | null;
}

/**
 * The one bounded exception to "never re-encode": the stretch between a cut point that is
 * not on a keyframe and the next keyframe.
 *
 * A copy cannot begin mid-GOP, and real creatives have keyframes only every eight seconds or
 * so with none at the boundary. Audio is still copied — only the picture has the problem.
 */
export function buildHeadReencodeArgs(options: HeadReencodeOptions): string[] {
  if (!(options.endSeconds > options.startSeconds))
    throw new StitchArgumentError('HEAD_RANGE_INVALID');
  const { profile } = options;
  return [
    ...BASE,
    ...threadArgs(options.threads ?? null),
    '-ss',
    decimal(options.startSeconds),
    '-i',
    options.input,
    // A length, for the same reason as the remux above.
    '-t',
    decimal(options.endSeconds - options.startSeconds),
    '-map',
    '0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(options.crf ?? 20),
    '-pix_fmt',
    profile.pixelFormat || 'yuv420p',
    ...h264MatchArgs(profile),
    '-fps_mode',
    'cfr',
    '-c:a',
    'copy',
    '-video_track_timescale',
    String(profile.videoTimescale),
    '-avoid_negative_ts',
    'make_zero',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    options.output
  ];
}

export interface ConcatOptions {
  listPath: string;
  output: string;
}

/**
 * The join: the concat demuxer straight into MP4 with `-c copy`.
 *
 * Measured against the folk-standard MPEG-TS intermediate, which produced corrupt packets, a
 * wrong duration and 21 decode errors on the same inputs. This route produced none, and the
 * muxer carries the segments' differing parameter sets in-band under one sample description.
 */
export function buildConcatArgs(options: ConcatOptions): string[] {
  return [
    ...BASE,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    options.listPath,
    '-map',
    '0',
    '-c',
    'copy',
    ...MOVIE_TIMESCALE,
    '-movflags',
    '+faststart',
    options.output
  ];
}

/**
 * The FFconcat list.
 *
 * The demuxer's own quoting rule: a single-quoted path ends the quote, escapes the quote,
 * and opens a new one. A path with an apostrophe in it is ordinary on macOS, so this is a
 * correctness requirement rather than a nicety.
 */
export function concatListContents(paths: readonly string[]): string {
  if (paths.length === 0) throw new StitchArgumentError('CONCAT_LIST_EMPTY');
  return `${paths.map(value => `file '${value.replaceAll("'", "'\\''")}'`).join('\n')}\n`;
}
