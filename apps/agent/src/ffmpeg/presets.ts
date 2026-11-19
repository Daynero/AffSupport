import {
  STITCH_MIN_SCREEN_FRAMES,
  isHeldScreen,
  startImageDurationSeconds,
  type EncodingSettings,
  type ImageFitMode,
  type JobImageEmbedding
} from '@video-compressor/shared';
import { HELD_PICTURE_CRF, heldPictureEncoderArgs } from './held-picture.js';

/** The video track timescale every piece of a joined output is written with. */
export const HELD_SCREEN_TIMESCALE = 15360;

const evenLimit = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
const fitLongestSide = (limit: number) => {
  const value = evenLimit(limit);
  return `scale='if(gte(iw,ih),min(${value},iw),-2)':'if(gte(iw,ih),-2,min(${value},ih))'`;
};

const metadataArgs = (settings: EncodingSettings) =>
  settings.stripMetadata
    ? ['-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1']
    : [];

/** Build the shared H.264 codec arguments used by estimates and final encodes. */
export function videoCodecArgs(settings: EncodingSettings): string[] {
  const args = ['-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p'];

  if (settings.rateControl === 'bitrate' && settings.videoBitrateKbps) {
    const bitrate = settings.videoBitrateKbps;
    args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
  } else {
    args.push('-crf', String(settings.crf));
  }
  return args;
}

/** Build the shared H.264 arguments used by both estimation and a normal final encode. */
export function videoArgs(
  settings: EncodingSettings,
  sourceFrameRate: number | null = null
): string[] {
  const args = videoCodecArgs(settings);
  const filters: string[] = [];
  // When dropping frames, avoid scaling pictures the fps filter will discard. Keep the
  // old order for upsampling/unknown input rates so duplicated frames are scaled only once.
  const dropFirst =
    settings.frameRate !== null &&
    sourceFrameRate !== null &&
    Number.isFinite(sourceFrameRate) &&
    sourceFrameRate > settings.frameRate;
  if (dropFirst) filters.push(`fps=${settings.frameRate}`);
  if (settings.resolutionLimit) filters.push(fitLongestSide(settings.resolutionLimit));
  if (settings.frameRate && !dropFirst) filters.push(`fps=${settings.frameRate}`);
  if (filters.length) args.push('-vf', filters.join(','));
  return args;
}

/**
 * Thread arguments for the current resource budget.
 *
 * Returns nothing when unrestricted. That is deliberate, not an oversight: with
 * no limit set the command line must be byte-identical to the one this agent
 * shipped before the power throttle existed, and FFmpeg has never received a
 * `-threads` flag here. Injecting one — even `-threads <all cores>` — replaces
 * FFmpeg's own per-codec auto-detection and changes behaviour for every user
 * who never touches the control.
 */
export function threadArgs(threads: number | null): string[] {
  if (threads === null) return [];
  return ['-threads', String(threads), '-filter_threads', String(threads)];
}

/**
 * The sound of anything that will be joined to something else.
 *
 * A compressed body and the held screen that follows it are copied into one track with a
 * single sample description, and every frame after the first is decoded against it. Two
 * different AAC configurations there — a different profile, rate or channel count — give a
 * file FFmpeg reads perfectly and CoreAudio refuses outright, which is a video that plays
 * without sound in QuickTime, Safari, Telegram and Finder. The two passes used to carry
 * identical settings by coincidence; they carry them by construction now, so neither can be
 * tuned without the other.
 */
const JOINED_AUDIO = ['-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2'] as const;

export function buildFfmpegArgs(
  input: string,
  output: string,
  settings: EncodingSettings,
  forceAac = false,
  threads: number | null = null,
  sourceFrameRate: number | null = null
): string[] {
  const audio = forceAac ? ['-c:a', 'aac', '-b:a', '96k'] : ['-c:a', 'copy'];
  return [
    '-hide_banner',
    '-nostdin',
    '-n',
    ...threadArgs(threads),
    '-i',
    input,
    ...videoArgs(settings, sourceFrameRate),
    ...audio,
    ...metadataArgs(settings),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ];
}

export interface EmbeddedFfmpegOptions {
  /** Shared resource budget; null (the default) means unrestricted. */
  threads?: number | null;
  input: string;
  output: string;
  sourceStartSeconds?: number;
  sourceDurationSeconds: number;
  sourceHasAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  settings: EncodingSettings;
  imageEmbedding: JobImageEmbedding;
  startImagePath: string | null;
  endImagePath: string | null;
  /** Set when this encode is one half of a join, so both halves count time the same way. */
  videoTrackTimescale?: number | null;
}

