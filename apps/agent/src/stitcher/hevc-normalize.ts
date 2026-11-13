import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { type SourceProfile } from '@video-compressor/shared';
import { ffmpegPath, ffprobePath } from '../ffmpeg/tools.js';
import { activeThreadBudget, scaled } from '../power/spawn.js';
import { diagnostics, durationBucket } from '../server/diagnostics-log.js';
import { probeSource } from './probe.js';
import { runTool, toolSucceeded } from './run.js';
import { hdrFilter, writeHdrLuts, type HdrPrimaries, type HdrTransfer } from './hevc-color.js';
import { VerifiedSourceCache } from './verified-source-cache.js';

export const HEVC_COMPATIBILITY_POLICY = 'hevc-h264-sdr-v1';
interface Stream {
  index: number;
  codec: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  colorTransfer: string;
  primaries: HdrPrimaries;
  matrix: 'bt709' | 'bt2020' | 'smpte170m';
  range: 'tv' | 'pc';
  rotation: number;
  sar: number;
  peak: number;
  audioIndex: number | null;
  audioChannels: number;
  hdr: HdrTransfer | null;
  hdrSideData: boolean;
  audioDuration: number | null;
  audioStart: number;
  videoDuration: number | null;
  videoStart: number;
}
export interface HevcCompatibilityInput {
  sourceFile: string;
  workspace: string;
  sourceIdentity?: string | null;
  signal: AbortSignal;
  runId: string;
  threads?: number | null;
  onProgress?: (fraction: number) => void;
  onStage?: (stage: 'converting' | 'verifying') => void;
}
type Reason =
  | 'metadata'
  | 'encode'
  | 'verify'
  | 'source_changed'
  | 'cancelled'
  | 'timeout'
  | 'disk_full'
  | 'cache';
const KNOWN = new Set([
  'SOURCE_CHANGED',
  'PROCESS_CANCELED',
  'PROCESS_TIMEOUT',
  'STITCH_TOOL_FAILED',
  'STITCH_VERIFICATION_FAILED'
]);

