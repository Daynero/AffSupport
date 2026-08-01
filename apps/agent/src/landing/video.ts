import {
  DEFAULT_CRF,
  LANDING_HIGH_QUALITY_CRF,
  type EncodingSettings,
  type LandingVideoQuality
} from '@video-compressor/shared';
import { encodeVideo, isAudioCopyFailure, type EncodeResult } from '../ffmpeg/encoder.js';
import { probeMedia } from '../ffmpeg/tools.js';

/**
 * Encoding settings for the two Landing Optimizer video modes.
 *
 * Optimal reuses the exact, proven Video Compressor optimal preset (H.264,
 * CRF 26, original resolution and frame rate). High Quality keeps the same
 * pipeline but compresses far more gently — a lower CRF, no resolution or
 * frame-rate changes — so quality stays visually intact.
 */
export function landingVideoEncoding(quality: LandingVideoQuality): EncodingSettings {
  if (quality === 'high') {
    return {
      mode: 'custom',
      stripMetadata: true,
      frameRate: null,
      resolutionLimit: null,
      rateControl: 'crf',
      crf: LANDING_HIGH_QUALITY_CRF,
      videoBitrateKbps: null
    };
  }
  return {
    mode: 'optimal',
    stripMetadata: true,
    frameRate: null,
    resolutionLimit: null,
    rateControl: 'crf',
    crf: DEFAULT_CRF,
    videoBitrateKbps: null
  };
}

/**
 * Re-encodes a video with the shared compression pipeline, mirroring the
 * queue's audio-copy fallback: if copying the source audio into MP4 fails, it
 * retries once transcoding audio to AAC.
 */
export async function optimizeVideo(
  inputPath: string,
  outputPath: string,
  quality: LandingVideoQuality,
  onProgress: (value: number | null) => void,
  signal?: AbortSignal
): Promise<EncodeResult> {
  const media = await probeMedia(inputPath);
  const settings = landingVideoEncoding(quality);
  let result = await runEncoding(
    inputPath,
    outputPath,
    media.duration,
    settings,
    false,
    onProgress,
    signal
  );
  if (result.code !== 0 && isAudioCopyFailure(result.stderr)) {
    onProgress(0);
    result = await runEncoding(
      inputPath,
      outputPath,
      media.duration,
      settings,
      true,
      onProgress,
      signal
    );
  }
  return result;
}

async function runEncoding(
  inputPath: string,
  outputPath: string,
  duration: number | null,
  settings: EncodingSettings,
  transcodeAudio: boolean,
  onProgress: (value: number | null) => void,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
  const operation = encodeVideo(
    inputPath,
    outputPath,
    duration,
    settings,
    transcodeAudio,
    onProgress
  );
  const abort = () => operation.child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await operation.done;
    if (signal?.aborted) throw signal.reason ?? new Error('PROCESS_CANCELED');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
