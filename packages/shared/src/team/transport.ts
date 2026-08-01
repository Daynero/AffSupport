import {
  TEAM_OPERATION_KINDS,
  TEAM_OPERATION_STATES,
  isRecord,
  type TeamOperationKind,
  type TeamOperationState,
  type TranscriptIngestState
} from './contract.js';
import type { MaterialCategory } from './material-category.js';

export const TEAM_ERROR_CODES = [
  'AUTH_REQUIRED',
  'PERMISSION_DENIED',
  'NOT_A_MEMBER',
  'NOT_FOUND',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'WRONG_STATE',
  'NAME_CONFLICT',
  'ALREADY_MEMBER',
  'ALREADY_INVITED',
  'EXPIRED',
  'TEAM_MEMBER_LIMIT',
  'OWNERSHIP_TRANSFER_REQUIRED',
  'SOURCE_CHANGED',
  'TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'CORRUPT_OR_PROTECTED',
  'RATE_LIMITED',
  'DRIVE_UNAVAILABLE',
  'NEEDS_REAUTH',
  'DELIVERY_UNAVAILABLE',
  'OAUTH_APPROVAL_REQUIRED',
  'ROOT_ESCAPE',
  'AGENT_REQUIRED',
  'AGENT_UPDATE_REQUIRED'
] as const;
export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

