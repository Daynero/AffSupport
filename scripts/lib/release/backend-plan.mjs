const DIGEST = /^[a-f0-9]{64}$/u;

export function resolveBackendPlan(plan, targetId) {
  if (!plan) return { changes: [] };
  if (!Array.isArray(plan.changes)) throw new Error('BACKEND_PLAN_INVALID');
  const changes = plan.changes.map(change => {
    if (!['migration', 'function'].includes(change.kind) || change.targetId !== targetId || !DIGEST.test(change.digest ?? '') || !change.compatibleWithPrevious || !['before-readiness', 'before-web'].includes(change.position)) throw new Error('BACKEND_PLAN_INVALID');
    return Object.freeze({ id: change.id, kind: change.kind, digest: change.digest, targetId: change.targetId, position: change.position, dependencies: [...(change.dependencies ?? [])], checks: [...(change.checks ?? [])], recovery: change.recovery });
  });
  return Object.freeze({ changes });
}
