import {
  DEFAULT_CRF,
  DEFAULT_VIDEO_BITRATE_KBPS,
  type AgentSettings,
  type CompressionJob,
  type EncodingSettings,
  type JobStatus
} from '../packages/shared/src/types.js';

export const optimalEncoding: EncodingSettings = {
  mode: 'optimal',
  frameRate: null,
  resolutionLimit: null,
  rateControl: 'crf',
  crf: DEFAULT_CRF,
  videoBitrateKbps: null
};

export const customEncoding: EncodingSettings = {
  mode: 'custom',
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
  frameRate: null,
  resolutionLimit: null,
  rateControl: 'crf',
  crf: DEFAULT_CRF,
  videoBitrateKbps: DEFAULT_VIDEO_BITRATE_KBPS
};

export function makeJob(
  id = crypto.randomUUID(),
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
    finalSize: null,
    finalWidth: null,
    finalHeight: null,
    finalFrameRate: null,
    finalBitrate: null,
    finalDurationSeconds: null,
    finalCodec: null,
    progress: status === 'completed' ? 100 : 0,
    status,
    error: null,
    errorDetails: null,
    encoding: { ...optimalEncoding },
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
    ...patch
  };
}
