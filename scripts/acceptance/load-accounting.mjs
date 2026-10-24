/** Accounting includes every offered attempt; warmup is explicit and never silently dropped. */
export function summarizeAttempts(samples, timeoutMs = 15000) {
  if (
    !Array.isArray(samples) ||
    samples.length > 100000 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error('ACCEPTANCE_SAMPLES_INVALID');
  const allowed = new Set(['success', 'timeout', 'wrong_result', 'dropped', 'error']);
  for (const sample of samples) {
    if (
      !sample ||
      typeof sample !== 'object' ||
      !allowed.has(sample.outcome) ||
      typeof sample.warmup !== 'boolean' ||
      !Number.isFinite(sample.scheduledMs) ||
      !Number.isFinite(sample.completedMs) ||
      sample.completedMs < sample.scheduledMs
    )
      throw new Error('ACCEPTANCE_SAMPLES_INVALID');
  }
  const measured = samples
    .filter(sample => !sample.warmup)
    .map(sample =>
      sample.outcome === 'success' && sample.completedMs - sample.scheduledMs > timeoutMs
        ? { ...sample, outcome: 'timeout' }
        : sample
    );
  const success = measured.filter(sample => sample.outcome === 'success');
  const allLatency = measured
    .map(sample =>
      sample.outcome === 'success' ? sample.completedMs - sample.scheduledMs : timeoutMs
    )
    .sort((a, b) => a - b);
  const percentile = q =>
    allLatency.length ? allLatency[Math.ceil(q * allLatency.length) - 1] : null;
  return {
    offered: samples.length,
    warmup: samples.length - measured.length,
    measured: measured.length,
    success: success.length,
    failed: measured.length - success.length,
    dropped: measured.filter(sample => sample.outcome === 'dropped').length,
    censored: measured.filter(sample => sample.outcome !== 'success').length,
    successRate: measured.length ? success.length / measured.length : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    clock: 'collector-monotonic',
    latencyKind: 'scheduled-to-correct-result-or-timeout',
    uiProof: false
  };
}
