/**
 * Reading a source into the one description everything else works from.
 *
 * The screens are rendered to these numbers, the plan is computed from them, and the
 * finished file is checked against them — so this is a boundary in the constitution's sense:
 * `ffprobe` output arrives as `unknown` and leaves as a `SourceProfile` or a named reason,
 * never as a cast.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseSourceProfile, type SourceProfile } from '@video-compressor/shared';
import { ffprobePath } from '../ffmpeg/tools.js';
import { runTool, toolSucceeded } from './run.js';

export type ProbeFailure = 'unreadable' | 'tool-unavailable';

export function buildSourceProbeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,profile,level,width,height,pix_fmt,color_range,avg_frame_rate,r_frame_rate,time_base,sample_rate,channels,bit_rate,duration:format=duration,format_name',
    '-of',
    'json',
    input
  ];
}

/**
 * Keyframe times, which decide whether the body can be cut with a copy.
 *
 * `-skip_frame nokey` makes the decoder discard everything else, so this stays a fast pass
 * over the index rather than a decode of the whole file.
 */
export function buildKeyframeProbeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-skip_frame',
    'nokey',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=print_section=0',
    input
  ];
}

/**
 * Packet timestamps inside one window, for deciding whether a body is copyable.
 *
 * Packets rather than frames: no decode, and the presentation stamps are what a stream copy
 * has to keep. `-read_intervals` bounds the read to the window, so this stays a few
 * milliseconds even on a fifty-minute file.
 */
export function buildPacketTimingProbeArgs(
  input: string,
  startSeconds: number,
  windowSeconds: number
): string[] {
  const start = Math.max(0, Math.round(startSeconds * 1000) / 1000);
  const span = Math.max(0.5, Math.round(windowSeconds * 1000) / 1000);
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-read_intervals',
    `${start}%+${span}`,
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=print_section=0',
    input
  ];
}

/**
 * Whether the packets in one window are evenly spaced.
 *
 * `null` when the window says too little to judge — a handful of packets, or none at all —
 * so a caller can fall back rather than treat silence as an answer.
 */
export function packetTimingIsConstant(stdout: string, tolerance = 0.02): boolean | null {
  const times = parseKeyframeTimes(stdout);
  if (times.length < 6) return null;
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < 5) return null;
  const sorted = [...gaps].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (!(median > 0)) return null;
  // The extremes go: one long gap at a scene change is not a variable frame rate, and a
  // window that straddles a seam would otherwise fail on that seam alone.
  const trimmed = sorted.slice(1, -1).length >= 3 ? sorted.slice(1, -1) : sorted;
  return trimmed.every(gap => Math.abs(gap - median) / median <= tolerance);
}

