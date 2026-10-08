export function releaseMetrics(events) {
  const timings = {};
  const effects = {};
  let handoffs = 0;
  let modelTokens = null;
  const usage = new Map();
  for (const event of events) {
    const data = event.payload ?? event;
    if (event.type === 'step_completed') timings[data.stepId] = (timings[data.stepId] ?? 0) + (data.durationMs ?? 0);
    if (event.type === 'effect_observed') effects[data.kind] = (effects[data.kind] ?? 0) + 1;
    if (event.type === 'handoff_accepted') handoffs += 1;
    if (event.type === 'model_usage' && Number.isFinite(data.tokens)) {
      if (data.executionId) usage.set(data.executionId, Math.max(usage.get(data.executionId) ?? 0, data.tokens));
      else modelTokens = (modelTokens ?? 0) + data.tokens;
    }
  }
  if (usage.size) modelTokens = (modelTokens ?? 0) + [...usage.values()].reduce((sum, n) => sum + n, 0);
  return { timings, effects, handoffs, modelTokens };
}
