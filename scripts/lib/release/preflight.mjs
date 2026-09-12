import { resolveTargetBinding } from './targets.mjs';
import { resolveBackendPlan } from './backend-plan.mjs';

export async function preflight(intent, { bindings, probe, bridge, backendPlan = null }) {
  const binding = resolveTargetBinding(intent, bindings);
  const resolvedBackendPlan = resolveBackendPlan(backendPlan, intent.targetId);
  const [probeResult, bridgeResult] = await Promise.all([probe.inspect(), bridge.inspect()]);
  const failures = [];
  if (!probeResult?.ok) failures.push({ code: 'PROBE_UNAVAILABLE', subject: 'Installed resource probe is unavailable.' });
  if (!bridgeResult?.ok) failures.push({ code: 'AGENT_BRIDGE_UNAVAILABLE', subject: 'Configured agent bridge is unavailable.' });
  return Object.freeze({ ok: failures.length === 0, binding, backendPlan: resolvedBackendPlan, failures });
}
