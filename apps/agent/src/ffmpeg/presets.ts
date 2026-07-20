import type { EncodingSettings, ImageFitMode, JobImageEmbedding } from '@video-compressor/shared';

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
export function videoArgs(settings: EncodingSettings): string[] {
  const args = videoCodecArgs(settings);
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
  input: string;
  output: string;
  sourceDurationSeconds: number;
  sourceHasAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  settings: EncodingSettings;
  imageEmbedding: JobImageEmbedding;
  startImagePath: string | null;
  endImagePath: string | null;
}

export function buildEmbeddedFfmpegArgs(options: EmbeddedFfmpegOptions): string[] {
  const fps = decimal(options.frameRate);
  const sourceDuration = decimal(options.sourceDurationSeconds);
  const frameDuration = decimal(1 / options.frameRate, 9);
  const inputs = ['-i', options.input];
  const filters: string[] = [];
  const segments: { video: string; audio: string }[] = [];
  let inputIndex = 1;

  filters.push(
    `[0:v]scale=${options.width}:${options.height}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${sourceDuration},trim=duration=${sourceDuration}[mainv]`
  );
  if (options.sourceHasAudio) {
    filters.push(
      `[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=whole_dur=${sourceDuration},atrim=duration=${sourceDuration}[maina]`
    );
  } else {
    filters.push(silenceFilter(sourceDuration, 'maina'));
  }

  if (options.imageEmbedding.startImage && options.startImagePath) {
    inputs.push('-loop', '1', '-framerate', fps, '-i', options.startImagePath);
    filters.push(
      `[${inputIndex}:v]${imageAdaptationFilter(options.width, options.height, options.imageEmbedding.fitMode)},fps=${fps},trim=duration=${frameDuration},setpts=PTS-STARTPTS[startv]`
    );
    filters.push(silenceFilter(frameDuration, 'starta'));
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
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...videoCodecArgs(options.settings),
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-fps_mode',
    'cfr',
    ...metadataArgs(options.settings),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    options.output
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
