import type { ChildProcess } from 'node:child_process';
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
export function landingVideoEncoding(
  quality: LandingVideoQuality,
  stripMetadata = true
): EncodingSettings {
  if (quality === 'high') {
    return {
      mode: 'custom',
      stripMetadata,
      frameRate: null,
      resolutionLimit: null,
      rateControl: 'crf',
      crf: LANDING_HIGH_QUALITY_CRF,
      videoBitrateKbps: null
    };
  }
  return {
    mode: 'optimal',
    stripMetadata,
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
  signal?: AbortSignal,
  stripMetadata = true,
  /** Handed the encoder as it starts, so the caller can hold or release it. */
  onChild?: (child: ChildProcess) => void
): Promise<EncodeResult> {
  const media = await probeMedia(inputPath);
  const settings = landingVideoEncoding(quality, stripMetadata);
  let result = await runEncoding(
    inputPath,
    outputPath,
    media.duration,
    settings,
    false,
    onProgress,
    signal,
    onChild
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
      signal,
      onChild
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
  signal?: AbortSignal,
  onChild?: (child: ChildProcess) => void
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
  // Both attempts report themselves: the audio-copy fallback spawns a second encoder, and a
  // run held by the person must stay held across that swap.
  onChild?.(operation.child);
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
