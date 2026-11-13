import { isRecord } from './contract.js';
import { LAUNCH_BATCH_MAX_ITEMS, isLaunchUuid, type LaunchGeneration } from './launches.js';
import { isLaunchVersion, parseLaunchGeneration } from './launches/persistence.js';
import { TEAM_ERROR_CODES, type TeamErrorCode } from './transport.js';

export interface LaunchBatchCommand {
  teamId: string;
  expectedActorId: string;
  requestKey: string;
  items: Array<{ launchId: string; expectedVersion: string; childRequestKey: string }>;
  expectedExecutorId?: string;
}
export interface DurableLaunchBatchItem {
  launchId: string;
  expectedVersion: string;
  childRequestKey: string;
  admission: 'accepted' | 'refused' | 'pending';
  errorCode: TeamErrorCode | null;
  generationId: string | null;
  generation: LaunchGeneration | null;
  admissionAttempts?: number;
  admissionNextAttemptAt?: string | null;
  cancelPending?: boolean;
  cancelErrorCode?: TeamErrorCode | null;
  offer: string;
  social: string;
  agentId: string;
  agentSuffix: string | null;
}
export interface DurableLaunchBatch {
  id: string;
  teamId: string;
  requestKey: string;
  createdAt: string;
  cancelRequestedAt: string | null;
  items: DurableLaunchBatchItem[];
}
export interface DurableLaunchBatchList {
  items: DurableLaunchBatch[];
  hasMore: boolean;
  nextCursor: { createdAt: string; id: string } | null;
}
export function parseLaunchBatchCommand(value: unknown): LaunchBatchCommand | null {
  if (
    !isRecord(value) ||
    !isLaunchUuid(value.teamId) ||
    !isLaunchUuid(value.expectedActorId) ||
    !isLaunchUuid(value.requestKey) ||
    (value.expectedExecutorId !== undefined && !isLaunchUuid(value.expectedExecutorId)) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > LAUNCH_BATCH_MAX_ITEMS
  )
    return null;
  const launches = new Set<string>(),
    keys = new Set<string>();
  const items: LaunchBatchCommand['items'] = [];
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      !isLaunchUuid(item.launchId) ||
      !isLaunchVersion(item.expectedVersion) ||
      !isLaunchUuid(item.childRequestKey) ||
      launches.has(item.launchId) ||
      keys.has(item.childRequestKey)
    )
      return null;
    launches.add(item.launchId);
    keys.add(item.childRequestKey);
    items.push({
      launchId: item.launchId,
      expectedVersion: item.expectedVersion,
      childRequestKey: item.childRequestKey
    });
  }
  return {
    teamId: value.teamId,
    expectedActorId: value.expectedActorId,
    requestKey: value.requestKey,
    items,
    ...(value.expectedExecutorId === undefined
      ? {}
      : { expectedExecutorId: value.expectedExecutorId })
  };
}
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function parseDurableLaunchBatch(value: unknown): DurableLaunchBatch | null {
  if (
    !isRecord(value) ||
    !isLaunchUuid(value.id) ||
    !isLaunchUuid(value.teamId) ||
    !isLaunchUuid(value.requestKey) ||
    !date(value.createdAt) ||
    (value.cancelRequestedAt !== null && !date(value.cancelRequestedAt)) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > LAUNCH_BATCH_MAX_ITEMS
  )
    return null;
  const items: DurableLaunchBatchItem[] = [],
    launches = new Set<string>(),
    keys = new Set<string>();
  for (const row of value.items) {
    if (
      !isRecord(row) ||
      !isLaunchUuid(row.launchId) ||
      !isLaunchVersion(row.expectedVersion) ||
      !isLaunchUuid(row.childRequestKey) ||
      launches.has(row.launchId) ||
      keys.has(row.childRequestKey) ||
      !['accepted', 'refused', 'pending'].includes(String(row.admission)) ||
      ![row.offer, row.social, row.agentId].every(v => typeof v === 'string' && v.length <= 2000) ||
      (row.agentSuffix !== null &&
        (typeof row.agentSuffix !== 'string' || row.agentSuffix.length > 3))
    )
      return null;
    if (
      row.admissionAttempts !== undefined &&
      (typeof row.admissionAttempts !== 'number' ||
        !Number.isSafeInteger(row.admissionAttempts) ||
        row.admissionAttempts < 0)
    )
      return null;
    if (
      row.admissionNextAttemptAt !== undefined &&
      row.admissionNextAttemptAt !== null &&
      !date(row.admissionNextAttemptAt)
    )
      return null;
    if (row.cancelPending !== undefined && typeof row.cancelPending !== 'boolean') return null;
    const cancelErrorCode =
      row.cancelErrorCode == null
        ? null
        : TEAM_ERROR_CODES.find(code => code === row.cancelErrorCode);
    if (cancelErrorCode === undefined) return null;
    const errorCode =
      row.errorCode === null ? null : TEAM_ERROR_CODES.find(code => code === row.errorCode);
    const generation = row.generation === null ? null : parseLaunchGeneration(row.generation);
    if (
      errorCode === undefined ||
      (row.generation !== null && !generation) ||
      (row.admission === 'accepted'
        ? !isLaunchUuid(row.generationId) || errorCode !== null || !generation
        : row.generationId !== null || generation !== null || errorCode === null) ||
      (generation &&
        (generation.id !== row.generationId ||
          generation.requestKey !== row.childRequestKey ||
          generation.inputVersion !== row.expectedVersion))
    )
      return null;
    launches.add(row.launchId);
    keys.add(row.childRequestKey);
    items.push({
      launchId: row.launchId,
      expectedVersion: row.expectedVersion,
      childRequestKey: row.childRequestKey,
      admission: row.admission as DurableLaunchBatchItem['admission'],
      errorCode,
      generationId: row.generationId as string | null,
      generation,
      ...(row.admissionAttempts === undefined ? {} : { admissionAttempts: row.admissionAttempts }),
      ...(row.admissionNextAttemptAt === undefined
        ? {}
        : { admissionNextAttemptAt: row.admissionNextAttemptAt }),
      ...(row.cancelPending === undefined ? {} : { cancelPending: row.cancelPending }),
      ...(row.cancelErrorCode === undefined ? {} : { cancelErrorCode }),
      offer: row.offer as string,
      social: row.social as string,
      agentId: row.agentId as string,
      agentSuffix: row.agentSuffix as string | null
    });
  }
  return {
    id: value.id,
    teamId: value.teamId,
    requestKey: value.requestKey,
    createdAt: value.createdAt,
    cancelRequestedAt: value.cancelRequestedAt,
    items
  };
}
export function parseDurableLaunchBatchList(value: unknown): DurableLaunchBatchList | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    typeof value.hasMore !== 'boolean'
  )
    return null;
  const items = value.items.map(parseDurableLaunchBatch);
  if (
    items.some(item => item === null) ||
    new Set(items.map(item => item?.id)).size !== items.length
  )
    return null;
  const cursor = value.nextCursor;
  if (cursor !== null && (!isRecord(cursor) || !date(cursor.createdAt) || !isLaunchUuid(cursor.id)))
    return null;
  if (value.hasMore !== (cursor !== null)) return null;
  const last = items.at(-1);
  if (
    cursor !== null &&
    (!last || !isRecord(cursor) || cursor.id !== last.id || cursor.createdAt !== last.createdAt)
  )
    return null;
  return {
    items: items as DurableLaunchBatch[],
    hasMore: value.hasMore,
    nextCursor: cursor as DurableLaunchBatchList['nextCursor']
  };
}
