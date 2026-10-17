import { isRecord } from './contract.js';
import { MATERIAL_CATEGORIES, type MaterialCategory } from './material-category.js';

export interface TeamBulkTrashItem {
  materialId: string;
  category?: MaterialCategory | null;
  idempotencyKey: string;
  operationId: string | null;
  state: 'queued' | 'active' | 'confirmed' | 'failed' | 'unknown';
  errorCode: string | null;
}

export interface TeamBulkTrashGroup {
  id: string;
  requestId: string;
  createdAt: string;
  items: TeamBulkTrashItem[];
}

export interface TeamBulkTrashIntent {
  id: string;
  requestId: string;
  items: Array<Pick<TeamBulkTrashItem, 'materialId' | 'idempotencyKey'>>;
}

export type TeamBulkTrashRetry =
  | { status: 'retryable'; idempotencyKey: string }
  | { status: 'confirmed' | 'active' | 'unknown' | 'exhausted' };

export function parseTeamBulkTrashRetry(value: unknown): TeamBulkTrashRetry | null {
  if (!isRecord(value)) return null;
  if (value.status === 'retryable' && id(value.idempotencyKey))
    return { status: 'retryable', idempotencyKey: value.idempotencyKey };
  if (['confirmed', 'active', 'unknown', 'exhausted'].includes(String(value.status)))
    return { status: value.status as 'confirmed' | 'active' | 'unknown' | 'exhausted' };
  return null;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export function parseTeamBulkTrashIntent(value: unknown): TeamBulkTrashIntent | null {
  if (!isRecord(value) || !id(value.id) || !id(value.requestId) || !Array.isArray(value.items))
    return null;
  const items: TeamBulkTrashIntent['items'] = [];
  for (const item of value.items) {
    if (!isRecord(item) || !id(item.materialId) || !id(item.idempotencyKey)) return null;
    items.push({ materialId: item.materialId, idempotencyKey: item.idempotencyKey });
  }
  return items.length > 0 && items.length <= 100
    ? { id: value.id, requestId: value.requestId, items }
    : null;
}

export function parseTeamBulkTrashGroups(value: unknown): TeamBulkTrashGroup[] | null {
  if (!Array.isArray(value) || value.length > 25) return null;
  const groups: TeamBulkTrashGroup[] = [];
  for (const group of value) {
    if (
      !isRecord(group) ||
      !id(group.id) ||
      !id(group.requestId) ||
      typeof group.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(group.createdAt)) ||
      !Array.isArray(group.items) ||
      group.items.length > 100
    )
      return null;
    const items: TeamBulkTrashItem[] = [];
    for (const item of group.items) {
      if (
        !isRecord(item) ||
        !id(item.materialId) ||
        !id(item.idempotencyKey) ||
        (item.category !== undefined &&
          item.category !== null &&
          !MATERIAL_CATEGORIES.includes(item.category as MaterialCategory)) ||
        (item.operationId !== null && !id(item.operationId)) ||
        !['queued', 'active', 'confirmed', 'failed', 'unknown'].includes(String(item.state)) ||
        (item.errorCode !== null &&
          (typeof item.errorCode !== 'string' || item.errorCode.length > 80))
      )
        return null;
      items.push({
        materialId: item.materialId,
        category: (item.category as MaterialCategory | null | undefined) ?? null,
        idempotencyKey: item.idempotencyKey,
        operationId: item.operationId,
        state: item.state as TeamBulkTrashItem['state'],
        errorCode: item.errorCode
      });
    }
    groups.push({ id: group.id, requestId: group.requestId, createdAt: group.createdAt, items });
  }
  return groups;
}
