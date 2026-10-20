export interface TaskCleanupReceipt {
  id: string;
  materialId: string;
  undoUntil: string;
  state: 'waiting' | 'claimed' | 'retained' | 'trashed' | 'cancelled';
  reason:
    'cleanup_unverified' | 'cleanup_referenced' | 'cleanup_forbidden' | 'cleanup_pending' | null;
}
export function isTaskCleanupReceipt(value: unknown): value is TaskCleanupReceipt {
  if (!value || typeof value !== 'object') return false;
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.id) &&
    'materialId' in value &&
    typeof value.materialId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.materialId) &&
    'undoUntil' in value &&
    typeof value.undoUntil === 'string' &&
    Number.isFinite(Date.parse(value.undoUntil)) &&
    'state' in value &&
    typeof value.state === 'string' &&
    ['waiting', 'claimed', 'retained', 'trashed', 'cancelled'].includes(value.state) &&
    'reason' in value &&
    (value.reason === null ||
      (typeof value.reason === 'string' &&
        [
          'cleanup_unverified',
          'cleanup_referenced',
          'cleanup_forbidden',
          'cleanup_pending'
        ].includes(value.reason)))
  );
}
export function canOfferTaskDetachUndo(receipt: TaskCleanupReceipt, now = Date.now()): boolean {
  return (
    (receipt.state === 'waiting' || receipt.state === 'retained') &&
    Date.parse(receipt.undoUntil) - now >= 20_000
  );
}