export interface TeamStructuredError {
  code: TeamErrorCode;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export type TeamEdgeResult<T> = { ok: true; value: T } | { ok: false; error: TeamStructuredError };
export type TeamRpcResult<T> = TeamEdgeResult<T>;

export interface TeamOperationSnapshot {
  id: string;
  teamId: string;
  kind: TeamOperationKind;
  state: TeamOperationState;
  stage: string | null;
  progress: number;
  sourceMaterialId: string | null;
  resultMaterialId: string | null;
  errorCode: TeamErrorCode | null;
  retryable: boolean;
  createdAt: string;
  updatedAt: string;
}

export const TEAM_TRANSFER_PURPOSES = [
  'preview_range',
  'download_range',
  'process_input',
  'process_output',
  'finalize'
] as const;
export type TeamTransferPurpose = (typeof TEAM_TRANSFER_PURPOSES)[number];

export interface TeamTransferGrant {
  ticket: string;
  purpose: TeamTransferPurpose;
  expiresAt: string;
  maxRangeBytes: number;
  maxUses: number;
}

export interface TeamTranscriptSnapshot {
  text: string | null;
  ingestState: TranscriptIngestState;
  truncated: boolean;
  indexedBytes: number;
  sourceVersion: string | null;
  allowedActions: readonly ('download' | 'edit' | 'new_version')[];
}

export interface TeamTextEditRequest {
  teamId: string;
  materialId: string;
  text: string;
  expectedDriveVersion: string;
  expectedChecksum?: string;
  idempotencyKey: string;
}

export interface TeamSeparateVersionRequest {
  teamId: string;
  sourceMaterialId: string;
  destinationFolderId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  conflictMode: 'cancel' | 'keep_both';
  idempotencyKey: string;
}

export type TeamPreviewUnavailableReason =
  'unsupported' | 'corrupt' | 'protected' | 'too_large' | 'agent_required';

export type TeamPreviewResult =
  | {
      kind: 'media';
      rangeUrl: string;
      mimeType: string;
      expiresAt: string;
    }
  | ({ kind: 'transcript' } & TeamTranscriptSnapshot)
  | {
      kind: 'agent';
      operationId: string;
      transferGrant: TeamTransferGrant;
      previewKind: 'archive' | 'landing';
    }
  | {
      kind: 'unavailable';
      reason: TeamPreviewUnavailableReason;
      allowedActions: readonly ('download' | 'new_version')[];
    };

export interface TeamArchiveManifestEntry {
  path: string;
  directory: boolean;
  sizeBytes: number;
}

export interface TeamLandingValidationRecord {
  sourceVersion: string | null;
  sourceChecksum: string | null;
  fingerprint: string;
  landingRoot: string;
}

export type TeamAgentPreviewResult =
  | {
      kind: 'archive';
      operationId: string;
      entries: TeamArchiveManifestEntry[];
      truncated: false;
    }
  | {
      kind: 'landing';
      operationId: string;
      url: string;
      sandbox: 'allow-scripts';
      warning: 'external_navigation_blocked' | null;
      screenshotAvailable: boolean;
      validation: TeamLandingValidationRecord;
    }
  | {
      kind: 'unavailable';
      operationId: string;
      reason: TeamPreviewUnavailableReason;
    };

export interface TeamAgentProcessRequest {
  operationId: string;
  toolId: string;
  options: unknown;
  sourceGrant: TeamTransferGrant;
  finalizeGrant: TeamTransferGrant;
}

export interface TeamUploadSession {
  operationId: string;
  state: 'pending' | 'running';
  sessionUri: string | null;
  sessionUnavailable: boolean;
  name: string;
  chunkMultiple: number;
  expiresAt: string | null;
  relayUrl: string | null;
}

export interface TeamFileOperationResult {
  operationId: string;
  state: TeamOperationState;
  materialId: string | null;
  reused: boolean;
}

export type TeamDownloadGrantResult =
  | {
      kind: 'browser';
      rangeUrl: string;
      expiresAt: string;
      disposition: 'attachment';
    }
  | {
      kind: 'agent';
      transferUrl: string;
      grant: TeamTransferGrant;
    };

export interface TeamProcessStartResult {
  operationId: string;
  state: 'pending' | 'running';
  sourceGrant: TeamTransferGrant;
  finalizeGrant: TeamTransferGrant;
  agentContractVersion: number;
}

export interface TeamMaterialProvenanceEntry {
  linkId: string;
  relation: 'processed_from' | 'version_of';
  sourceMaterialId: string;
  derivativeMaterialId: string;
  sourceNameSnapshot: string;
  sourceName: string;
  sourceLifecycle: 'active' | 'trashed' | 'missing';
  derivativeName: string;
  derivativeLifecycle: 'active' | 'trashed' | 'missing';
  toolId: string | null;
  toolContractVersion: number | null;
  createdAt: string;
}

export interface TeamMaterialSummary {
  id: string;
  teamId: string;
  name: string;
  category: MaterialCategory | null;
  mimeType: string | null;
  fileExtension: string | null;
  sizeBytes: number | null;
}

function isTeamErrorCode(value: unknown): value is TeamErrorCode {
  return typeof value === 'string' && (TEAM_ERROR_CODES as readonly string[]).includes(value);
}

function safeDetails(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) continue;
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      if (typeof entry !== 'string' || entry.length <= 160) output[key] = entry;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function parseTeamEdgeResult(value: unknown): TeamEdgeResult<unknown> {
  if (isRecord(value) && value.ok === true && 'value' in value) {
    return { ok: true, value: value.value };
  }
  if (isRecord(value) && value.ok === false && isRecord(value.error)) {
    const code = value.error.code;
    const retryable = value.error.retryable;
    if (isTeamErrorCode(code) && typeof retryable === 'boolean') {
      const details = safeDetails(value.error.details);
      return {
        ok: false,
        error: { code, retryable, ...(details ? { details } : {}) }
      };
    }
  }
  return {
    ok: false,
    error: { code: 'INVALID_RESPONSE', retryable: false }
  };
}

export function parseTeamOperationSnapshot(value: unknown): TeamOperationSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.teamId !== 'string' ||
    typeof value.kind !== 'string' ||
    !(TEAM_OPERATION_KINDS as readonly string[]).includes(value.kind) ||
    typeof value.state !== 'string' ||
    !(TEAM_OPERATION_STATES as readonly string[]).includes(value.state) ||
    (value.stage !== null && typeof value.stage !== 'string') ||
    typeof value.progress !== 'number' ||
    value.progress < 0 ||
    value.progress > 100 ||
    (value.sourceMaterialId !== null && typeof value.sourceMaterialId !== 'string') ||
    (value.resultMaterialId !== null && typeof value.resultMaterialId !== 'string') ||
    (value.errorCode !== null && !isTeamErrorCode(value.errorCode)) ||
    typeof value.retryable !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    teamId: value.teamId,
    kind: value.kind as TeamOperationKind,
    state: value.state as TeamOperationState,
    stage: value.stage,
    progress: value.progress,
    sourceMaterialId: value.sourceMaterialId,
    resultMaterialId: value.resultMaterialId,
    errorCode: value.errorCode,
    retryable: value.retryable,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

const PREVIEW_UNAVAILABLE_REASONS = new Set<TeamPreviewUnavailableReason>([
  'unsupported',
  'corrupt',
  'protected',
  'too_large',
  'agent_required'
]);
const PREVIEW_ACTIONS = new Set(['download', 'edit', 'new_version']);

function stringArray(value: unknown, allowed: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(value) || value.length > allowed.size) return null;
  if (!value.every(entry => typeof entry === 'string' && allowed.has(entry))) return null;
  return [...new Set(value as string[])];
}

