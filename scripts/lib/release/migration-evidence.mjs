export function preparedReceipt({ targetId, version, digest, sourceSha, transaction }) {
  return Object.freeze({ state: 'prepared', targetId, version, digest, sourceSha, transaction, preparedAt: new Date().toISOString() });
}

export function reconcileReceipt(receipt, observation) {
  if (!receipt) return { ok: false, code: 'MIGRATION_PROVENANCE_UNKNOWN' };
  if (observation?.historyPresent && observation.postconditionsPass && observation.targetId === receipt.targetId) return { ok: true, state: 'observed' };
  if (!observation?.historyPresent && receipt.transaction === 'transactional' && observation?.provenAbsent) return { ok: true, state: 'retryable' };
  return { ok: false, code: 'MIGRATION_EFFECT_AMBIGUOUS' };
}
