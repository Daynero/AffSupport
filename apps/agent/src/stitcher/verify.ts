/**
 * Proving the file before it is handed over.
 *
 * Not decoration. The experiments behind this feature produced both kinds of deviation: a
 * 21-millisecond difference from the nominal length, which is one AAC frame and harmless,
 * and a two-second disagreement between the video and audio tracks, which is a broken file.
 * A tolerance that admits the first and refuses the second is the difference between a tool
 * that can be trusted unattended and one that cannot.
 */

import {
  AAC_FRAME_SAMPLES,
  type SourceProfile,
  type StitchPlan,
  type StitchVerification
} from '@video-compressor/shared';
import { ffprobePath } from '../ffmpeg/tools.js';
import { runTool, toolSucceeded } from './run.js';

export interface MeasuredOutput {
  durationSeconds: number;
  frameCount: number;
  videoTrackSeconds: number;
  audioTrackSeconds: number;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  pixelFormat: string;
}

export function buildVerifyProbeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    // Packets, not frames: counting frames decodes the whole file, which on a minute of
    // 1080×1080 costs more than the run it is checking. Every H.264 packet in an MP4 is one
    // frame, so the count is the same and it comes off the index.
    '-count_packets',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,pix_fmt,duration,nb_read_packets:format=duration',
    '-of',
    'json',
    input
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function measurementFromProbe(raw: unknown): MeasuredOutput | null {
  if (!isRecord(raw)) return null;
  const streams = Array.isArray(raw.streams) ? raw.streams.filter(isRecord) : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio') ?? null;
  const format = isRecord(raw.format) ? raw.format : {};
  if (!video) return null;
  const duration = number(format.duration);
  const videoSeconds = number(video.duration) ?? duration;
  if (duration === null || videoSeconds === null) return null;
  return {
    durationSeconds: duration,
    frameCount: number(video.nb_read_packets) ?? number(video.nb_read_frames) ?? 0,
    videoTrackSeconds: videoSeconds,
    audioTrackSeconds: audio ? (number(audio.duration) ?? duration) : videoSeconds,
    videoCodec: typeof video.codec_name === 'string' ? video.codec_name : '',
    audioCodec: audio && typeof audio.codec_name === 'string' ? audio.codec_name : null,
    width: number(video.width) ?? 0,
    height: number(video.height) ?? 0,
    pixelFormat: typeof video.pix_fmt === 'string' ? video.pix_fmt : ''
  };
}

/**
 * How far a finished file may sit from its plan.
 *
 * One AAC frame plus one video frame, because those are the two quanta the pipeline rounds
 * to and neither can be avoided: silence is cut in whole AAC frames and pictures are whole
 * frames. Anything larger is a defect, not rounding.
 */
export function toleranceSeconds(profile: SourceProfile): number {
  const audio = profile.hasAudio ? AAC_FRAME_SAMPLES / (profile.audioSampleRate ?? 48000) : 0;
  const video = profile.frameRate > 0 ? 1 / profile.frameRate : 0.04;
  return audio + video;
}

/** Pure comparison, so every boundary of the tolerance is testable without FFmpeg. */
export function compareToPlan(
  measured: MeasuredOutput,
  plan: StitchPlan,
  profile: SourceProfile
): StitchVerification {
  const tolerance = toleranceSeconds(profile);
  const mismatches: string[] = [];

  /*
   * Length is judged on the video track, not on the container's own duration.
   *
   * An MP4's `format.duration` is derived, and the muxer legitimately rounds it up past the
   * last sample — measured at 54 ms beyond both tracks on a file whose tracks agreed with
   * each other to within 8 ms. Judging the derived number failed a correct file. The track
   * is the content; the container gets a looser check, so a header that disagrees wildly
   * with what it contains is still caught.
   */
  if (Math.abs(measured.videoTrackSeconds - plan.promisedDurationSeconds) > tolerance)
    mismatches.push('duration');
  if (Math.abs(measured.durationSeconds - plan.promisedDurationSeconds) > tolerance * 4)
    mismatches.push('container-duration');
  if (Math.abs(measured.videoTrackSeconds - measured.audioTrackSeconds) > tolerance)
    mismatches.push('tracks-disagree');
  // A frame either exists or it does not; the plan's own rounding is the only slack.
  if (measured.frameCount > 0 && Math.abs(measured.frameCount - plan.promisedFrameCount) > 1)
    mismatches.push('frame-count');
  if (measured.videoCodec !== profile.videoCodec) mismatches.push('video-codec');
  if (profile.hasAudio && measured.audioCodec !== profile.audioCodec)
    mismatches.push('audio-codec');
  if (measured.width !== profile.width || measured.height !== profile.height)
    mismatches.push('dimensions');
  if (measured.pixelFormat !== profile.pixelFormat) mismatches.push('pixel-format');

  return {
    durationSeconds: measured.durationSeconds,
    frameCount: measured.frameCount,
    videoTrackSeconds: measured.videoTrackSeconds,
    audioTrackSeconds: measured.audioTrackSeconds,
    videoCodec: measured.videoCodec,
    audioCodec: measured.audioCodec,
    width: measured.width,
    height: measured.height,
    pixelFormat: measured.pixelFormat,
    withinTolerance: mismatches.length === 0,
    mismatches
  };
}

/**
 * What a segment actually came out as.
 *
 * A stream copy can only cut on packet boundaries, so a body asked for 20.000 s comes back
 * as 20.152 s — perfectly correct, and not what the plan predicted before the cut. The run
 * is therefore checked against the parts it actually assembled rather than against an
 * estimate made before any of them existed.
 *
 * Both lengths come back, because which one is right depends on what happens to the segment
 * next. Concatenated, each part advances the timeline by its **container** duration, so that
 * is what the joined file will be made of. Left alone — a removal, where the body *is* the
 * result — the finished file keeps the body's own **video track** length. Promising the
 * wrong one of the two failed a correct file by half a millisecond over tolerance.
 */
export async function measureSegment(
  input: string,
  options: { signal?: AbortSignal } = {}
): Promise<{ durationSeconds: number; videoTrackSeconds: number; frameCount: number } | null> {
  const probe = await runTool(ffprobePath, buildVerifyProbeArgs(input), options);
  if (!toolSucceeded(probe)) return null;
  try {
    const measured = measurementFromProbe(JSON.parse(probe.stdout));
    return measured
      ? {
          durationSeconds: measured.durationSeconds,
          videoTrackSeconds: measured.videoTrackSeconds,
          frameCount: measured.frameCount
        }
      : null;
  } catch {
    return null;
  }
}

/** Probes a finished file and compares it with the plan it was built from. */
export async function verifyOutput(
  outputPath: string,
  plan: StitchPlan,
  profile: SourceProfile,
  options: { signal?: AbortSignal } = {}
): Promise<StitchVerification | null> {
  const probe = await runTool(ffprobePath, buildVerifyProbeArgs(outputPath), options);
  if (!toolSucceeded(probe)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    return null;
  }
  const measured = measurementFromProbe(parsed);
  return measured ? compareToPlan(measured, plan, profile) : null;
}
