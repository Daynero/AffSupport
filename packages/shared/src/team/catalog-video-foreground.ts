import { isRecord } from './contract.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export interface CatalogVideoForegroundExecutor {
  protocolVersion: 1;
  enrollmentId: string;
  nativeInstanceId: string;
  proofDigest: string;
}
export interface CatalogVideoForegroundBinding {
  protocolVersion: 1;
  teamId: string;
  sourceMaterialId: string;
  requestKey: string;
  expectedVersion?: number;
}
export interface CatalogVideoForegroundProgressExecutor {
  mode: 'paired_session';
  enrollmentId: string;
  nativeInstanceId: string;
}
export function parseCatalogVideoForegroundExecutor(
  raw: unknown
): CatalogVideoForegroundExecutor | null {
  if (
    !isRecord(raw) ||
    raw.protocolVersion !== 1 ||
    typeof raw.enrollmentId !== 'string' ||
    !UUID.test(raw.enrollmentId) ||
    typeof raw.nativeInstanceId !== 'string' ||
    !UUID.test(raw.nativeInstanceId) ||
    typeof raw.proofDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.proofDigest)
  )
    return null;
  return {
    protocolVersion: 1,
    enrollmentId: raw.enrollmentId,
    nativeInstanceId: raw.nativeInstanceId,
    proofDigest: raw.proofDigest
  };
}
export function parseCatalogVideoForegroundBinding(
  raw: unknown
): CatalogVideoForegroundBinding | null {
  if (
    !isRecord(raw) ||
    raw.protocolVersion !== 1 ||
    typeof raw.teamId !== 'string' ||
    !UUID.test(raw.teamId) ||
    typeof raw.sourceMaterialId !== 'string' ||
    !UUID.test(raw.sourceMaterialId) ||
    typeof raw.requestKey !== 'string' ||
    !/^[A-Za-z0-9:_-]{1,160}$/u.test(raw.requestKey) ||
    (raw.expectedVersion !== undefined &&
      (typeof raw.expectedVersion !== 'number' ||
        !Number.isSafeInteger(raw.expectedVersion) ||
        raw.expectedVersion < 1))
  )
    return null;
  return {
    protocolVersion: 1,
    teamId: raw.teamId,
    sourceMaterialId: raw.sourceMaterialId,
    requestKey: raw.requestKey,
    ...(raw.expectedVersion === undefined ? {} : { expectedVersion: raw.expectedVersion })
  };
}
