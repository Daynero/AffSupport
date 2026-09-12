/**
 * Rehearses the declared changes somewhere that is not production.
 *
 * `binding` is where the rehearsal happens and must never be a production
 * destination. `releaseTargetId` is what the plan is *for*, and defaults to the
 * rehearsal's own id so a sandbox release — which rehearses against itself —
 * reads exactly as it did before.
 *
 * They have to be separable. A production release rehearses a plan whose changes
 * name `production` against a beta stack that is emphatically not production,
 * and with one parameter the only way to express that was to lie about one of
 * them: retarget the changes and lose the check that they are aimed where the
 * release is aimed, or point the rehearsal at production and rehearse nothing.
 *
 * @param {{binding: any, plan: any, adapter: any, lease: any, releaseTargetId?: string}} options
 */
export async function rehearseBackendBeta({ binding, plan, adapter, lease, releaseTargetId }) {
  if (binding.kind !== 'sandbox') throw new Error('TARGET_MISMATCH');
  if (!lease?.leaseId) throw new Error('LEASE_REQUIRED');
  const target = releaseTargetId ?? binding.bindingId;
  for (const change of plan.changes) {
    if (change.targetId !== target) throw new Error('TARGET_MISMATCH');
    const result = await adapter.verify(change);
    if (!result?.ok) return { ok: false, changeId: change.id, error: result?.error ?? 'BETA_BACKEND_FAILED' };
  }
  return { ok: true, changes: plan.changes.length };
}
