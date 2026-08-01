import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{7,199}$/iu;
const MAX_NAME_LENGTH = 255;
export const MAX_TEXT_EDIT_BYTES = 1024 * 1024;
export const UPLOAD_CHUNK_MULTIPLE_BYTES = 256 * 1024;
export const BROWSER_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

export type ConflictMode = 'cancel' | 'keep_both' | 'replace';

export interface UploadStartRequest {
  teamId: string;
  destinationFolderId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  conflictMode: ConflictMode;
  replaceMaterialId: string | null;
  versionOfMaterialId: string | null;
  idempotencyKey: string;
}

export interface UploadConflictPlan {
  name: string;
  reservationKey: string;
  replaceMaterialId: string | null;
}

export interface DriveOperationMaterial {
  id: string;
  teamId: string;
  driveFileId: string;
  parentFolderId: string | null;
  name: string;
  kind: 'file' | 'folder' | 'shortcut';
  lifecycle: 'active' | 'trashed' | 'missing';
  mimeType: string | null;
  fileExtension: string | null;
  sizeBytes: number | null;
  driveVersion: string | null;
  checksum: string | null;
  transcriptIngestState:
    'not_applicable' | 'pending' | 'full' | 'truncated' | 'invalid_encoding' | 'unavailable';
  transcriptTruncated: boolean;
}

export interface LiveDriveCapabilities {
  canDownload: boolean;
  canAddChildren: boolean;
  canRename: boolean;
  canMoveItemWithinDrive: boolean;
  canMoveItemOutOfDrive: boolean;
  canModifyContent: boolean;
  canTrash: boolean;
  canUntrash: boolean;
}

export interface LiveDriveTarget {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  shortcutTargetId: string | null;
  sizeBytes: number | null;
  driveVersion: string | null;
  checksum: string | null;
  capabilities: LiveDriveCapabilities;
}

export type DriveMutationAction = 'rename' | 'move' | 'text_edit' | 'trash' | 'restore';

function inputError(code: 'INVALID_INPUT' | 'TOO_LARGE' = 'INVALID_INPUT'): never {
  throw new TeamFunctionError(code, { retryable: false });
}

function requiredUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) inputError();
  return value;
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredUuid(value);
}

export function displayDriveName(value: unknown): string {
  if (typeof value !== 'string') inputError();
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (
    normalized.length < 1 ||
    normalized.length > MAX_NAME_LENGTH ||
    normalized === '.' ||
    normalized === '..' ||
    /[\u0000-\u001f\u007f/\\]/u.test(normalized) ||
    normalized.startsWith('../') ||
    normalized.endsWith('/..')
  ) {
    inputError();
  }
  return normalized;
}

/** Stable reservation identity; provider-visible casing stays in `displayDriveName`. */
export function normalizeReservedName(value: unknown): string {
  return displayDriveName(value).toLocaleLowerCase('en-US');
}

export function validateUploadStartRequest(value: unknown): UploadStartRequest {
  if (!isRecord(value)) inputError();
  const conflictMode = value.conflictMode;
  if (!['cancel', 'keep_both', 'replace'].includes(String(conflictMode))) inputError();
  const sizeBytes = value.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) inputError();
  const mimeType = value.mimeType;
  if (
    typeof mimeType !== 'string' ||
    mimeType.length < 1 ||
    mimeType.length > 255 ||
    !/^[\w.+-]+\/[\w.+-]+$/u.test(mimeType)
  ) {
    inputError();
  }
  const idempotencyKey = value.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) inputError();
  const replaceMaterialId = optionalUuid(value.replaceMaterialId);
  const versionOfMaterialId = optionalUuid(value.versionOfMaterialId);
  if (conflictMode === 'replace' ? !replaceMaterialId : replaceMaterialId !== null) inputError();
  if (versionOfMaterialId && (conflictMode === 'replace' || replaceMaterialId)) inputError();
  return {
    teamId: requiredUuid(value.teamId),
    destinationFolderId: requiredUuid(value.destinationFolderId),
    name: displayDriveName(value.name),
    mimeType,
    sizeBytes: sizeBytes as number,
    conflictMode: conflictMode as ConflictMode,
    replaceMaterialId,
    versionOfMaterialId,
    idempotencyKey
  };
}

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

