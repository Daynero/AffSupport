import type { EstimateBreakdown } from '@video-compressor/shared';

export interface SamplePoint {
  start: number;
  duration: number;
}

export function createSamplePlan(total: number): SamplePoint[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  if (total <= 12) return [{ start: 0, duration: total }];
  const clip = Math.min(5, Math.max(3, total / 12));
  const count = total < 15 ? 3 : total < 120 ? 6 : 8;
  const maxStart = Math.max(0, total - clip);
  const fractions =
    count === 3
      ? [0, 0.5, 1]
      : count === 6
        ? [0, 0.2, 0.4, 0.6, 0.8, 1]
        : [0, 0.1, 0.2, 0.4, 0.6, 0.8, 0.9, 1];
  return fractions.map(fraction => ({
    start: maxStart * fraction,
    duration: Math.min(clip, total - maxStart * fraction)
  }));
}

export function estimateBreakdownFromSamples(
  sizes: number[],
  durations: number[],
  audioBytesPerSecond: number,
  staticVideoBytesPerSecond = 0
): EstimateBreakdown | null {
  if (sizes.length < Math.min(3, durations.length) || !sizes.length) return null;
  const rates = sizes.map((size, index) => size / Math.max(0.01, durations[index]));
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const variance = rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / rates.length;
  const coefficientOfVariation = Math.sqrt(variance) / Math.max(1, mean);
  return {
    dynamicVideoBytesPerSecond: mean,
    staticVideoBytesPerSecond,
    audioBytesPerSecond,
    uncertainty: Math.min(0.5, Math.max(0.18, 0.18 + coefficientOfVariation * 0.4))
  };
}

export function estimateFromSamples(
  sizes: number[],
  durations: number[],
  totalDuration: number,
  audioBitsPerSecond: number,
  originalSize: number
) {
  const breakdown = estimateBreakdownFromSamples(sizes, durations, audioBitsPerSecond / 8);
  if (!breakdown) return null;
  const midpoint = Math.max(
    1,
    Math.round(
      (breakdown.dynamicVideoBytesPerSecond + breakdown.audioBytesPerSecond) *
        totalDuration *
        1.005 +
        2048
    )
  );
  return {
    estimatedOutputBytes: midpoint,
    estimatedSavingPercent: Math.round((1 - midpoint / originalSize) * 100),
    estimateRangeMinBytes: Math.round(midpoint * (1 - breakdown.uncertainty)),
    estimateRangeMaxBytes: Math.round(midpoint * (1 + breakdown.uncertainty))
  };
}