export function buildEmbeddedFfmpegArgs(options: EmbeddedFfmpegOptions): string[] {
  const fps = decimal(options.frameRate);
  const sourceStart = decimal(options.sourceStartSeconds ?? 0);
  const sourceDuration = decimal(options.sourceDurationSeconds);
  const inputs = ['-i', options.input];
  const filters: string[] = [];
  const segments: { video: string; audio: string }[] = [];
  let inputIndex = 1;

  filters.push(
    `[0:v]trim=start=${sourceStart}:duration=${sourceDuration},setpts=PTS-STARTPTS,scale=${options.width}:${options.height}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${sourceDuration},trim=duration=${sourceDuration}[mainv]`
  );
  if (options.sourceHasAudio) {
    filters.push(
      `[0:a]atrim=start=${sourceStart}:duration=${sourceDuration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${sourceDuration},atrim=duration=${sourceDuration}[maina]`
    );
  } else {
    filters.push(silenceFilter(sourceDuration, 'maina'));
  }

  if (options.imageEmbedding.startImage && options.startImagePath) {
    const startSeconds = startImageDurationSeconds(options.imageEmbedding, options.frameRate);
    const startDuration = decimal(startSeconds, 9);
    // A CFR stream cannot hold a frame for less than one frame period. Trimming the looped
    // image by a sub-frame duration hangs FFmpeg, so below one frame we keep exactly one real
    // frame and let the (precise) silence length carry the requested offset into the timeline.
    const startVideoTrim =
      startSeconds >= 1 / options.frameRate ? `trim=duration=${startDuration}` : 'trim=end_frame=1';
    inputs.push('-loop', '1', '-framerate', fps, '-i', options.startImagePath);
    filters.push(
      `[${inputIndex}:v]${imageAdaptationFilter(options.width, options.height, options.imageEmbedding.fitMode)},fps=${fps},${startVideoTrim},setpts=PTS-STARTPTS[startv]`
    );
    filters.push(silenceFilter(startDuration, 'starta'));
    segments.push({ video: 'startv', audio: 'starta' });
    inputIndex++;
  }

  segments.push({ video: 'mainv', audio: 'maina' });

  if (
    options.imageEmbedding.endImage &&
    options.endImagePath &&
    options.imageEmbedding.finalDurationSeconds
  ) {
    const duration = decimal(options.imageEmbedding.finalDurationSeconds);
    inputs.push('-loop', '1', '-framerate', fps, '-i', options.endImagePath);
    filters.push(
      `[${inputIndex}:v]${imageAdaptationFilter(options.width, options.height, options.imageEmbedding.fitMode)},fps=${fps},trim=duration=${duration},setpts=PTS-STARTPTS[endv]`
    );
    filters.push(silenceFilter(duration, 'enda'));
    segments.push({ video: 'endv', audio: 'enda' });
  }

  const concatInputs = segments.map(segment => `[${segment.video}][${segment.audio}]`).join('');
  filters.push(
    `${concatInputs}concat=n=${segments.length}:v=1:a=1[concatenatedv][aout]`,
    `[concatenatedv]fps=${fps},format=yuv420p,setsar=1[vout]`
  );

  return [
    '-hide_banner',
    '-nostdin',
    '-n',
    ...threadArgs(options.threads ?? null),
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...videoCodecArgs(options.settings),
    ...JOINED_AUDIO,
    '-fps_mode',
    'cfr',
    ...(options.videoTrackTimescale
      ? ['-video_track_timescale', String(options.videoTrackTimescale)]
      : []),
    ...metadataArgs(options.settings),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    options.output
  ];
}

/**
 * Is this final image held long enough to be worth building on its own?
 *
 * Below a couple of seconds it is cheaper to leave it inside the main encode: the saving is
 * a handful of frames and the join costs more processes. Above it, the saving is the whole
 * run — a forty-five-minute image at thirty frames a second is eighty-one thousand copies
 * of one photograph, and they are assembled rather than encoded.
 */
export function heldFinalImageSeconds(
  embedding: JobImageEmbedding,
  _frameRate: number
): number | null {
  const seconds = embedding.finalDurationSeconds;
  if (!embedding.endImage || !seconds || !(seconds > 0)) return null;
  return isHeldScreen(seconds) ? seconds : null;
}

/** How many pictures a held final image is, and exactly how long that many last. */
export function heldScreenFrames(durationSeconds: number, frameRate: number) {
  const frames = Math.max(STITCH_MIN_SCREEN_FRAMES, Math.round(durationSeconds * frameRate));
  return { frames, seconds: frames / frameRate };
}

export interface HeldScreenPictureOptions {
  imagePath: string;
  output: string;
  width: number;
  height: number;
  frameRate: number;
  /** How many identical pictures this run writes — the seed, or a short screen whole. */
  frames: number;
  fitMode: ImageFitMode;
  threads?: number | null;
}

