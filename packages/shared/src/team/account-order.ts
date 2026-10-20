import { isRecord } from './contract.js';
export type TeamAccountOrderScope = 'socials' | 'agents';
export interface TeamAccountOrderResult {
  operationId: string;
  requestId: string;
  version: string;
  order: string[];
}
export function parseTeamAccountOrderResult(value: unknown): TeamAccountOrderResult | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    typeof value.requestId !== 'string' ||
    typeof value.version !== 'string' ||
    !/^\d{1,19}$/.test(value.version) ||
    !Array.isArray(value.order) ||
    !value.order.every(id => typeof id === 'string') ||
    new Set(value.order).size !== value.order.length
  )
    return null;
  return {
    operationId: value.operationId,
    requestId: value.requestId,
    version: value.version,
    order: value.order as string[]
  };
}
/** Insert relative to an anchor in the FULL scope: hidden members keep their relative order. */
export function reorderTeamAccountIds(
  ids: readonly string[],
  moved: string,
  anchor: string,
  relation: 'before' | 'after'
): string[] | null {
  if (
    moved === anchor ||
    !ids.includes(moved) ||
    !ids.includes(anchor) ||
    new Set(ids).size !== ids.length
  )
    return null;
  const next = ids.filter(id => id !== moved);
  next.splice(next.indexOf(anchor) + Number(relation === 'after'), 0, moved);
  return next;
}