/** Source-only conversion. The caller still owns the original and catalog delivery. */
export class HevcCompatibility {
  private readonly cache: VerifiedSourceCache;
  constructor(options: { root?: string; maxBytes?: number } = {}) {
    this.cache = new VerifiedSourceCache(options);
  }
  async prepare(input: HevcCompatibilityInput): Promise<{
    file: string;
    profile: SourceProfile;
    sourceIdentity: string | null;
    fromCache: boolean;
  }> {
    const started = performance.now();
    const attemptId = randomUUID();
    let sharedId: string | undefined;
    const props = () => ({
      runId: input.runId,
      operationId: input.runId,
      attemptId,
      ...(sharedId ? { normalizationId: sharedId } : {}),
      recipe: 1
    });
    diagnostics.record('stitcher', 'hevc_normalization_started', props());
    try {
      const result = await this.cache.prepare({
        sourceFile: input.sourceFile,
        workspace: input.workspace,
        sourceIdentity: input.sourceIdentity,
        policy: HEVC_COMPATIBILITY_POLICY,
        signal: input.signal,
        onProgress: input.onProgress,
        onStage: (stage, id) => {
          sharedId = id;
          diagnostics.record('stitcher', 'hevc_normalization_stage', { ...props(), stage });
          if (stage === 'converting' || stage === 'verifying') input.onStage?.(stage);
        },
        produce: (directory, source, signal, progress, verifying) =>
          convert(
            directory,
            source,
            signal,
            input.threads ?? activeThreadBudget(),
            progress,
            verifying
          )
      });
      diagnostics.record('stitcher', 'hevc_normalization_completed', {
        ...props(),
        fromCache: result.fromCache,
        durationBucket: durationBucket(performance.now() - started)
      });
      return {
        ...result,
        sourceIdentity: `sha256:${result.digest}:${result.profile.sizeBytes}|${HEVC_COMPATIBILITY_POLICY}`
      };
    } catch (error) {
      const code = input.signal.aborted
        ? 'PROCESS_CANCELED'
        : error instanceof Error && KNOWN.has(error.message)
          ? error.message
          : 'STITCH_TOOL_FAILED';
      const reason: Reason = input.signal.aborted
        ? 'cancelled'
        : code === 'SOURCE_CHANGED'
          ? 'source_changed'
          : code === 'PROCESS_TIMEOUT'
            ? 'timeout'
            : record(error) && error.code === 'ENOSPC'
              ? 'disk_full'
              : record(error) && knownReason(error.reason)
                ? error.reason
                : 'cache';
      diagnostics.record('stitcher', 'hevc_normalization_failed', {
        ...props(),
        errorCode: code,
        reason,
        durationBucket: durationBucket(performance.now() - started)
      });
      throw Object.assign(new Error(code), { reason });
    }
  }
}
function knownReason(v: unknown): v is Reason {
  return (
    typeof v === 'string' &&
    [
      'metadata',
      'encode',
      'verify',
      'source_changed',
      'cancelled',
      'timeout',
      'disk_full',
      'cache'
    ].includes(v)
  );
}
function fail(code: string, reason: Reason): never {
  throw Object.assign(new Error(code), { reason });
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function number(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function rational(v: unknown): number | null {
  if (typeof v !== 'string') return number(v);
  const [a, b = 1] = v.split(/[/:]/u).map(Number);
  return a !== undefined && Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null;
}
const words = (v: unknown) => (typeof v === 'string' ? v : '');
export function parseCompatibilityMetadata(raw: unknown): Stream | null {
  if (!record(raw) || !Array.isArray(raw.streams)) return null;
  const streams = raw.streams.filter(record);
  const video = streams.find(
    s => s.codec_type === 'video' && (!record(s.disposition) || s.disposition.attached_pic !== 1)
  );
  if (!video) return null;
  const format = record(raw.format) ? raw.format : {};
  const width = number(video.width),
    height = number(video.height),
    index = number(video.index);
  const nominal = rational(video.r_frame_rate),
    average = rational(video.avg_frame_rate);
  const fps =
    nominal !== null && nominal >= 1 && nominal <= 240
      ? Math.max(nominal, average !== null && average <= 240 ? average : nominal)
      : average;
  const duration = number(format.duration) ?? number(video.duration);
  if (
    width === null ||
    height === null ||
    index === null ||
    fps === null ||
    duration === null ||
    width < 1 ||
    height < 1 ||
    fps < 1 ||
    fps > 240 ||
    duration <= 0
  )
    return null;
  const side = Array.isArray(video.side_data_list) ? video.side_data_list.filter(record) : [];
  const transfer = words(video.color_transfer),
    hdr = transfer === 'smpte2084' ? 'pq' : transfer === 'arib-std-b67' ? 'hlg' : null;
  // Non-backwards-compatible Dolby Vision requires a different decoder/rendering contract.
  if (side.some(s => number(s.dv_profile) === 5) || words(video.color_space) === 'ictcp')
    return null;
  const primaries: HdrPrimaries =
    video.color_primaries === 'bt709'
      ? 'bt709'
      : video.color_primaries === 'smpte432'
        ? 'smpte432'
        : video.color_primaries === 'bt2020' || hdr
          ? 'bt2020'
          : 'bt709';
  const matrix =
    video.color_space === 'bt709'
      ? 'bt709'
      : video.color_space === 'bt2020nc'
        ? 'bt2020'
        : video.color_space === 'smpte170m' || video.color_space === 'bt470bg'
          ? 'smpte170m'
          : hdr
            ? 'bt2020'
            : 'bt709';
  const tags = record(video.tags) ? video.tags : {};
  const rotation =
    number(side.find(s => s.rotation !== undefined)?.rotation) ?? number(tags.rotate) ?? 0;
  const peak =
    side
      .map(s => number(s.max_content_light_level) ?? rational(s.max_luminance))
      .find(v => v !== null && v >= 100 && v <= 10000) ?? 1000;
  const audio = streams.find(s => s.codec_type === 'audio');
  const sar = rational(video.sample_aspect_ratio);
  return {
    index,
    codec: words(video.codec_name),
    width,
    height,
    fps,
    duration,
    colorTransfer: transfer,
    primaries,
    matrix,
    range: video.color_range === 'pc' ? 'pc' : 'tv',
    rotation,
    sar: sar !== null && sar > 0 ? sar : 1,
    peak,
    audioIndex: audio ? number(audio.index) : null,
    audioChannels: audio ? (number(audio.channels) ?? 2) : 0,
    hdr,
    hdrSideData: side.some(s =>
      /mastering|content light|dovi|dolby/iu.test(words(s.side_data_type))
    ),
    audioDuration: audio ? number(audio.duration) : null,
    audioStart: audio ? (number(audio.start_time) ?? 0) : 0,
    videoDuration: number(video.duration),
    videoStart: number(video.start_time) ?? 0
  };
}
async function metadata(file: string, signal: AbortSignal): Promise<Stream> {
  const result = await runTool(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,avg_frame_rate,r_frame_rate,duration,start_time,sample_rate,channels,sample_aspect_ratio:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation,side_data_type,dv_profile,dv_bl_signal_compatibility_id,max_luminance,max_content_light_level:format=duration',
      '-of',
      'json',
      file
    ],
    { signal }
  );
  if (!toolSucceeded(result) || result.stdout.length > 64 * 1024)
    fail('STITCH_TOOL_FAILED', 'metadata');
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    fail('STITCH_TOOL_FAILED', 'metadata');
  }
  const parsed = parseCompatibilityMetadata(raw);
  if (!parsed) fail('STITCH_TOOL_FAILED', 'metadata');
  return parsed;
}
export function compatibilityArgs(source: Stream, threads: number | null): string[] {
  const fps = source.fps.toFixed(9),
    duration = source.duration.toFixed(6);
  const color = source.hdr
    ? hdrFilter(source.hdr, source.primaries, source.peak, source.range, source.matrix)
    : [
        `colorspace=all=bt709:ispace=${source.matrix === 'bt2020' ? 'bt2020nc' : source.matrix}:iprimaries=${source.matrix === 'smpte170m' ? 'smpte170m' : source.primaries}:itrc=${['bt709', 'bt2020-10', 'bt2020-12', 'smpte170m', 'iec61966-2-1', 'linear', 'gamma22', 'gamma28'].includes(source.colorTransfer) ? source.colorTransfer : 'bt709'}:irange=${source.range}:range=tv:format=yuv420p:dither=fsb`
      ];
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-xerror',
    ...(threads === null ? [] : ['-threads', String(threads), '-filter_threads', String(threads)]),
    '-i',
    'input.media',
    '-map',
    `0:${source.index}`,
    ...(source.audioIndex === null ? ['-an'] : ['-map', `0:${source.audioIndex}`]),
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-vf',
    [
      'scale=w=ceil(iw*sar/2)*2:h=ceil(ih/2)*2',
      'setsar=1',
      ...color,
      `fps=fps=${fps}:start_time=0:round=near`,
      `tpad=stop_mode=clone:stop_duration=${duration}`,
      'sidedata=mode=delete'
    ].join(','),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-bf',
    '0',
    ...(threads === null ? [] : ['-threads', String(threads)]),
    '-color_range',
    'tv',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-metadata:s:v:0',
    'rotate=0',
    '-fps_mode',
    'cfr',
    '-video_track_timescale',
    '90000',
    ...(source.audioIndex === null
      ? []
      : [
          '-af',
          'aresample=48000:async=1:first_pts=0,apad',
          '-c:a',
          'aac',
          '-profile:a',
          'aac_low',
          '-ar',
          '48000',
          '-ac',
          String(source.audioChannels === 1 ? 1 : 2),
          '-b:a',
          '192k'
        ]),
    '-t',
    duration,
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    'normalized.mp4'
  ];
}
async function convert(
  directory: string,
  input: string,
  signal: AbortSignal,
  threads: number | null,
  progress: (fraction: number) => void,
  verifying: () => void
): Promise<{ file: string; profile: SourceProfile }> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error('PROCESS_TIMEOUT')),
    scaled(6 * 60 * 60 * 1000)
  );
  timer.unref();
  const combined = AbortSignal.any([signal, timeout.signal]);
  try {
    const source = await metadata(input, combined);
    if (source.codec !== 'hevc') fail('SOURCE_CHANGED', 'source_changed');
    if (source.hdr) await writeHdrLuts(directory, source.hdr, source.primaries, combined);
    const encoded = await runTool(ffmpegPath, compatibilityArgs(source, threads), {
      cwd: directory,
      signal: combined,
      captureStdout: false,
      onLine: line => {
        const match = /^out_time_us=(\d+)$/u.exec(line);
        if (match) progress(Math.min(0.8, (Number(match[1]) / 1_000_000 / source.duration) * 0.8));
      }
    });
    if (timeout.signal.aborted) throw new Error('PROCESS_TIMEOUT');
    if (signal.aborted) throw new Error('PROCESS_CANCELED');
    if (!toolSucceeded(encoded))
      fail('STITCH_TOOL_FAILED', /no space left/iu.test(encoded.stderr) ? 'disk_full' : 'encode');
    verifying();
    progress(0.82);
    const file = path.join(directory, 'normalized.mp4');
    const measured = await metadata(file, combined);
    const probed = await probeSource(file, { signal: combined });
    const tolerance = Math.max(0.1, 2 / source.fps);
    const rotated = Math.abs(Math.round(source.rotation / 90)) % 2 === 1;
    const expectedRatio = rotated
      ? source.height / (source.width * source.sar)
      : (source.width * source.sar) / source.height;
    if (
      !probed.ok ||
      measured.codec !== 'h264' ||
      measured.hdr ||
      measured.hdrSideData ||
      Math.abs(measured.rotation) > 0.01 ||
      measured.colorTransfer !== 'bt709' ||
      measured.primaries !== 'bt709' ||
      measured.matrix !== 'bt709' ||
      measured.range !== 'tv' ||
      Math.abs(measured.duration - source.duration) > tolerance ||
      Math.abs((measured.videoDuration ?? measured.duration) - source.duration) > tolerance ||
      Math.abs(measured.videoStart) > tolerance ||
      (source.audioIndex !== null &&
        (measured.audioDuration === null ||
          Math.abs(measured.audioDuration - source.duration) > 0.1 ||
          Math.abs(measured.audioStart) > 0.1)) ||
      Math.abs(Math.log(measured.width / measured.height / expectedRatio)) >
        Math.max(0.01, 2 / Math.min(source.width, source.height)) ||
      Math.abs(measured.fps - source.fps) > 0.001 ||
      probed.value.variableFrameRate ||
      probed.value.pixelFormat !== 'yuv420p' ||
      probed.value.colorRange !== 'tv' ||
      probed.value.hasAudio !== (source.audioIndex !== null)
    )
      fail('STITCH_VERIFICATION_FAILED', 'verify');
    // Decode both tracks to EOF with strict error handling before any cache promotion.
    const decoded = await runTool(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-xerror',
        '-err_detect',
        'explode',
        ...(threads === null ? [] : ['-threads', String(threads)]),
        '-i',
        file,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-f',
        'null',
        '-'
      ],
      { signal: combined, captureStdout: false }
    );
    if (timeout.signal.aborted) throw new Error('PROCESS_TIMEOUT');
    if (signal.aborted) throw new Error('PROCESS_CANCELED');
    if (!toolSucceeded(decoded)) fail('STITCH_VERIFICATION_FAILED', 'verify');
    const facts = await stat(file);
    if (facts.size < 1) fail('STITCH_VERIFICATION_FAILED', 'verify');
    progress(0.98);
    return { file, profile: probed.value };
  } catch (error) {
    if (timeout.signal.aborted) throw new Error('PROCESS_TIMEOUT', { cause: error });
    if (signal.aborted) throw new Error('PROCESS_CANCELED', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
