import { isRecord } from './contract.js';
import { isLaunchUuid } from './launches.js';
import { TEAM_ERROR_CODES, type TeamErrorCode } from './transport.js';

export interface CatalogRenameContext {
  teamId: string;
  materialId: string;
  currentName: string;
  materialVersion: string;
  impactVersion: string;
  /** Only names whose immutable saved links are proven to depend on them. */
  boundNames: string[];
  requiresAcknowledgement: boolean;
}
export interface CatalogRenameRequest {
  teamId: string;
  materialId: string;
  expectedActorId: string;
  requestKey: string;
  newName: string;
  expectedMaterialVersion: string;
  impactVersion: string;
  acknowledgeBoundNames: boolean;
}
export interface CatalogRenameReceipt {
  teamId: string;
  materialId: string;
  requestKey: string;
  operationId: string | null;
  state: 'pending' | 'confirmed' | 'failed';
  currentName: string | null;
  errorCode: TeamErrorCode | null;
}
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 1024 &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
const version = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 2000 &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
export function parseCatalogRenameContext(value: unknown): CatalogRenameContext | null {
  if (
    !isRecord(value) ||
    !isLaunchUuid(value.teamId) ||
    !isLaunchUuid(value.materialId) ||
    !name(value.currentName) ||
    !version(value.materialVersion) ||
    !version(value.impactVersion) ||
    !Array.isArray(value.boundNames) ||
    !value.boundNames.every(name) ||
    new Set(value.boundNames).size !== value.boundNames.length ||
    typeof value.requiresAcknowledgement !== 'boolean' ||
    value.requiresAcknowledgement !== value.boundNames.length > 0
  )
    return null;
  return {
    teamId: value.teamId,
    materialId: value.materialId,
    currentName: value.currentName,
    materialVersion: value.materialVersion,
    impactVersion: value.impactVersion,
    boundNames: [...value.boundNames],
    requiresAcknowledgement: value.requiresAcknowledgement
  };
}
export function parseCatalogRenameRequest(value: unknown): CatalogRenameRequest | null {
  if (
    !isRecord(value) ||
    !isLaunchUuid(value.teamId) ||
    !isLaunchUuid(value.materialId) ||
    !isLaunchUuid(value.expectedActorId) ||
    !isLaunchUuid(value.requestKey) ||
    !name(value.newName) ||
    !version(value.expectedMaterialVersion) ||
    !version(value.impactVersion) ||
    typeof value.acknowledgeBoundNames !== 'boolean'
  )
    return null;
  return {
    teamId: value.teamId,
    materialId: value.materialId,
    expectedActorId: value.expectedActorId,
    requestKey: value.requestKey,
    newName: value.newName,
    expectedMaterialVersion: value.expectedMaterialVersion,
    impactVersion: value.impactVersion,
    acknowledgeBoundNames: value.acknowledgeBoundNames
  };
}
export function parseCatalogRenameReceipt(value: unknown): CatalogRenameReceipt | null {
  if (
    !isRecord(value) ||
    !isLaunchUuid(value.teamId) ||
    !isLaunchUuid(value.materialId) ||
    !isLaunchUuid(value.requestKey) ||
    (value.operationId !== null && !isLaunchUuid(value.operationId)) ||
    !['pending', 'confirmed', 'failed'].includes(String(value.state)) ||
    (value.currentName !== null && !name(value.currentName)) ||
    (value.errorCode !== null &&
      !(TEAM_ERROR_CODES as readonly unknown[]).includes(value.errorCode)) ||
    (value.state === 'confirmed' &&
      (!value.operationId || !value.currentName || value.errorCode !== null)) ||
    (value.state === 'failed' && value.errorCode === null)
  )
    return null;
  return {
    teamId: value.teamId,
    materialId: value.materialId,
    requestKey: value.requestKey,
    operationId: value.operationId as string | null,
    state: value.state as CatalogRenameReceipt['state'],
    currentName: value.currentName as string | null,
    errorCode: value.errorCode as TeamErrorCode | null
  };
}
