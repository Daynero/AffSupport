export function releaseMetrics(events) {
  const timings = {};
  const effects = {};
  let handoffs = 0;
  let modelTokens = null;
  for (const event of events) {
    if (event.type === 'step_completed') timings[event.stepId] = (timings[event.stepId] ?? 0) + (event.durationMs ?? 0);
    if (event.type === 'effect_observed') effects[event.kind] = (effects[event.kind] ?? 0) + 1;
    if (event.type === 'handoff_accepted') handoffs += 1;
    if (event.type === 'model_usage' && Number.isFinite(event.tokens)) modelTokens = (modelTokens ?? 0) + event.tokens;
  }
  return { timings, effects, handoffs, modelTokens };
}