export function parseKeyframeTimes(stdout: string): number[] {
  const times: number[] = [];
  for (const line of stdout.split('\n')) {
    const value = Number.parseFloat(line.trim().replace(/,+$/u, ''));
    if (Number.isFinite(value)) times.push(value);
  }
  return times.sort((a, b) => a - b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  const number = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `30000/1001` and friends. Returns null for `0/0`, which is what audio streams report. */
export function parseRational(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/');
  const top = Number.parseFloat(numerator);
  const bottom = denominator === undefined ? 1 : Number.parseFloat(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) return null;
  return top / bottom;
}

/** `1/15360` → 15360. The timescale every segment must be muxed with. */
export function parseTimescale(timeBase: unknown): number | null {
  if (typeof timeBase !== 'string') return null;
  const [numerator, denominator] = timeBase.split('/');
  if (Number.parseFloat(numerator) !== 1) return null;
  const scale = Number.parseFloat(denominator ?? '');
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

export interface SourceFileFacts {
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

/**
 * Narrows a raw probe payload into a `SourceProfile`.
 *
 * Pure, so the whole matrix of malformed and partial payloads is covered without FFmpeg.
 * A frame rate whose average and nominal values disagree by more than a percent is reported
 * as variable rather than averaged away: a copy of such a body cannot keep its timing.
 */
export function sourceProfileFromProbe(
  raw: unknown,
  file: SourceFileFacts,
  keyframeTimes: readonly number[] = [],
  /**
   * What the packet windows said about the body, when they were read.
   *
   * The average-against-nominal test below cannot tell a phone's uneven capture from a file
   * whose *ends* run at a different rate than its middle — and the second is exactly what
   * this product makes: a re-stitched video carries an end screen of up to forty-five
   * minutes at one frame a second, which drags the file's average far below its nominal rate
   * and made every video Soty stitched un-stitchable afterwards. The windows answer the
   * question that actually matters — are the body's frames evenly spaced — so when they
   * answer, they decide.
   */
  bodyTiming: boolean | null = null
): { ok: true; value: SourceProfile } | { ok: false; error: 'unreadable' } {
  if (!isRecord(raw)) return { ok: false, error: 'unreadable' };
  const streams = Array.isArray(raw.streams) ? raw.streams.filter(isRecord) : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio') ?? null;
  const format = isRecord(raw.format) ? raw.format : {};
  if (!video) return { ok: false, error: 'unreadable' };

  const nominal = parseRational(video.r_frame_rate);
  const average = parseRational(video.avg_frame_rate);
  const frameRate = average ?? nominal;
  const duration = positive(format.duration) ?? positive(video.duration);
  const width = positive(video.width);
  const height = positive(video.height);
  if (!frameRate || !duration || !width || !height) return { ok: false, error: 'unreadable' };

  const variableFrameRate =
    bodyTiming === null
      ? nominal !== null && average !== null && Math.abs(nominal - average) / nominal > 0.01
      : !bodyTiming;
  const colorRange = video.color_range;

  return parseSourceProfile({
    path: file.path,
    sizeBytes: file.sizeBytes,
    modifiedAtMs: file.modifiedAtMs,
    container: text(format.format_name) ?? '',
    videoCodec: text(video.codec_name) ?? '',
    profile: text(video.profile),
    level: positive(video.level),
    width,
    height,
    pixelFormat: text(video.pix_fmt) ?? 'yuv420p',
    colorRange: colorRange === 'pc' || colorRange === 'tv' ? colorRange : 'unknown',
    frameRate,
    variableFrameRate,
    videoTimescale: parseTimescale(video.time_base) ?? Math.round(frameRate * 512),
    durationSeconds: duration,
    hasAudio: Boolean(audio),
    audioCodec: audio ? text(audio.codec_name) : null,
    audioSampleRate: audio ? positive(audio.sample_rate) : null,
    audioChannels: audio ? positive(audio.channels) : null,
    audioBitrateKbps: audio ? (positive(audio.bit_rate) ?? 96_000) / 1000 : null,
    keyframeTimes: [...keyframeTimes]
  }) as { ok: true; value: SourceProfile } | { ok: false; error: 'unreadable' };
}

/**
 * Two ffprobe passes: what the file is, and where its keyframes are.
 *
 * The keyframe pass is allowed to come back empty — a source whose index cannot be read is
 * simply treated as having no usable keyframe but its own start, which the planner turns
 * into a head rebuild rather than a refusal.
 *
 * It can also be skipped outright with `keyframes: false`. Reading every keyframe of a
 * fifty-minute file takes five seconds, and adding a file to the list needs none of them:
 * the row shows what the first pass answers, and the run reads the index when it is the run
 * that is waiting rather than the person who just dropped a video.
 */
export async function probeSource(
  input: string,
  options: { signal?: AbortSignal; keyframes?: boolean } = {}
): Promise<{ ok: true; value: SourceProfile } | { ok: false; error: ProbeFailure }> {
  let facts: SourceFileFacts;
  try {
    const stats = await stat(input);
    facts = { path: path.resolve(input), sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs };
  } catch {
    return { ok: false, error: 'unreadable' };
  }

  const description = await runTool(ffprobePath, buildSourceProbeArgs(input), options);
  if (description.spawnErrorCode) return { ok: false, error: 'tool-unavailable' };
  if (!toolSucceeded(description)) return { ok: false, error: 'unreadable' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(description.stdout);
  } catch {
    return { ok: false, error: 'unreadable' };
  }

  let keyframeTimes: number[] = [];
  if (options.keyframes !== false) {
    const keyframes = await runTool(ffprobePath, buildKeyframeProbeArgs(input), options);
    if (toolSucceeded(keyframes)) keyframeTimes = parseKeyframeTimes(keyframes.stdout);
  }

  /*
   * The second opinion, asked only when the first one would refuse the file.
   *
   * Two short windows, away from the ends where this product's own screens live. Both have
   * to be evenly spaced for the file to count as constant — one window could sit inside an
   * end screen, which is evenly spaced too, so a single agreeing window proves nothing about
   * the rest.
   */
  const first = sourceProfileFromProbe(parsed, facts, keyframeTimes);
  if (!first.ok || !first.value.variableFrameRate || first.value.durationSeconds < 8) {
    return first;
  }
  const timing = await bodyTimingIsConstant(input, first.value.durationSeconds, options);
  if (timing === null) return first;
  return sourceProfileFromProbe(parsed, facts, keyframeTimes, timing);
}

/**
 * Reads a few seconds of packet timestamps near the front of the file and says whether the
 * frames there are evenly spaced.
 *
 * Near the front, deliberately. The thing being measured is the *body* — the part a stitch
 * copies without re-timing — and in this product's own output the body is at the start while
 * an end screen of up to forty-five minutes at a frame every several seconds sits behind it.
 * Windows placed by percentage of the duration landed in that screen, which holds one frame
 * per window and can say nothing at all; the file was then refused for a variable frame rate
 * it does not have in the only place that matters.
 *
 * `variable` as soon as one window is uneven — that is what an actual variable capture looks
 * like, in every window of it. `constant` when a window could be read and none disagreed.
 * `null` when nothing could be measured, and the caller keeps the cheap verdict.
 */
async function bodyTimingIsConstant(
  input: string,
  durationSeconds: number,
  options: { signal?: AbortSignal }
): Promise<boolean | null> {
  const windowSeconds = 4;
  const offsets = [3, 15, 45].filter(start => start + windowSeconds < durationSeconds);
  if (offsets.length === 0) offsets.push(0);
  let sawConstant = false;
  for (const start of offsets) {
    const sampled = await runTool(
      ffprobePath,
      buildPacketTimingProbeArgs(input, start, windowSeconds),
      options
    );
    if (!toolSucceeded(sampled)) return null;
    const constant = packetTimingIsConstant(sampled.stdout);
    if (constant === false) return false;
    if (constant === true) sawConstant = true;
  }
  return sawConstant ? true : null;
}
