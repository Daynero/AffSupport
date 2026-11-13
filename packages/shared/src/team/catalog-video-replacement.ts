import { isRecord } from './contract.js';
import { isLaunchUuid } from './launches.js';
import { TEAM_ERROR_CODES, type TeamErrorCode } from './transport.js';

export const CATALOG_VIDEO_REPLACEMENT_STATES = [
  'publishing',
  'moving',
  'confirmed',
  'blocked'
] as const;
export type CatalogVideoReplacementState = (typeof CATALOG_VIDEO_REPLACEMENT_STATES)[number];
export interface CatalogVideoReplacementReceipt {
  teamId: string;
  catalogId: string;
  requestId: string;
  newVideoId: string;
  state: CatalogVideoReplacementState;
  errorCode: TeamErrorCode | null;
}
export interface CatalogVideoReplacementContext {
  teamId: string;
  catalogId: string;
  catalogName: string;
  currentVideoId: string;
  currentVideoName: string;
  version: string;
  blockedReason: 'updating' | 'publication' | 'restitch' | 'legacy' | 'pending' | null;
  active: CatalogVideoReplacementReceipt | null;
}
export interface CatalogVideoReplacementRequest {
  teamId: string;
  catalogId: string;
  expectedActorId: string;
  requestId: string;
  newVideoId: string;
  expectedVersion: string;
  moveToVideoFolder: boolean;
}
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 2000 && !/[\p{Cc}\p{Cs}]/u.test(v);
export function parseCatalogVideoReplacementReceipt(
  v: unknown
): CatalogVideoReplacementReceipt | null {
  if (
    !isRecord(v) ||
    !isLaunchUuid(v.teamId) ||
    !isLaunchUuid(v.catalogId) ||
    !isLaunchUuid(v.requestId) ||
    !isLaunchUuid(v.newVideoId)
  )
    return null;
  const state = CATALOG_VIDEO_REPLACEMENT_STATES.find(state => state === v.state);
  const errorCode =
    v.errorCode === null ? null : TEAM_ERROR_CODES.find(code => code === v.errorCode);
  if (!state || errorCode === undefined) return null;
  return {
    teamId: v.teamId,
    catalogId: v.catalogId,
    requestId: v.requestId,
    newVideoId: v.newVideoId,
    state,
    errorCode
  };
}
export function parseCatalogVideoReplacementContext(
  v: unknown
): CatalogVideoReplacementContext | null {
  if (
    !isRecord(v) ||
    !isLaunchUuid(v.teamId) ||
    !isLaunchUuid(v.catalogId) ||
    !isLaunchUuid(v.currentVideoId) ||
    !text(v.catalogName) ||
    !text(v.currentVideoName) ||
    !text(v.version)
  )
    return null;
  const blockedReason =
    v.blockedReason === null
      ? null
      : (['updating', 'publication', 'restitch', 'legacy', 'pending'] as const).find(
          reason => reason === v.blockedReason
        );
  if (blockedReason === undefined) return null;
  const active = v.active === null ? null : parseCatalogVideoReplacementReceipt(v.active);
  if (
    v.active !== null &&
    (!active || active.teamId !== v.teamId || active.catalogId !== v.catalogId)
  )
    return null;
  return {
    teamId: v.teamId,
    catalogId: v.catalogId,
    catalogName: v.catalogName,
    currentVideoId: v.currentVideoId,
    currentVideoName: v.currentVideoName,
    version: v.version,
    blockedReason,
    active
  };
}
export function parseCatalogVideoReplacementRequest(
  v: unknown
): CatalogVideoReplacementRequest | null {
  if (
    !isRecord(v) ||
    !isLaunchUuid(v.teamId) ||
    !isLaunchUuid(v.catalogId) ||
    !isLaunchUuid(v.expectedActorId) ||
    !isLaunchUuid(v.requestId) ||
    !isLaunchUuid(v.newVideoId) ||
    !text(v.expectedVersion) ||
    typeof v.moveToVideoFolder !== 'boolean'
  )
    return null;
  return {
    teamId: v.teamId,
    catalogId: v.catalogId,
    expectedActorId: v.expectedActorId,
    requestId: v.requestId,
    newVideoId: v.newVideoId,
    expectedVersion: v.expectedVersion,
    moveToVideoFolder: v.moveToVideoFolder
  };
}
