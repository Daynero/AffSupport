export async function rehearseBackendBeta({ binding, plan, adapter, lease }) {
  if (binding.kind !== 'sandbox') throw new Error('TARGET_MISMATCH');
  if (!lease?.leaseId) throw new Error('LEASE_REQUIRED');
  for (const change of plan.changes) {
    if (change.targetId !== binding.bindingId) throw new Error('TARGET_MISMATCH');
    const result = await adapter.verify(change);
    if (!result?.ok) return { ok: false, changeId: change.id, error: result?.error ?? 'BETA_BACKEND_FAILED' };
  }
  return { ok: true, changes: plan.changes.length };
}
