export interface SamplePoint { start: number; duration: number }
export function createSamplePlan(total: number): SamplePoint[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  if (total <= 12) return [{ start: 0, duration: total }];
  const clip = Math.min(5, Math.max(3, total / 12));
  const count = total < 15 ? 3 : total < 120 ? 6 : 8;
  const maxStart = Math.max(0, total - clip);
  const fractions = count === 3 ? [0, .5, 1] : count === 6 ? [0, .2, .4, .6, .8, 1] : [0, .1, .2, .4, .6, .8, .9, 1];
  return fractions.map(fraction => ({ start: maxStart * fraction, duration: Math.min(clip, total - maxStart * fraction) }));
}
export function estimateFromSamples(sizes: number[], durations: number[], totalDuration: number, audioBitsPerSecond: number, originalSize: number) {
  if (sizes.length < Math.min(3, durations.length) || !sizes.length) return null;
  const rates = sizes.map((size, index) => size / Math.max(.01, durations[index])); const mean = rates.reduce((a, b) => a + b, 0) / rates.length; const variance = rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / rates.length; const cv = Math.sqrt(variance) / Math.max(1, mean);
  const midpoint = Math.max(1, Math.round((mean * totalDuration + audioBitsPerSecond / 8 * totalDuration) * 1.005 + 2048)); const uncertainty = Math.min(.5, Math.max(.18, .18 + cv * .4));
  return { estimatedOutputBytes: midpoint, estimatedSavingPercent: Math.round((1 - midpoint / originalSize) * 100), estimateRangeMinBytes: Math.round(midpoint * (1 - uncertainty)), estimateRangeMaxBytes: Math.round(midpoint * (1 + uncertainty)) };
}
