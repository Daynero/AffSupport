import {
  draftImageEmbedding,
  estimatedFinalImageDurationSeconds,
  expectedDimensions,
  expectedFrameRate,
  jobConfigurationKey,
  randomFinalImageDurationSeconds,
  type CompressionJob,
  type ImageEmbeddingSettings,
  type JobImageEmbedding
} from '@video-compressor/shared';

export function freezeImageEmbedding(
  settings: ImageEmbeddingSettings,
  random = Math.random
): JobImageEmbedding | null {
  const draft = draftImageEmbedding(settings);
  if (!draft) return null;
  if (!draft.endImage) return draft;
  return {
    ...draft,
    finalDurationSeconds:
      draft.finalDurationMode === 'custom'
        ? settings.customFinalDurationSeconds
        : randomFinalImageDurationSeconds(draft.finalDurationMode, random)
  };
}

export function outputFrameRate(job: CompressionJob) {
  return expectedFrameRate(job.sourceFrameRate, job.encoding.frameRate) ?? 30;
}

export function outputDimensions(job: CompressionJob) {
  return expectedDimensions(job.sourceWidth, job.sourceHeight, job.encoding.resolutionLimit);
}

export function outputDurationSeconds(job: CompressionJob) {
  const source = job.durationSeconds ?? 0;
  if (!job.imageEmbedding) return source;
  const start = job.imageEmbedding.startImage ? 1 / outputFrameRate(job) : 0;
  const end = estimatedFinalImageDurationSeconds(job.imageEmbedding);
  return source + start + end;
}

export function refreshEstimateFromBreakdown(job: CompressionJob) {
  const breakdown = job.estimateBreakdown;
  const sourceDuration = job.durationSeconds;
  if (!breakdown || !sourceDuration) return false;
  const staticDuration = job.imageEmbedding
    ? (job.imageEmbedding.startImage ? 1 / outputFrameRate(job) : 0) +
      estimatedFinalImageDurationSeconds(job.imageEmbedding)
    : 0;
  const audioDuration = job.imageEmbedding ? sourceDuration + staticDuration : sourceDuration;
  const midpoint = Math.max(
    1,
    Math.round(
      (breakdown.dynamicVideoBytesPerSecond * sourceDuration +
        breakdown.staticVideoBytesPerSecond * staticDuration +
        breakdown.audioBytesPerSecond * audioDuration) *
        1.005 +
        2048
    )
  );
  job.estimatedOutputBytes = midpoint;
  job.estimatedSavingPercent = job.originalSize
    ? Math.round((1 - midpoint / job.originalSize) * 100)
    : null;
  job.estimateRangeMinBytes = Math.round(midpoint * (1 - breakdown.uncertainty));
  job.estimateRangeMaxBytes = Math.round(midpoint * (1 + breakdown.uncertainty));
  job.estimateKey = jobConfigurationKey(job.encoding, job.imageEmbedding);
  job.estimateStatus = 'estimated';
  job.estimateProgress = null;
  job.estimateError = null;
  return true;
}