export function parseTeamTransferGrant(value: unknown): TeamTransferGrant | null {
  if (
    !isRecord(value) ||
    typeof value.ticket !== 'string' ||
    value.ticket.length < 16 ||
    value.ticket.length > 2048 ||
    typeof value.purpose !== 'string' ||
    !(TEAM_TRANSFER_PURPOSES as readonly string[]).includes(value.purpose) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.maxRangeBytes !== 'number' ||
    !Number.isInteger(value.maxRangeBytes) ||
    value.maxRangeBytes < 1 ||
    value.maxRangeBytes > 32 * 1024 * 1024 ||
    typeof value.maxUses !== 'number' ||
    !Number.isInteger(value.maxUses) ||
    value.maxUses < 1 ||
    value.maxUses > 10_000
  ) {
    return null;
  }
  return {
    ticket: value.ticket,
    purpose: value.purpose as TeamTransferPurpose,
    expiresAt: value.expiresAt,
    maxRangeBytes: value.maxRangeBytes,
    maxUses: value.maxUses
  };
}

export function parseTeamPreviewResult(value: unknown): TeamPreviewResult | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'media') {
    if (
      typeof value.rangeUrl !== 'string' ||
      !/^https?:\/\//u.test(value.rangeUrl) ||
      typeof value.mimeType !== 'string' ||
      value.mimeType.length < 3 ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      return null;
    }
    return {
      kind: 'media',
      rangeUrl: value.rangeUrl,
      mimeType: value.mimeType,
      expiresAt: value.expiresAt
    };
  }
  if (value.kind === 'transcript') {
    const actions = stringArray(value.allowedActions, PREVIEW_ACTIONS);
    if (
      (value.text !== null && typeof value.text !== 'string') ||
      typeof value.ingestState !== 'string' ||
      ![
        'full',
        'truncated',
        'invalid_encoding',
        'unavailable',
        'pending',
        'not_applicable'
      ].includes(value.ingestState) ||
      typeof value.truncated !== 'boolean' ||
      typeof value.indexedBytes !== 'number' ||
      !Number.isInteger(value.indexedBytes) ||
      value.indexedBytes < 0 ||
      value.indexedBytes > 1024 * 1024 ||
      (value.sourceVersion !== null && typeof value.sourceVersion !== 'string') ||
      !actions
    ) {
      return null;
    }
    return {
      kind: 'transcript',
      text: value.text,
      ingestState: value.ingestState as TranscriptIngestState,
      truncated: value.truncated,
      indexedBytes: value.indexedBytes,
      sourceVersion: value.sourceVersion,
      allowedActions: actions as Array<'download' | 'edit' | 'new_version'>
    };
  }
  if (value.kind === 'agent') {
    const transferGrant = parseTeamTransferGrant(value.transferGrant);
    if (
      typeof value.operationId !== 'string' ||
      !transferGrant ||
      transferGrant.purpose !== 'preview_range' ||
      (value.previewKind !== 'archive' && value.previewKind !== 'landing')
    ) {
      return null;
    }
    return {
      kind: 'agent',
      operationId: value.operationId,
      transferGrant,
      previewKind: value.previewKind
    };
  }
  if (value.kind === 'unavailable') {
    const actions = stringArray(value.allowedActions, PREVIEW_ACTIONS);
    if (
      typeof value.reason !== 'string' ||
      !PREVIEW_UNAVAILABLE_REASONS.has(value.reason as TeamPreviewUnavailableReason) ||
      !actions ||
      actions.some(action => action === 'edit')
    ) {
      return null;
    }
    return {
      kind: 'unavailable',
      reason: value.reason as TeamPreviewUnavailableReason,
      allowedActions: actions as Array<'download' | 'new_version'>
    };
  }
  return null;
}

