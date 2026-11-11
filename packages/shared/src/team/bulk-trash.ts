import { parseTeamFileOperationResult, type TeamHistoricalFileReceipt } from './transport.js';
/** Hosted receipts; names and provider payloads never enter this projection. */
export type BulkTrashState = 'queued' | 'running' | 'confirmed' | 'failed' | 'unknown';
export interface BulkTrashItem {
  materialId: string;
  idempotencyKey: string;
  state: BulkTrashState;
  errorCode: string | null;
  historicalReceipt?: TeamHistoricalFileReceipt;
}
export interface BulkTrashGroup {
  id: string;
  teamId: string;
  actorId: string;
  items: BulkTrashItem[];
  /** The viewer closed it, or it is finished work nobody needs to see again. */
  dismissed?: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function isBulkTrashGroup(value: unknown): value is BulkTrashGroup {
  if (!value || typeof value !== 'object') return false;
  if (!(
    'id' in value &&
    typeof value.id === 'string' &&
    uuid.test(value.id) &&
    'teamId' in value &&
    typeof value.teamId === 'string' &&
    uuid.test(value.teamId) &&
    'actorId' in value &&
    typeof value.actorId === 'string' &&
    uuid.test(value.actorId) &&
    'items' in value &&
    Array.isArray(value.items) &&
    value.items.length <= 500 &&
    (!('dismissed' in value) ||
      value.dismissed === undefined ||
      typeof value.dismissed === 'boolean')
  ))
    return false;
  return value.items.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    if (
      'historicalReceipt' in item &&
      item.historicalReceipt !== undefined &&
      (!('state' in item) ||
        item.state !== 'confirmed' ||
        !parseTeamFileOperationResult({
          operationId: 'historical',
          materialId: 'material',
          state: 'succeeded',
          reused: true,
          historicalReceipt: item.historicalReceipt
        }))
    )
      return false;
    return (
      'materialId' in item &&
      typeof item.materialId === 'string' &&
      uuid.test(item.materialId) &&
      'idempotencyKey' in item &&
      typeof item.idempotencyKey === 'string' &&
      item.idempotencyKey.length <= 200 &&
      'state' in item &&
      typeof item.state === 'string' &&
      ['queued', 'running', 'confirmed', 'failed', 'unknown'].includes(item.state) &&
      'errorCode' in item &&
      (item.errorCode === null ||
        (typeof item.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(item.errorCode)))
    );
  });
}
