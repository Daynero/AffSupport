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
  keyframeTimes: readonly number[] = []
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
    nominal !== null && average !== null && Math.abs(nominal - average) / nominal > 0.01;
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

  return sourceProfileFromProbe(parsed, facts, keyframeTimes);
}