export function parseTeamAgentPreviewResult(value: unknown): TeamAgentPreviewResult | null {
  if (!isRecord(value) || typeof value.operationId !== 'string') return null;
  if (value.kind === 'archive') {
    if (
      !Array.isArray(value.entries) ||
      value.entries.length > 50_000 ||
      value.truncated !== false
    ) {
      return null;
    }
    const entries: TeamArchiveManifestEntry[] = [];
    for (const raw of value.entries) {
      if (
        !isRecord(raw) ||
        typeof raw.path !== 'string' ||
        typeof raw.directory !== 'boolean' ||
        typeof raw.sizeBytes !== 'number' ||
        !Number.isSafeInteger(raw.sizeBytes) ||
        raw.sizeBytes < 0
      ) {
        return null;
      }
      entries.push({ path: raw.path, directory: raw.directory, sizeBytes: raw.sizeBytes });
    }
    return { kind: 'archive', operationId: value.operationId, entries, truncated: false };
  }
  if (value.kind === 'landing') {
    const validation = value.validation;
    if (
      typeof value.url !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d+\//u.test(value.url) ||
      value.sandbox !== 'allow-scripts' ||
      (value.warning !== null && value.warning !== 'external_navigation_blocked') ||
      typeof value.screenshotAvailable !== 'boolean' ||
      !isRecord(validation) ||
      (validation.sourceVersion !== null && typeof validation.sourceVersion !== 'string') ||
      (validation.sourceChecksum !== null && typeof validation.sourceChecksum !== 'string') ||
      typeof validation.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(validation.fingerprint) ||
      typeof validation.landingRoot !== 'string'
    ) {
      return null;
    }
    return {
      kind: 'landing',
      operationId: value.operationId,
      url: value.url,
      sandbox: 'allow-scripts',
      warning: value.warning,
      screenshotAvailable: value.screenshotAvailable,
      validation: {
        sourceVersion: validation.sourceVersion,
        sourceChecksum: validation.sourceChecksum,
        fingerprint: validation.fingerprint,
        landingRoot: validation.landingRoot
      }
    };
  }
  if (
    value.kind === 'unavailable' &&
    typeof value.reason === 'string' &&
    PREVIEW_UNAVAILABLE_REASONS.has(value.reason as TeamPreviewUnavailableReason)
  ) {
    return {
      kind: 'unavailable',
      operationId: value.operationId,
      reason: value.reason as TeamPreviewUnavailableReason
    };
  }
  return null;
}

export function parseTeamUploadSession(value: unknown): TeamUploadSession | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !['pending', 'running'].includes(String(value.state)) ||
    (value.sessionUri !== null &&
      (typeof value.sessionUri !== 'string' || !/^https:\/\//u.test(value.sessionUri))) ||
    typeof value.sessionUnavailable !== 'boolean' ||
    typeof value.name !== 'string' ||
    typeof value.chunkMultiple !== 'number' ||
    !Number.isInteger(value.chunkMultiple) ||
    value.chunkMultiple !== 256 * 1024 ||
    (value.expiresAt !== null &&
      (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) ||
    (value.relayUrl !== null &&
      (typeof value.relayUrl !== 'string' || !/^https?:\/\//u.test(value.relayUrl)))
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    state: value.state as 'pending' | 'running',
    sessionUri: value.sessionUri,
    sessionUnavailable: value.sessionUnavailable,
    name: value.name,
    chunkMultiple: value.chunkMultiple,
    expiresAt: value.expiresAt,
    relayUrl: value.relayUrl
  };
}

export function parseTeamFileOperationResult(value: unknown): TeamFileOperationResult | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    typeof value.state !== 'string' ||
    !(TEAM_OPERATION_STATES as readonly string[]).includes(value.state) ||
    (value.materialId !== null && typeof value.materialId !== 'string') ||
    typeof value.reused !== 'boolean'
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    state: value.state as TeamOperationState,
    materialId: value.materialId,
    reused: value.reused
  };
}

export function parseTeamDownloadGrantResult(value: unknown): TeamDownloadGrantResult | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === 'browser' &&
    typeof value.rangeUrl === 'string' &&
    /^https?:\/\//u.test(value.rangeUrl) &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    value.disposition === 'attachment'
  ) {
    return {
      kind: 'browser',
      rangeUrl: value.rangeUrl,
      expiresAt: value.expiresAt,
      disposition: 'attachment'
    };
  }
  const grant = parseTeamTransferGrant(value.grant);
  if (
    value.kind === 'agent' &&
    typeof value.transferUrl === 'string' &&
    /^https?:\/\//u.test(value.transferUrl) &&
    grant?.purpose === 'download_range'
  ) {
    return { kind: 'agent', transferUrl: value.transferUrl, grant };
  }
  return null;
}

export function parseTeamProcessStartResult(value: unknown): TeamProcessStartResult | null {
  if (!isRecord(value)) return null;
  const sourceGrant = parseTeamTransferGrant(value.sourceGrant);
  const finalizeGrant = parseTeamTransferGrant(value.finalizeGrant);
  if (
    typeof value.operationId !== 'string' ||
    !['pending', 'running'].includes(String(value.state)) ||
    sourceGrant?.purpose !== 'process_input' ||
    finalizeGrant?.purpose !== 'finalize' ||
    typeof value.agentContractVersion !== 'number' ||
    !Number.isInteger(value.agentContractVersion) ||
    value.agentContractVersion < 1
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    state: value.state as 'pending' | 'running',
    sourceGrant,
    finalizeGrant,
    agentContractVersion: value.agentContractVersion
  };
}
