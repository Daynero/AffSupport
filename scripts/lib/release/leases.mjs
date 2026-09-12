export function createLeaseBook() {
  let active = null;
  const children = new Set();
  return {
    /** @param {{runId: string, parentLeaseId?: string | null, childId?: string | null}} request */
    request({ runId, parentLeaseId = null, childId = null }) {
      if (parentLeaseId) {
        if (!active || active.id !== parentLeaseId || children.size > 0) return { ok: false, reason: 'LEASE_WAIT' };
        children.add(childId);
        return { ok: true, leaseId: active.id, inherited: true };
      }
      if (active) return { ok: false, reason: 'LEASE_WAIT' };
      active = { id: `${runId}:1`, runId };
      return { ok: true, leaseId: active.id, inherited: false };
    },
    /** @param {{leaseId: string, childId?: string | null}} release */
    release({ leaseId, childId = null }) {
      if (!active || active.id !== leaseId) return false;
      if (childId) return children.delete(childId);
      if (children.size) return false;
      active = null; return true;
    }
  };
}
