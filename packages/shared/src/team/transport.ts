import {
  LANGUAGE_CODES,
  TEAM_OPERATION_KINDS,
  TEAM_OPERATION_STATES,
  TEAM_STORAGE_ATTENTION_REASONS,
  isRecord,
  type TeamOperationKind,
  type TeamOperationState,
  type TeamStorageAttentionReason,
  type TranscriptIngestState
} from './contract.js';
import {
  MATERIAL_CATEGORIES,
  TEAM_MATERIAL_ROW_KINDS,
  type MaterialCategory,
  type TeamMaterialRowKind
} from './material-category.js';

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
  'AGENT_UPDATE_REQUIRED',
  'NO_WORK',
  'LEASE_EXPIRED',
  'LEASE_MISMATCH',
  'ALREADY_COMPLETED',
  'STALE_RESULT',
  'GROUP_RECONCILING',
  'SHARE_NOT_ALLOWED',
  // `remove_member` has raised OWNER_TRANSFER_REQUIRED since 001 while only the
  // longer OWNERSHIP_TRANSFER_REQUIRED (the Edge Function's spelling) was
  // registered here — so the raised code fell through every consumer's mapping
  // as unknown. `leave_team` raises the same code, so it is registered rather
  // than renamed: the string on the wire is the contract.
  'OWNER_TRANSFER_REQUIRED',
  // `delete_draft_team` on a team that has ever had a drive connection.
  'TEAM_NOT_DRAFT',
  // 011 — storage selections, folder tree, thumbnail sessions and scope gating.
  'SELECTION_UNREACHABLE',
  'ROOT_SELECTION_REQUIRED',
  'ROOT_MISSING',
  'TREE_TOO_LARGE',
  'THUMBNAIL_SESSION_EXPIRED',
  'RESTRICTED_SCOPE_NOT_APPROVED',
  // 015 — the space's re-stitching defaults and the material preparation behind them.
  'RESTITCH_FORBIDDEN',
  'RESTITCH_NO_SCREENS',
  'RESTITCH_INVALID',
  // The storage refused to open a resumable upload for a file the browser was
  // about to send. Raised in the browser, not by the boundary, which is why it
  // must be a code and not a bare `Error`: thrown as one it reached the reader
  // as "something went wrong, try again in a moment", which named neither the
  // file nor anything they could do.
  'UPLOAD_SESSION_UNAVAILABLE'
] as const;
export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

export interface TeamStructuredError {
  code: TeamErrorCode;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export type TeamEdgeResult<T> = { ok: true; value: T } | { ok: false; error: TeamStructuredError };
export type TeamRpcResult<T> = TeamEdgeResult<T>;

export const CATALOG_SYNC_PHASES = [
  'initial_scan',
  'change_replay',
  'incremental',
  'reconcile'
] as const;
export type CatalogSyncPhase = (typeof CATALOG_SYNC_PHASES)[number];
export const CATALOG_SYNC_JOB_KINDS = [
  'incremental',
  'initial',
  'user_subtree',
  'discovered_subtree',
  'reconcile'
] as const;
export type CatalogSyncJobKind = (typeof CATALOG_SYNC_JOB_KINDS)[number];
export const CATALOG_COVERAGE_STATES = [
  'unknown',
  'complete',
  'partial',
  'permission_limited'
] as const;
export type CatalogCoverageState = (typeof CATALOG_COVERAGE_STATES)[number];
export const CATALOG_SYNC_JOB_STATES = [
  'pending',
  'leased',
  'retry',
  'succeeded',
  'failed',
  'canceled'
] as const;
export type CatalogSyncJobState = (typeof CATALOG_SYNC_JOB_STATES)[number];
export const FOLDER_SYNC_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type FolderSyncState = (typeof FOLDER_SYNC_STATES)[number];
export const FOLDER_SYNC_PHASES = ['listing', 'reconciling', 'replaying_changes', 'done'] as const;
export const CATALOG_SYNC_BOUNDS = {
  pageSize: 100,
  frontierBatch: 100,
  providerConcurrency: 6,
  globalLeases: 3,
  consecutiveFailures: 10,
  cleanupBatch: 500,
  orphanRetentionMs: 24 * 60 * 60_000,
  finiteRetentionMs: 7 * 24 * 60 * 60_000
} as const;

/** Browser-only intake bounds. No local source is serialized to an Edge RPC. */
export const LOCAL_MANIFEST_BOUNDS = {
  files: 1_000,
  directories: 100,
  depth: 10,
  pathLength: 1_024,
  segmentLength: 255,
  fileBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024 * 1024
} as const;

export const LOCAL_OPERATION_STATES = [
  'preparing',
  'running',
  'partial',
  'succeeded',
  'failed',
  'canceled',
  'interrupted_input_required'
] as const;
export type LocalOperationState = (typeof LOCAL_OPERATION_STATES)[number];
export const LOCAL_ITEM_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'input_required'
] as const;
export type LocalItemState = (typeof LOCAL_ITEM_STATES)[number];
export const LOCAL_OPERATION_STAGES = [
  'preparing',
  'creating_folders',
  'transferring',
  'moving',
  'updating_catalog',
  'done'
] as const;
export type LocalOperationStage = (typeof LOCAL_OPERATION_STAGES)[number];
export const LOCAL_MANIFEST_ISSUE_CODES = [
  'INVALID_PATH',
  'UNREADABLE',
  'LIMIT_EXCEEDED',
  'CYCLE',
  'CANCELED',
  'DUPLICATE'
] as const;
export type LocalManifestIssueCode = (typeof LOCAL_MANIFEST_ISSUE_CODES)[number];

