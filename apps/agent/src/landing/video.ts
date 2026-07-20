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
      frameRate: null,
      resolutionLimit: null,
      rateControl: 'crf',
      crf: LANDING_HIGH_QUALITY_CRF,
      videoBitrateKbps: null
    };
  }
  return {
    mode: 'optimal',
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
  onProgress: (value: number | null) => void
): Promise<EncodeResult> {
  const media = await probeMedia(inputPath);
  const settings = landingVideoEncoding(quality);
  let result = await encodeVideo(inputPath, outputPath, media.duration, settings, false, onProgress)
    .done;
  if (result.code !== 0 && isAudioCopyFailure(result.stderr)) {
    onProgress(0);
    result = await encodeVideo(inputPath, outputPath, media.duration, settings, true, onProgress)
      .done;
  }
  return result;
}