export function buildUploadConflictPlan(
  request: UploadStartRequest,
  existing: ReadonlyArray<{ materialId: string; name: string }>
): UploadConflictPlan {
  const byKey = new Map(existing.map(item => [normalizeReservedName(item.name), item]));
  const requestedKey = normalizeReservedName(request.name);
  const collision = byKey.get(requestedKey);
  if (!collision) {
    return { name: request.name, reservationKey: requestedKey, replaceMaterialId: null };
  }
  if (request.conflictMode === 'cancel') {
    throw new TeamFunctionError('NAME_CONFLICT', { retryable: false });
  }
  if (request.conflictMode === 'replace') {
    if (collision.materialId !== request.replaceMaterialId) {
      throw new TeamFunctionError('NOT_FOUND', { retryable: false });
    }
    return {
      name: request.name,
      reservationKey: requestedKey,
      replaceMaterialId: collision.materialId
    };
  }
  const { stem, extension } = splitExtension(request.name);
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const name = displayDriveName(`${stem} (${suffix})${extension}`);
    const reservationKey = normalizeReservedName(name);
    if (!byKey.has(reservationKey)) return { name, reservationKey, replaceMaterialId: null };
  }
  throw new TeamFunctionError('NAME_CONFLICT', { retryable: false });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function assertTextEditEligibility(material: DriveOperationMaterial, text: string): number {
  if (
    material.kind !== 'file' ||
    material.lifecycle !== 'active' ||
    material.fileExtension?.toLocaleLowerCase('en-US') !== 'txt' ||
    material.transcriptIngestState !== 'full' ||
    material.transcriptTruncated
  ) {
    throw new TeamFunctionError('UNSUPPORTED_MEDIA', { retryable: false });
  }
  if (material.sizeBytes === null || material.sizeBytes > MAX_TEXT_EDIT_BYTES) {
    throw new TeamFunctionError('TOO_LARGE', { retryable: false });
  }
  if (typeof text !== 'string' || hasUnpairedSurrogate(text) || text.includes('\u0000'))
    inputError();
  const encodedBytes = new TextEncoder().encode(text).byteLength;
  if (encodedBytes > MAX_TEXT_EDIT_BYTES) inputError('TOO_LARGE');
  return encodedBytes;
}

export function assertExpectedSourceIdentity(
  actual: LiveDriveTarget,
  expected: { driveFileId: string; driveVersion: string; checksum?: string | null }
): void {
  if (
    actual.id !== expected.driveFileId ||
    actual.driveVersion !== expected.driveVersion ||
    (expected.checksum !== undefined && actual.checksum !== expected.checksum)
  ) {
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  }
}

const REQUIRED_CAPABILITY: Record<DriveMutationAction, keyof LiveDriveCapabilities> = {
  rename: 'canRename',
  move: 'canMoveItemWithinDrive',
  text_edit: 'canModifyContent',
  trash: 'canTrash',
  restore: 'canUntrash'
};

export function validateLiveMutationTarget(input: {
  action: DriveMutationAction;
  target: LiveDriveTarget;
  rootFolderId: string;
  ancestryProven: boolean;
}): LiveDriveTarget {
  const { action, target } = input;
  if (!input.ancestryProven) throw new TeamFunctionError('ROOT_ESCAPE', { retryable: false });
  if (target.shortcutTargetId) {
    throw new TeamFunctionError('UNSUPPORTED_MEDIA', { retryable: false });
  }
  if (target.id === input.rootFolderId) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  if (action === 'restore' ? !target.trashed : target.trashed) {
    throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  }
  if (!target.capabilities[REQUIRED_CAPABILITY[action]]) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  return target;
}

export function postconditionForMutation(
  action: DriveMutationAction,
  result: LiveDriveTarget,
  expected: { name?: string; parentId?: string; previousVersion?: string }
): boolean {
  const valid =
    action === 'rename'
      ? result.name === expected.name
      : action === 'move'
        ? typeof expected.parentId === 'string' && result.parents.includes(expected.parentId)
        : action === 'trash'
          ? result.trashed
          : action === 'restore'
            ? !result.trashed
            : typeof expected.previousVersion === 'string' &&
              result.driveVersion !== null &&
              result.driveVersion !== expected.previousVersion;
  if (!valid) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  return true;
}

export async function runVerifiedDriveSaga<T>(input: {
  external: () => Promise<T>;
  commit: (result: T) => Promise<void>;
  reconcile: (result: T) => Promise<void>;
}): Promise<T> {
  const result = await input.external();
  try {
    await input.commit(result);
  } catch {
    await input.reconcile(result).catch(() => undefined);
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  return result;
}
