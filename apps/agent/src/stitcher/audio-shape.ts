/**
 * The check that would have caught a silent file before anyone downloaded one.
 *
 * A re-stitched video came back with the picture cut correctly and no sound at all — in
 * QuickTime, in Safari, in Telegram, in Finder's own preview. Every measurement we had said
 * the file was fine, because every measurement we had went through FFmpeg, and FFmpeg reads
 * an AAC stream frame by frame: it re-syncs on each one and never consults the track's
 * declared configuration. CoreAudio — which is what those players are — reads the
 * configuration once, from the sample description, and decodes the whole track against it.
 *
 * The concat demuxer writes exactly one sample description per track, taken from the first
 * input. So joining a screen whose silence is AAC-LC onto a body that is HE-AAC produces a
 * track declared LC and filled, after the first seconds, with frames that are not. CoreAudio
 * meets them, gives up, and reports the track as a few seconds long. Reproduced exactly:
 * HE-AAC body → `ExtAudioFileRead failed ('bada')` and 13 s of a 18 s file; the same body
 * re-encoded to AAC-LC → the full 18 s decoded.
 *
 * The body is now re-encoded so this cannot arise, which makes this function a guard rather
 * than a fix. It is still worth having: a cached body from an older build, a codec path we
 * add later, or a source shape nobody anticipated would all reproduce the same silent file,
 * and a run that fails loudly is repairable in a way a delivered file is not.
 */

import { ffprobePath } from '../ffmpeg/tools.js';
import { runTool, toolSucceeded } from './run.js';

/** What one sample description has to agree about for a copied join to stay decodable. */
export interface AudioShape {
  codec: string;
  /** `LC`, `HE-AAC`, … — the audio object type, which is the field that actually broke. */
  profile: string | null;
  sampleRate: number | null;
  channels: number | null;
}

export function buildAudioShapeProbeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,profile,sample_rate,channels',
    '-of',
    'json',
    input
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Null means the segment has no audio at all, which is a different question from a mismatch. */
export function audioShapeFromProbe(raw: unknown): AudioShape | null {
  if (!isRecord(raw)) return null;
  const streams = Array.isArray(raw.streams) ? raw.streams.filter(isRecord) : [];
  const stream = streams[0];
  if (!stream || typeof stream.codec_name !== 'string') return null;
  const rate = Number(stream.sample_rate);
  const channels = Number(stream.channels);
  return {
    codec: stream.codec_name,
    profile: typeof stream.profile === 'string' ? stream.profile : null,
    sampleRate: Number.isFinite(rate) ? rate : null,
    channels: Number.isFinite(channels) ? channels : null
  };
}

/**
 * The parts that disagree with the first one, named.
 *
 * Empty means the join is safe. A segment with no audio beside segments that have some is
 * reported too: the joined track would simply stop there.
 */
export function audioShapeDisagreements(shapes: (AudioShape | null)[]): string[] {
  if (shapes.length < 2) return [];
  const [first, ...rest] = shapes;
  const mismatches: string[] = [];
  rest.forEach((shape, index) => {
    // Position in the list the caller passed, counting from the first segment.
    const at = index + 2;
    if (first === null || shape === null) {
      if (first !== shape) mismatches.push(`segment-${at}-audio-presence`);
      return;
    }
    if (shape.codec !== first.codec) mismatches.push(`segment-${at}-codec`);
    if (shape.profile !== first.profile) mismatches.push(`segment-${at}-profile`);
    if (shape.sampleRate !== first.sampleRate) mismatches.push(`segment-${at}-sample-rate`);
    if (shape.channels !== first.channels) mismatches.push(`segment-${at}-channels`);
  });
  return mismatches;
}

export async function measureAudioShape(
  input: string,
  options: { signal?: AbortSignal } = {}
): Promise<AudioShape | null> {
  const probe = await runTool(ffprobePath, buildAudioShapeProbeArgs(input), options);
  if (!toolSucceeded(probe)) return null;
  try {
    return audioShapeFromProbe(JSON.parse(probe.stdout));
  } catch {
    return null;
  }
}
