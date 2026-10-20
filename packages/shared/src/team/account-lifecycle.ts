import { isRecord } from './contract.js';
export type TeamAccountEntityKind = 'social' | 'agent';
export type TeamAccountFinanceIntent = 'normal' | 'historical_correction';
export const TEAM_ACCOUNT_NAME_COLORS = [
  'none',
  'green',
  'yellow',
  'red',
  'blue',
  'purple',
  'pink',
  'orange'
] as const;
export type TeamAccountNameColor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export function nextTeamAccountNameColor(color: TeamAccountNameColor): TeamAccountNameColor {
  return ((color + 1) % 8) as TeamAccountNameColor;
}
export interface TeamAccountArchivePreflight {
  entityId: string;
  entityKind: TeamAccountEntityKind;
  lifecycleVersion: string;
  token: string;
  archivedAt: string | null;
  effectiveArchived: boolean;
  childCount: number;
}
export function parseTeamAccountArchivePreflight(
  value: unknown
): TeamAccountArchivePreflight | null {
  if (
    !isRecord(value) ||
    typeof value.entityId !== 'string' ||
    !['social', 'agent'].includes(String(value.entityKind)) ||
    typeof value.lifecycleVersion !== 'string' ||
    !/^\d{1,19}$/.test(value.lifecycleVersion) ||
    typeof value.token !== 'string' ||
    !(
      value.archivedAt === null ||
      (typeof value.archivedAt === 'string' && Number.isFinite(Date.parse(value.archivedAt)))
    ) ||
    typeof value.effectiveArchived !== 'boolean' ||
    typeof value.childCount !== 'number' ||
    !Number.isInteger(value.childCount) ||
    value.childCount < 0
  )
    return null;
  return value as unknown as TeamAccountArchivePreflight;
}
export interface TeamAccountLifecycleResult extends TeamAccountArchivePreflight {
  operationId: string;
  requestId: string;
}
export function parseTeamAccountLifecycleResult(value: unknown): TeamAccountLifecycleResult | null {
  const parsed = parseTeamAccountArchivePreflight(value);
  return parsed &&
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.requestId === 'string'
    ? { ...parsed, operationId: value.operationId, requestId: value.requestId }
    : null;
}
export interface TeamAccountNameColorResult {
  operationId: string;
  requestId: string;
  agentId: string;
  color: TeamAccountNameColor;
  version: string;
}
export function parseTeamAccountNameColorResult(value: unknown): TeamAccountNameColorResult | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    typeof value.requestId !== 'string' ||
    typeof value.agentId !== 'string' ||
    typeof value.color !== 'number' ||
    !Number.isInteger(value.color) ||
    value.color < 0 ||
    value.color > 7 ||
    typeof value.version !== 'string' ||
    !/^\d{1,19}$/.test(value.version)
  )
    return null;
  return value as unknown as TeamAccountNameColorResult;
}
