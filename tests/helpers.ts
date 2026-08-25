import {
  DEFAULT_CRF,
  DEFAULT_VIDEO_BITRATE_KBPS,
  OPTIMAL_FRAME_RATE,
  OPTIMAL_RESOLUTION_LIMIT,
  defaultImageEmbeddingSettings,
  type AgentSettings,
  type CompressionJob,
  type EncodingSettings,
  type JobImageEmbedding,
  type JobStatus
} from '../packages/shared/src/types.js';

export const optimalEncoding: EncodingSettings = {
  mode: 'optimal',
  stripMetadata: true,
  frameRate: OPTIMAL_FRAME_RATE,
  resolutionLimit: OPTIMAL_RESOLUTION_LIMIT,
  rateControl: 'crf',
  crf: DEFAULT_CRF,
  videoBitrateKbps: null
};

export const customEncoding: EncodingSettings = {
  mode: 'custom',
  stripMetadata: true,
  frameRate: 30,
  resolutionLimit: 1080,
  rateControl: 'crf',
  crf: DEFAULT_CRF,
  videoBitrateKbps: null
};

export const optimalSettings: AgentSettings = {
  mode: 'optimal',
  outputMode: 'next-to-originals',
  outputFolder: null,
  stripMetadata: true,
  frameRate: null,
  resolutionLimit: null,
  rateControl: 'crf',
  crf: DEFAULT_CRF,
  videoBitrateKbps: DEFAULT_VIDEO_BITRATE_KBPS,
  imageEmbedding: defaultImageEmbeddingSettings()
};

export function makeJob(
  // Annotated `string` on purpose. Without it TypeScript infers the branded template
  // literal type of `crypto.randomUUID()`, and every call site passing a readable id
  // ("job", "done", "secret-file") fails to compile. The identifier is opaque to this
  // factory; a real UUID is only the convenient default.
  id: string = crypto.randomUUID(),
  status: JobStatus = 'ready',
  patch: Partial<CompressionJob> = {}
): CompressionJob {
  return {
    id,
    inputPath: `/tmp/${id}.mov`,
    outputPath: `/tmp/${id}_compressed.mp4`,
    fileName: `${id}.mov`,
    sourceKind: 'local',
    sourceKey: null,
    durationSeconds: 10,
    originalSize: 10_000,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceFrameRate: 29.97,
    sourceBitrate: 4_000_000,
    sourceCodec: 'h264',
    sourceHasAudio: true,
    sourceAudioBitrate: 128_000,
    sourceAudioSampleRate: 48_000,
    sourceAudioChannels: 2,
    sourceAudioLayout: 'stereo',
    finalSize: null,
    finalWidth: null,
    finalHeight: null,
    finalFrameRate: null,
    finalBitrate: null,
    finalDurationSeconds: null,
    finalCodec: null,
    progress: status === 'completed' ? 100 : 0,
    processingStage: null,
    status,
    error: null,
    errorDetails: null,
    encoding: { ...optimalEncoding },
    imageEmbedding: null,
    batchId: null,
    startedAt: null,
    finishedAt: null,
    estimateStatus: 'waiting',
    estimatedOutputBytes: null,
    estimatedSavingPercent: null,
    estimateRangeMinBytes: null,
    estimateRangeMaxBytes: null,
    estimateProgress: null,
    estimateError: null,
    estimateKey: null,
    estimatePriorityOrder: null,
    estimateBreakdown: null,
    ...patch
  };
}

/**
 * A complete `JobImageEmbedding`, with the fields a test does not care about
 * already filled in.
 *
 * Nine tests built this shape inline and each named the five or six fields it
 * was actually about, which type-checked only because those files were excluded
 * from the check. Every one of them would have gone stale the next time the
 * shape grew — a factory means that growth is one edit here rather than nine
 * failures spread across the suite.
 */
export function makeEmbedding(patch: Partial<JobImageEmbedding> = {}): JobImageEmbedding {
  return {
    startImage: null,
    endImage: null,
    startDurationMode: 'one-frame',
    customStartDurationMs: 100,
    finalDurationMode: 'random-40-50',
    finalDurationSeconds: null,
    fitMode: 'cover',
    replaceExisting: false,
    sourceTrimStartSeconds: 0,
    sourceTrimEndSeconds: 0,
    ...patch
  };
}