export interface LocalManifestDirectoryEntry {
  kind: 'directory';
  clientItemKey: string;
  relativePath: string;
  comparisonPath: string;
  parentKey: string | null;
  depth: number;
}
export interface LocalManifestFileEntry {
  kind: 'file';
  clientItemKey: string;
  relativePath: string;
  comparisonPath: string;
  parentKey: string | null;
  depth: number;
  sizeBytes: number;
  mimeType: string;
  source: File;
}
export type LocalManifestEntry = LocalManifestDirectoryEntry | LocalManifestFileEntry;
export type LocalManifestMetadataEntry =
  LocalManifestDirectoryEntry | Omit<LocalManifestFileEntry, 'source'>;

export function isLocalOperationState(value: unknown): value is LocalOperationState {
  return LOCAL_OPERATION_STATES.some(state => state === value);
}
export function isLocalItemState(value: unknown): value is LocalItemState {
  return LOCAL_ITEM_STATES.some(state => state === value);
}
export function isLocalOperationStage(value: unknown): value is LocalOperationStage {
  return LOCAL_OPERATION_STAGES.some(stage => stage === value);
}
export function isLocalManifestIssueCode(value: unknown): value is LocalManifestIssueCode {
  return LOCAL_MANIFEST_ISSUE_CODES.some(code => code === value);
}

/** A relative, non-empty path. Display names stay unchanged; NFC is comparison only. */
export function isLocalManifestRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > LOCAL_MANIFEST_BOUNDS.pathLength ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.includes('\0')
  )
    return false;
  const segments = value.split('/');
  return (
    segments.length <= LOCAL_MANIFEST_BOUNDS.depth + 1 &&
    segments.every(
      segment =>
        segment.length > 0 &&
        segment.length <= LOCAL_MANIFEST_BOUNDS.segmentLength &&
        segment !== '.' &&
        segment !== '..' &&
        !/^[A-Za-z]:$/.test(segment)
    )
  );
}

/** Strict metadata projection for the local journal; rejects File/handles/paths outside the tree. */
export function isLocalManifestMetadata(value: unknown): value is LocalManifestMetadataEntry {
  if (!isRecord(value) || !isLocalManifestRelativePath(value.relativePath)) return false;
  const common = ['kind', 'clientItemKey', 'relativePath', 'comparisonPath', 'parentKey', 'depth'];
  const isCommon =
    typeof value.clientItemKey === 'string' &&
    value.clientItemKey.length > 0 &&
    typeof value.comparisonPath === 'string' &&
    value.comparisonPath === value.relativePath.normalize('NFC') &&
    (value.parentKey === null || typeof value.parentKey === 'string') &&
    typeof value.depth === 'number' &&
    Number.isSafeInteger(value.depth) &&
    value.depth === value.relativePath.split('/').length - 1;
  if (!isCommon) return false;
  if (value.kind === 'directory') return Object.keys(value).every(key => common.includes(key));
  if (value.kind !== 'file') return false;
  return (
    Object.keys(value).every(key => [...common, 'sizeBytes', 'mimeType'].includes(key)) &&
    typeof value.sizeBytes === 'number' &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    value.sizeBytes <= LOCAL_MANIFEST_BOUNDS.fileBytes &&
    typeof value.mimeType === 'string'
  );
}

