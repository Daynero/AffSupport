import { parseTeamFileOperationResult, type TeamHistoricalFileReceipt } from './transport.js';
/** Hosted receipts; provider payloads never enter this projection. The viewer's
 * list (only) adds each material's catalog name, so a panel can say what it moved. */
export type BulkTrashState = 'queued' | 'running' | 'confirmed' | 'failed' | 'unknown';
export interface BulkTrashItem {
  materialId: string;
  idempotencyKey: string;
  state: BulkTrashState;
  errorCode: string | null;
  historicalReceipt?: TeamHistoricalFileReceipt;
  /** The material's name as the viewer's catalog knows it; list only. */
  name?: string;
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
    if (
      'name' in item &&
      item.name !== undefined &&
      (typeof item.name !== 'string' || item.name.length > 1024)
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

/**
 * A validated copy of one hosted group, with every receipt instant rewritten to
 * UTC `Z` (the server may render `+00:00`). Null when the group is malformed.
 */
export function parseBulkTrashGroup(value: unknown): BulkTrashGroup | null {
  if (!isBulkTrashGroup(value)) return null;
  return {
    ...value,
    items: value.items.map(item => {
      if (!item.historicalReceipt) return { ...item };
      const parsed = parseTeamFileOperationResult({
        operationId: 'historical',
        materialId: 'material',
        state: 'succeeded',
        reused: true,
        historicalReceipt: item.historicalReceipt
      });
      return { ...item, historicalReceipt: parsed!.historicalReceipt! };
    })
  };
}

/**
 * The hosted list, one group at a time: a malformed group is dropped and
 * reported, never allowed to make the rest unreadable. Null only when the
 * list itself is not a list.
 */
export function parseBulkTrashGroups(
  value: unknown
): { groups: BulkTrashGroup[]; rejected: string[] } | null {
  if (!Array.isArray(value)) return null;
  const groups: BulkTrashGroup[] = [];
  const rejected: string[] = [];
  for (const candidate of value) {
    const group = parseBulkTrashGroup(candidate);
    if (group) groups.push(group);
    else
      rejected.push(
        candidate &&
          typeof candidate === 'object' &&
          'id' in candidate &&
          typeof candidate.id === 'string' &&
          uuid.test(candidate.id)
          ? candidate.id
          : 'unidentified'
      );
  }
  return { groups, rejected };
}
