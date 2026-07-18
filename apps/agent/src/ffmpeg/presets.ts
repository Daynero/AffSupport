import type { EncodingSettings } from '@video-compressor/shared';

const evenLimit = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
const fitLongestSide = (limit: number) => {
  const value = evenLimit(limit);
  return `scale='if(gte(iw,ih),min(${value},iw),-2)':'if(gte(iw,ih),-2,min(${value},ih))'`;
};

/** Build the shared H.264 arguments used by both estimation and the final encode. */
export function videoArgs(settings: EncodingSettings): string[] {
  const args = ['-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p'];

  if (settings.rateControl === 'bitrate' && settings.videoBitrateKbps) {
    const bitrate = settings.videoBitrateKbps;
    args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
  } else {
    args.push('-crf', String(settings.crf));
  }

  const filters: string[] = [];
  if (settings.resolutionLimit) filters.push(fitLongestSide(settings.resolutionLimit));
  if (settings.frameRate) filters.push(`fps=${settings.frameRate}`);
  if (filters.length) args.push('-vf', filters.join(','));

  return args;
}

export function buildFfmpegArgs(
  input: string,
  output: string,
  settings: EncodingSettings,
  forceAac = false
): string[] {
  const audio = forceAac ? ['-c:a', 'aac', '-b:a', '96k'] : ['-c:a', 'copy'];
  return [
    '-hide_banner',
    '-nostdin',
    '-n',
    '-i',
    input,
    ...videoArgs(settings),
    ...audio,
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output
  ];
}

export function buildEstimateArgs(
  input: string,
  output: string,
  start: number,
  duration: number,
  settings: EncodingSettings
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
    ...videoArgs(settings),
    '-an',
    '-f',
    'h264',
    output
  ];
}