export function isCatalogSyncPhase(value: unknown): value is CatalogSyncPhase {
  return CATALOG_SYNC_PHASES.some(candidate => candidate === value);
}
export function isCatalogSyncJobKind(value: unknown): value is CatalogSyncJobKind {
  return CATALOG_SYNC_JOB_KINDS.some(candidate => candidate === value);
}
export function isCatalogCoverageState(value: unknown): value is CatalogCoverageState {
  return CATALOG_COVERAGE_STATES.some(candidate => candidate === value);
}
export function isCatalogSyncJobState(value: unknown): value is CatalogSyncJobState {
  return CATALOG_SYNC_JOB_STATES.some(candidate => candidate === value);
}
export interface FolderSyncStatus {
  jobId: string;
  scopeFolderId: string;
  state: FolderSyncState;
  phase: (typeof FOLDER_SYNC_PHASES)[number];
  discoveredFiles: number;
  completedFolders: number;
  pendingFolders: number | null;
  lastProgressAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
}

/** Safe projection only; reject accidental exposure of private queue fields. */
export function parseFolderSyncStatus(value: unknown): FolderSyncStatus | null {
  if (!isRecord(value)) return null;
  const keys = [
    'jobId',
    'scopeFolderId',
    'state',
    'phase',
    'discoveredFiles',
    'completedFolders',
    'pendingFolders',
    'lastProgressAt',
    'completedAt',
    'errorCode'
  ];
  if (Object.keys(value).some(key => !keys.includes(key))) return null;
  const state = FOLDER_SYNC_STATES.find(candidate => candidate === value.state);
  const phase = FOLDER_SYNC_PHASES.find(candidate => candidate === value.phase);
  const count = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const nullableText = (s: unknown): s is string | null => s === null || typeof s === 'string';
  if (
    !state ||
    !phase ||
    typeof value.jobId !== 'string' ||
    !value.jobId ||
    typeof value.scopeFolderId !== 'string' ||
    !value.scopeFolderId ||
    !count(value.discoveredFiles) ||
    !count(value.completedFolders) ||
    !(value.pendingFolders === null || count(value.pendingFolders)) ||
    !nullableText(value.lastProgressAt) ||
    !nullableText(value.completedAt) ||
    !nullableText(value.errorCode)
  )
    return null;
  return {
    jobId: value.jobId,
    scopeFolderId: value.scopeFolderId,
    state,
    phase,
    discoveredFiles: value.discoveredFiles,
    completedFolders: value.completedFolders,
    pendingFolders: value.pendingFolders,
    lastProgressAt: value.lastProgressAt,
    completedAt: value.completedAt,
    errorCode: value.errorCode
  };
}

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
  'finalize',
  // 011: one team-bound session for a whole grid of thumbnails.
  'thumbnail_session'
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
  /**
   * The language the run actually worked in, when the run is one that knows —
   * a transcription reads it from Whisper, or is told it outright. The space
   * records it on the material, so "what language is this video in" stops being
   * a question every member answers by watching it. Absent from every other
   * tool, and from agents that predate this.
   */
  sourceLanguage?: string;
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

/**
 * A run's language, as the catalogue stores languages: a plain ISO 639-1 code.
 * Whisper answers with those, but it also answers `auto` and the odd regional
 * tag, and an agent is free to send anything — so a value the catalogue would
 * refuse is dropped here rather than carried to a write that will fail.
 */
function normalizeSourceLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (LANGUAGE_CODES as readonly string[]).includes(code) ? code : null;
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
  const sourceLanguage = normalizeSourceLanguage(value.sourceLanguage);
  return {
    operationId: value.operationId,
    state: value.state as TeamOperationState,
    materialId: value.materialId,
    reused: value.reused,
    ...(sourceLanguage ? { sourceLanguage } : {})
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

// ---------------------------------------------------------------------------
// 011 — explorer reads: selections, folder tree, paged rows, thumbnail
// sessions and the one storage-health value the chip renders. Every row
// crosses from SQL as `unknown` and is narrowed here; the interface never
// trusts a shape it did not check.
// ---------------------------------------------------------------------------

export const TEAM_DRIVE_SELECTION_STATES = ['active', 'missing', 'removed'] as const;
export type TeamDriveSelectionState = (typeof TEAM_DRIVE_SELECTION_STATES)[number];

export interface TeamDriveSelection {
  id: string;
  driveFolderId: string;
  name: string;
  isRoot: boolean;
  state: TeamDriveSelectionState;
}

export interface TeamFolderNode {
  id: string;
  driveFileId: string;
  parentFolderId: string | null;
  selectionId: string | null;
  name: string;
  /** Null until the last page of this folder's children has landed. */
  indexedAt: string | null;
  childFolderCount: number;
  childFileCount: number;
  thumbnailReadyCount: number;
}

export const TEAM_PREVIEW_STATES = ['pending', 'ready', 'unavailable', 'not_applicable'] as const;
export type TeamPreviewState = (typeof TEAM_PREVIEW_STATES)[number];

export const TEAM_LANDING_TILE_RENDER_STATES = [
  'ready',
  'rendering',
  'stale',
  'failed',
  'none'
] as const;
export type TeamLandingTileRenderState = (typeof TEAM_LANDING_TILE_RENDER_STATES)[number];

/**
 * A file's tag, in Finder's vocabulary: seven colours and none. The product
 * never says what any of them means — a team's own reading of red is the only
 * one that would be right — so they are named by what they look like.
 */
export const TEAM_MATERIAL_TAG_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'grey'
] as const;
export type TeamMaterialTagColor = (typeof TEAM_MATERIAL_TAG_COLORS)[number];

export function isTeamMaterialTagColor(value: unknown): value is TeamMaterialTagColor {
  return (
    typeof value === 'string' && (TEAM_MATERIAL_TAG_COLORS as readonly string[]).includes(value)
  );
}

/**
 * Where a colour sorts. The order is the one the swatches are drawn in — the
 * spectrum, then grey — so a sorted list and the picker agree; untagged rows
 * take the end, where a row with nothing to say belongs.
 */
export function teamMaterialTagRank(color: TeamMaterialTagColor | null | undefined): number {
  if (!color) return TEAM_MATERIAL_TAG_COLORS.length;
  return TEAM_MATERIAL_TAG_COLORS.indexOf(color);
}

export interface TeamMaterialRow extends TeamMaterialSummary {
  kind: TeamMaterialRowKind;
  /** The file's tag, or null when it carries none. */
  tagColor?: TeamMaterialTagColor | null;
  /** The provider id; folders are opened by it. */
  driveFileId: string;
  parentFolderId: string | null;
  modifiedAt: string | null;
  driveVersion: string | null;
  previewState: TeamPreviewState;
  previewReason?: string;
  thumbnailReady: boolean;
  landingRender?: { state: TeamLandingTileRenderState };
}

export interface FolderPageCursor {
  sortKey: string;
  id: string;
}

export interface FolderPage {
  rows: TeamMaterialRow[];
  total: number;
  next: FolderPageCursor | null;
}

export interface ThumbnailSession {
  token: string;
  expiresAt: string;
  teamId: string;
  /** The relay to append `?material=&session=` to. */
  endpoint: string;
}

export type CatalogSyncHealth = 'current' | 'working' | 'delayed' | 'needs_reauth' | 'failed';
export type CatalogNextAction =
  'none' | 'wait' | 'retry' | 'reconnect' | 'restore_root' | 'grant_access' | 'connect';

type StorageCoverageDetail = {
  /** Additive during rollout; absent from the legacy storage-health RPC. */
  coverage?: CatalogCoverageState;
  syncHealth?: CatalogSyncHealth;
  lastConfirmedAt?: string | null;
  nextAction?: CatalogNextAction;
};

export type StorageHealth = (
  | { kind: 'connected'; lastReconciledAt: string }
  | { kind: 'indexing'; indexedFolders: number; totalFolders: number | null; files: number }
  | { kind: 'preparing'; ready: number; pending: number }
  | { kind: 'waiting_provider'; since: string }
  | { kind: 'attention'; reason: TeamStorageAttentionReason; fixer: 'owner' | 'manager' }
  | { kind: 'disconnected' }
) &
  StorageCoverageDetail;

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isTeamDriveSelection(value: unknown): value is TeamDriveSelection {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.driveFolderId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.isRoot === 'boolean' &&
    (TEAM_DRIVE_SELECTION_STATES as readonly string[]).includes(value.state as string)
  );
}