/**
 * The final image as a run of identical pictures at the body's frame rate, video only.
 *
 * The picture is decoded and fitted once and then cloned (`tpad`), so a run costs what its
 * encoding costs and nothing for the photograph. Every picture after the first is an empty
 * repeat (`heldPictureEncoderArgs`): the first one is the screen, at a quality asked for
 * outright rather than the job's — the job's rate control was chosen for moving video, and
 * in bitrate mode it would starve a single picture or flood it.
 *
 * A long screen is not made by this run alone. `buildHeldPicture` asks it for a short seed
 * and assembles the whole length from that by stream copy (see `held-picture.ts`).
 */
export function buildHeldScreenPictureArgs(options: HeldScreenPictureOptions): string[] {
  const frames = Math.max(STITCH_MIN_SCREEN_FRAMES, Math.round(options.frames));
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...threadArgs(options.threads ?? null),
    '-framerate',
    decimal(options.frameRate, 9),
    '-i',
    options.imagePath,
    '-vf',
    `${imageAdaptationFilter(options.width, options.height, options.fitMode)},tpad=stop_mode=clone:stop=-1,setpts=N/(${decimal(options.frameRate, 9)}*TB)`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    String(HELD_PICTURE_CRF),
    /*
     * No B-frames, and one keyframe for the run. The screen is assembled from this run's own
     * repeats by stream copy, which needs decode order and presentation order to be the same
     * order — and every picture is the same picture, so there is nothing for them to gain.
     */
    '-bf',
    '0',
    '-g',
    String(frames),
    ...heldPictureEncoderArgs(frames),
    '-an',
    '-fps_mode',
    'passthrough',
    '-video_track_timescale',
    String(HELD_SCREEN_TIMESCALE),
    options.output
  ];
}

export interface HeldScreenMuxOptions {
  videoPath: string;
  output: string;
  durationSeconds: number;
}

/**
 * The held picture and its silence, as the segment the join names.
 *
 * Built as a file rather than a branch of the main filter graph, and that is the whole
 * reason the held screen is its own pass. Joined inside the graph, FFmpeg writes a video
 * track two picture-intervals shorter than its own audio and the output fails its own
 * validation. A segment carries its exact duration in its container, and the concat demuxer
 * honours it.
 */
export function buildHeldScreenMuxArgs(options: HeldScreenMuxOptions): string[] {
  const held = decimal(options.durationSeconds);
  return [
    '-hide_banner',
    '-nostdin',
    '-n',
    '-i',
    options.videoPath,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=48000:cl=stereo:d=${held}`,
    '-filter_complex',
    '[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]',
    '-map',
    '0:v:0',
    '-map',
    '[a]',
    '-c:v',
    'copy',
    ...JOINED_AUDIO,
    '-t',
    held,
    '-video_track_timescale',
    String(HELD_SCREEN_TIMESCALE),
    options.output
  ];
}

export function buildEstimateArgs(
  input: string,
  output: string,
  start: number,
  duration: number,
  settings: EncodingSettings,
  sourceFrameRate: number | null = null
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    start.toFixed(3),
    '-i',
    input,
    '-t',
    duration.toFixed(3),
    ...videoArgs(settings, sourceFrameRate),
    '-an',
    '-f',
    'h264',
    output
  ];
}

export function buildStaticEstimateArgs(
  input: string,
  output: string,
  duration: number,
  width: number,
  height: number,
  frameRate: number,
  fitMode: ImageFitMode,
  settings: EncodingSettings
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loop',
    '1',
    '-framerate',
    decimal(frameRate),
    '-i',
    input,
    '-t',
    decimal(duration),
    ...videoCodecArgs(settings),
    '-vf',
    `${imageAdaptationFilter(width, height, fitMode)},fps=${decimal(frameRate)}`,
    '-an',
    '-f',
    'h264',
    output
  ];
}

export function imageAdaptationFilter(width: number, height: number, fitMode: ImageFitMode) {
  const scale =
    fitMode === 'stretch'
      ? `scale=${width}:${height}:flags=lanczos`
      : `scale=${width}:${height}:force_original_aspect_ratio=${fitMode === 'cover' ? 'increase' : 'decrease'}:flags=lanczos`;
  const frame =
    fitMode === 'cover'
      ? `crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2`
      : fitMode === 'contain'
        ? `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
        : '';
  return [scale, frame, 'setsar=1', 'format=yuv420p'].filter(Boolean).join(',');
}

function silenceFilter(duration: string, label: string) {
  return `anullsrc=r=48000:cl=stereo:d=${duration},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`;
}

function decimal(value: number, maximumFractionDigits = 6) {
  return Number(value.toFixed(maximumFractionDigits)).toString();
}
