import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../runtime/bin'
);
export const ffmpegPath =
  process.env.FFMPEG_PATH ??
  (process.env.PACKAGED_APP === '1' ? path.join(bundledRoot, 'ffmpeg') : 'ffmpeg');
export const ffprobePath =
  process.env.FFPROBE_PATH ??
  (process.env.PACKAGED_APP === '1' ? path.join(bundledRoot, 'ffprobe') : 'ffprobe');

export async function commandExists(command: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, ['-version'], { shell: false, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
}

export interface MediaInfo {
  duration: number | null;
  videoDuration: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitrate: number | null;
  codec: string | null;
  formatName: string | null;
  hasAudio: boolean;
  audioDuration: number | null;
  audioBitrate: number | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  audioLayout: string | null;
}

const emptyMedia: MediaInfo = {
  duration: null,
  videoDuration: null,
  width: null,
  height: null,
  frameRate: null,
  bitrate: null,
  codec: null,
  formatName: null,
  hasAudio: false,
  audioDuration: null,
  audioBitrate: null,
  audioSampleRate: null,
  audioChannels: null,
  audioLayout: null
};

export async function probeMedia(inputPath: string): Promise<MediaInfo> {
  const data = await probeJson([
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,bit_rate,codec_name,duration,sample_rate,channels,channel_layout:stream_tags=rotate:stream_side_data=rotation:format=duration,bit_rate,format_name',
    '-of',
    'json',
    inputPath
  ]);
  if (!data) return { ...emptyMedia };

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(stream => stream?.codec_type === 'video') ?? {};
  const audio = streams.find(stream => stream?.codec_type === 'audio') ?? null;
  const duration = positiveNumber(data.format?.duration);
  const videoDuration = positiveNumber(video.duration) ?? duration;
  const streamBitrate = positiveNumber(video.bit_rate);
  const formatBitrate = positiveNumber(data.format?.bit_rate);
  const codedWidth = positiveNumber(video.width);
  const codedHeight = positiveNumber(video.height);
  const rotation = normalizedRotation(
    video.side_data_list?.find((entry: Record<string, unknown>) => entry.rotation !== undefined)
      ?.rotation ?? video.tags?.rotate
  );
  const rotated = rotation === 90 || rotation === 270;

  return {
    duration,
    videoDuration,
    width: rotated ? codedHeight : codedWidth,
    height: rotated ? codedWidth : codedHeight,
    frameRate: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate),
    bitrate: streamBitrate ?? formatBitrate,
    codec: nonEmptyString(video.codec_name),
    formatName: nonEmptyString(data.format?.format_name),
    hasAudio: Boolean(audio),
    audioDuration: audio ? (positiveNumber(audio.duration) ?? duration) : null,
    audioBitrate: audio ? positiveNumber(audio.bit_rate) : null,
    audioSampleRate: audio ? positiveNumber(audio.sample_rate) : null,
    audioChannels: audio ? positiveNumber(audio.channels) : null,
    audioLayout: audio ? nonEmptyString(audio.channel_layout) : null
  };
}

export interface ImageInfo {
  width: number;
  height: number;
  codec: string;
}

export async function probeImage(inputPath: string): Promise<ImageInfo | null> {
  const data = await probeJson([
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name',
    '-of',
    'json',
    inputPath
  ]);
  const stream = Array.isArray(data?.streams) ? data.streams[0] : null;
  const width = positiveNumber(stream?.width);
  const height = positiveNumber(stream?.height);
  const codec = nonEmptyString(stream?.codec_name);
  return width && height && codec ? { width, height, codec } : null;
}

export async function probeDuration(inputPath: string): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputPath
      ],
      { shell: false }
    );
    let output = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      const value = Number.parseFloat(output.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

function probeJson(args: string[]): Promise<Record<string, any> | null> {
  return new Promise(resolve => {
    const child = spawn(ffprobePath, args, { shell: false });
    let output = '';
    let settled = false;
    const finish = (value: Record<string, any> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on('data', data => {
      output += data;
    });
    child.on('error', () => finish(null));
    child.on('close', code => {
      if (code !== 0) return finish(null);
      try {
        finish(JSON.parse(output));
      } catch {
        finish(null);
      }
    });
  });
}

function parseFrameRate(value: unknown): number | null {
  const [numerator, denominator] = String(value ?? '')
    .split('/')
    .map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function normalizedRotation(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? ((Math.round(number) % 360) + 360) % 360 : 0;
}