export function isTeamFolderNode(value: unknown): value is TeamFolderNode {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.driveFileId === 'string' &&
    optionalString(value.parentFolderId) &&
    optionalString(value.selectionId) &&
    typeof value.name === 'string' &&
    optionalString(value.indexedAt) &&
    count(value.childFolderCount) &&
    count(value.childFileCount) &&
    count(value.thumbnailReadyCount)
  );
}

export function isTeamMaterialRow(value: unknown): value is TeamMaterialRow {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    typeof value.teamId !== 'string' ||
    typeof value.name !== 'string' ||
    !(
      value.category === null ||
      (MATERIAL_CATEGORIES as readonly string[]).includes(value.category as string)
    ) ||
    !optionalString(value.mimeType) ||
    !optionalString(value.fileExtension) ||
    !(value.sizeBytes === null || typeof value.sizeBytes === 'number') ||
    !(TEAM_MATERIAL_ROW_KINDS as readonly string[]).includes(value.kind as string) ||
    typeof value.driveFileId !== 'string' ||
    !optionalString(value.parentFolderId) ||
    !optionalString(value.modifiedAt) ||
    !optionalString(value.driveVersion) ||
    !(TEAM_PREVIEW_STATES as readonly string[]).includes(value.previewState as string) ||
    typeof value.thumbnailReady !== 'boolean'
  ) {
    return false;
  }
  if (value.previewReason !== undefined && typeof value.previewReason !== 'string') return false;
  // The column is constrained to these seven in the database, so a value that
  // is not one of them means the payload is not what this build understands —
  // the same standing this guard gives every other field.
  if (
    value.tagColor !== undefined &&
    value.tagColor !== null &&
    !isTeamMaterialTagColor(value.tagColor)
  ) {
    return false;
  }
  if (value.landingRender !== undefined) {
    if (!isRecord(value.landingRender)) return false;
    if (
      !(TEAM_LANDING_TILE_RENDER_STATES as readonly string[]).includes(
        value.landingRender.state as string
      )
    ) {
      return false;
    }
  }
  return true;
}

export function isFolderPage(value: unknown): value is FolderPage {
  if (!isRecord(value) || !Array.isArray(value.rows) || !count(value.total)) return false;
  if (!value.rows.every(isTeamMaterialRow)) return false;
  if (value.next === null) return true;
  return (
    isRecord(value.next) &&
    typeof value.next.sortKey === 'string' &&
    typeof value.next.id === 'string'
  );
}

export function isThumbnailSession(value: unknown): value is ThumbnailSession {
  return (
    isRecord(value) &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    typeof value.expiresAt === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.endpoint === 'string' &&
    /^https?:\/\//u.test(value.endpoint)
  );
}

export function isStorageHealth(value: unknown): value is StorageHealth {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (
    (value.coverage !== undefined &&
      !['unknown', 'complete', 'partial', 'permission_limited'].includes(
        value.coverage as string
      )) ||
    (value.syncHealth !== undefined &&
      !['current', 'working', 'delayed', 'needs_reauth', 'failed'].includes(
        value.syncHealth as string
      )) ||
    (value.lastConfirmedAt !== undefined && !optionalString(value.lastConfirmedAt)) ||
    (value.nextAction !== undefined &&
      !['none', 'wait', 'retry', 'reconnect', 'restore_root', 'grant_access', 'connect'].includes(
        value.nextAction as string
      ))
  )
    return false;
  switch (value.kind) {
    case 'connected':
      return typeof value.lastReconciledAt === 'string';
    case 'indexing':
      return (
        count(value.indexedFolders) &&
        (value.totalFolders === null || count(value.totalFolders)) &&
        count(value.files)
      );
    case 'preparing':
      return count(value.ready) && count(value.pending);
    case 'waiting_provider':
      return typeof value.since === 'string';
    case 'attention':
      return (
        (TEAM_STORAGE_ATTENTION_REASONS as readonly string[]).includes(value.reason as string) &&
        (value.fixer === 'owner' || value.fixer === 'manager')
      );
    case 'disconnected':
      return true;
    default:
      return false;
  }
}
