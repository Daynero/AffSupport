import {
  MATERIAL_CATEGORIES,
  TEAM_BASE_ROLES,
  TEAM_ERROR_CODES,
  TEAM_INVITATION_DELIVERY_STATES,
  TEAM_INVITATION_STATES,
  TEAM_PERMISSION_FLAGS,
  decodeCatalogMaterial,
  decodeCatalogSearchResponse,
  normalizeCatalogSearchRequest,
  normalizeMaterialMetadataPatch,
  parseTeamEdgeResult,
  parseTeamDownloadGrantResult,
  parseTeamFileOperationResult,
  parseTeamPreviewResult,
  parseTeamProcessStartResult,
  parseTeamTransferGrant,
  parseTeamUploadSession,
  parseLibraryJobClaim,
  parseLibraryJobFinalize,
  parseLibraryJobHeartbeat,
  parseLibraryPlacementMutation,
  parseLibraryShareCopyRequest,
  parseLibraryShareCopyResult,
  parseLibraryAssetSummary,
  parseLibraryVideoTextVariants,
  parseTaskAttachmentMutation,
  parseTeamTaskAttachmentSummary,
  parseTeamTaskPatch,
  parseUploadBatchRequest,
  isFolderPage,
  isStorageHealth,
  isThumbnailSession,
  isTeamDriveSelection,
  isTeamFolderNode,
  type FolderPage,
  type FolderPageCursor,
  type StorageHealth,
  type ThumbnailSession,
  type TeamDriveSelection,
  type TeamFolderNode,
  type TeamMaterialRowKind,
  type LandingRenderPointer,
  type RenderArtifactRef,
  type CatalogMaterialItem,
  type CatalogSearchRequestInput,
  type CatalogSearchResponse,
  type CatalogVocabulary,
  type MaterialMetadataPatch,
  type MaterialCategory,
  type MaterialKind,
  type TeamErrorCode,
  type TeamInvitationDeliveryState,
  type TeamInvitationState,
  type TeamBaseRole,
  type TeamLandingValidationRecord,
  type TeamLandingRenderJob,
  type TeamDownloadGrantResult,
  type TeamFileOperationResult,
  type TeamMaterialProvenanceEntry,
  type TeamOperationState,
  type TeamPermissions,
  type TeamPermissionFlag,
  type TeamPreviewResult,
  type TeamProcessStartResult,
  type TeamTextEditRequest,
  type TeamUploadSession,
  type TeamRole,
  type LibraryJobClaimRequest,
  type LibraryJobFinalizeRequest,
  type LibraryJobFinalizeResult,
  type LibraryJobHeartbeatRequest,
  type LibraryPlacementMutationRequest,
  type LibraryShareCopyRequest,
  type LibraryShareCopyResult,
  type LibraryAssetSummary,
  type UploadBatchRequest,
  type LibraryVideoTextVariants,
  type TeamTaskPatch,
  type TeamTaskStatus,
  type TeamTaskSummary,
  type TeamTaskAttachmentSummary
} from '@video-compressor/shared';
import type { Json } from '../lib/database.types';
import { publicConfig } from '../lib/config';
import { requireSupabaseClient } from '../lib/supabase';

/**
 * The same address, as this browser can reach it.
 *
 * A function sits behind the gateway and sees only the internal host it was
 * forwarded to, so every URL it hands back — a byte range, a thumbnail, an
 * upload relay — pointed at the container talking to itself. The path is the
 * function's to decide; the origin is ours.
 */
export function browserFunctionUrl(reported: string): string {
  if (!publicConfig.ok) throw new TeamApiError('INVALID_RESPONSE', false);
  const source = new URL(reported);
  const path = source.pathname.replace(/^\/functions\/v1/u, '');
  const url = new URL(`${publicConfig.value.supabaseUrl}/functions/v1${path}`);
  url.search = source.search;
  return url.toString();
}

export class TeamApiError extends Error {
  readonly code: TeamErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    code: TeamErrorCode,
    retryable: boolean,
    details?: Record<string, string | number | boolean | null>
  ) {
    super(code);
    this.name = 'TeamApiError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface TeamContextSnapshot {
  id: string;
  name: string;
  role: TeamRole;
  permissions: TeamPermissions;
  connectionState:
    'none' | 'pending' | 'connected' | 'needs_reauth' | 'unavailable' | 'detached' | 'root_missing';
}

export type UnknownGuard<T> = (value: unknown) => value is T;

/**
 * Recovers the team error envelope from a failed `functions.invoke`.
 *
 * Every team function answers a refusal with a real HTTP status (409 for
 * ALREADY_INVITED, 403 for PERMISSION_DENIED, and so on) *and* a structured
 * `{ ok: false, error: { code } }` body. supabase-js treats any non-2xx as a
 * thrown error and hands back `data: null`, so reading only `data` threw the
 * code away and every refusal in the product surfaced as the same generic
 * "Drive unavailable" — the wrong cause, and unactionable. The response itself
 * is still attached to the error and still unread, so parse it.
 */
async function envelopeFromInvokeError(error: unknown): Promise<unknown> {
  const response = (error as { context?: unknown } | null)?.context;
  if (!(response instanceof Response)) return null;
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

export async function invokeTeamFunction<T>(
  functionName: string,
  body: Record<string, unknown>,
  guard: UnknownGuard<T>
): Promise<T> {
  const supabase = requireSupabaseClient();
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  let payload = data;
  if (error && data === null) {
    payload = await envelopeFromInvokeError(error);
    // A transport failure carries no envelope at all; that alone is retryable.
    if (payload === null) throw new TeamApiError('DRIVE_UNAVAILABLE', true);
  }
  const parsed = parseTeamEdgeResult(payload);
  if (!parsed.ok) {
    throw new TeamApiError(parsed.error.code, parsed.error.retryable, parsed.error.details);
  }
  if (!guard(parsed.value)) throw new TeamApiError('INVALID_RESPONSE', false);
  return parsed.value;
}

export function isTeamContextSnapshot(value: unknown): value is TeamContextSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.name !== 'string' ||
    !['owner', 'admin', 'editor', 'viewer'].includes(String(item.role)) ||
    !item.permissions ||
    typeof item.permissions !== 'object' ||
    Array.isArray(item.permissions) ||
    ![
      'none',
      'pending',
      'connected',
      'needs_reauth',
      'unavailable',
      'detached',
      'root_missing'
    ].includes(String(item.connectionState))
  ) {
    return false;
  }
  const permissions = item.permissions as Record<string, unknown>;
  return [
    'view',
    'download',
    'upload',
    'edit',
    'delete',
    'process',
    'manage_members',
    'manage_metadata'
  ].every(permission => typeof permissions[permission] === 'boolean');
}

export function isTeamContextSnapshotList(value: unknown): value is TeamContextSnapshot[] {
  return Array.isArray(value) && value.every(isTeamContextSnapshot);
}

export interface TeamInvitationSummary {
  id: string;
  teamId?: string;
  teamName?: string;
  inviterName?: string;
  targetEmail: string;
  targetUserId?: string | null;
  initialRole: TeamBaseRole;
  state: TeamInvitationState;
  deliveryState: TeamInvitationDeliveryState;
  deliveryErrorCode: TeamErrorCode | null;
  expiresAt: string;
  createdAt?: string;
  lastSentAt?: string;
  /**
   * The acceptance link, returned only by an environment that deliberately does
   * not deliver invitation mail (beta). Production never populates it, so the
   * UI showing it is exactly as safe as the server deciding not to send.
   */
  inviteUrl?: string;
}

export type TeamPermissionOverrides = Partial<Record<TeamPermissionFlag, boolean>>;

export interface TeamMemberSummary {
  membershipId: string;
  userId: string;
  displayName: string | null;
  email: string | null;
  role: TeamRole;
  baseRole: TeamBaseRole;
  permissionOverrides: TeamPermissionOverrides;
  effectivePermissions: TeamPermissions;
  joinedAt: string;
}

export interface TeamAuditEventSummary {
  id: string;
  actorLabel: string | null;
  action: string;
  target: Partial<
    Record<
      | 'member_id'
      | 'invitation_id'
      | 'connection_id'
      | 'material_id'
      | 'operation_id'
      | 'relation'
      | 'role'
      | 'state'
      | 'warning_code',
      string
    >
  >;
  result: 'succeeded' | 'denied' | 'failed' | 'canceled';
  errorCode: TeamErrorCode | null;
  occurredAt: string;
}

export interface DriveConnectionStatus {
  connectionId: string | null;
  state: TeamContextSnapshot['connectionState'];
  rootFolderName: string | null;
  driveKind: 'my_drive' | 'shared_drive' | null;
  initialSyncState: 'not_started' | 'scanning' | 'replaying' | 'ready' | 'failed';
  lastSyncedAt: string | null;
  lastErrorCode: TeamErrorCode | null;
  connectedAccountEmail: string | null;
  capabilitiesCheckedAt: string | null;
}

export interface DriveCatalogResyncResult {
  syncJobId: string;
  initialSyncState: 'scanning';
}

export interface DriveFolderSummary {
  id: string;
  name: string;
  driveKind: 'my_drive' | 'shared_drive';
  resourceKey?: string | null;
}

export interface DriveFolderPage {
  folders: DriveFolderSummary[];
  nextPageToken: string | null;
}

export type DriveRootResult =
  | {
      state: 'confirmation_required';
      folder: DriveFolderSummary;
      account: string;
      independentAclWarning: true;
    }
  | {
      state: 'connected';
      folder: DriveFolderSummary;
      syncState: 'queued' | 'scanning' | 'replaying' | 'ready';
      connectionId?: string;
    };

/** Where a search looks (011): one folder or the whole space, some kinds or all. */
export interface CatalogSearchScope {
  parentFolderId?: string | null;
  kinds?: TeamMaterialRowKind[];
}

export interface TeamMaterialSummary {
  id: string;
  teamId: string;
  providerId?: string;
  parentFolderId?: string | null;
  name: string;
  kind: 'file' | 'folder' | 'shortcut';
  category: MaterialCategory | null;
  mimeType?: string | null;
  fileExtension?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  previewState?: string;
}

/** Content-free indication that older landing candidates belong to a detached root. */
export interface TeamLandingSourceStatus {
  hasDetachedLandingCandidates: boolean;
}

export interface TeamOperationSnapshot {
  id: string;
  teamId: string;
  kind: string;
  state: TeamOperationState;
  stage: string;
  progress: number;
  sourceMaterialId: string | null;
  resultMaterialId: string | null;
  errorCode: TeamErrorCode | null;
  retryable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamUploadStartInput {
  teamId: string;
  /** The folder's provider id, or null for the space root. */
  destinationFolderId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  conflictMode: 'cancel' | 'keep_both' | 'replace';
  replaceMaterialId?: string | null;
  versionOfMaterialId?: string | null;
  idempotencyKey: string;
}

export interface TeamProcessStartInput {
  teamId: string;
  materialId: string;
  toolId: string;
  optionsSummary: Record<string, unknown>;
  destinationFolderId: string;
  outputName: string;
  conflictMode: 'cancel' | 'keep_both';
  idempotencyKey: string;
  agentContractVersion: number;
  toolContractVersion: number;
}

export interface TeamTaskAttachmentMutationResult {
  attached: string[];
  alreadyAttached: string[];
  rejected: Array<{ materialId: string | null; code: 'NOT_FOUND' | 'PERMISSION_DENIED' }>;
}

export interface LibraryRequirementScanResult {
  created: {
    transcription: number;
    translation: number;
    landingOptimization: number;
  };
  missing: {
    transcription: number;
    translation: number;
    landingOptimization: number;
  };
  ready: number;
  started: false;
}

export interface LibraryJobClaimEnvelope {
  teamId: string;
  requirementId: string;
  attemptId: string;
  sourceMaterialId: string;
  sourceVersion: string;
  kind: LibraryJobClaimRequest['supportedKinds'][number];
  variant: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface LibraryProcessingContext {
  sourceMaterialId: string;
  sourceName: string;
  category: 'video' | 'landing' | 'archive';
  destinationFolderId: string;
}

export interface LibraryUploadBatchStartResult {
  batchId: string;
  destinationFolderId: string;
  state: 'running';
  items: Array<{ itemId: string; clientItemKey: string; state: 'pending' }>;
}

export interface LibraryPlacementMutationResult {
  targetStage: 'finds' | 'library';
  succeeded: Array<{ materialId: string; reused: boolean }>;
  failed: Array<{ materialId: string; errorCode: TeamErrorCode; retryable: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorCode(value: unknown): TeamErrorCode | null {
  return typeof value === 'string' && (TEAM_ERROR_CODES as readonly string[]).includes(value)
    ? (value as TeamErrorCode)
    : null;
}

function mapTeamContext(value: unknown): TeamContextSnapshot | null {
  const row = asRecord(value);
  if (!row) return null;
  const mapped = {
    id: row.id,
    name: row.name,
    role: row.role,
    permissions: row.permissions,
    connectionState: row.connection_state ?? row.connectionState
  };
  return isTeamContextSnapshot(mapped) ? mapped : null;
}

function mapInvitation(value: unknown): TeamInvitationSummary | null {
  const row = asRecord(value);
  if (!row) return null;
  const initialRole = row.initial_role ?? row.initialRole;
  const state = row.state;
  const deliveryState = row.delivery_state ?? row.deliveryState;
  const id = row.id ?? row.invitationId;
  const targetEmail = row.target_email ?? row.targetEmail;
  const expiresAt = row.expires_at ?? row.expiresAt;
  if (
    typeof id !== 'string' ||
    typeof targetEmail !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof initialRole !== 'string' ||
    !(TEAM_BASE_ROLES as readonly string[]).includes(initialRole) ||
    typeof state !== 'string' ||
    !(TEAM_INVITATION_STATES as readonly string[]).includes(state) ||
    typeof deliveryState !== 'string' ||
    !(TEAM_INVITATION_DELIVERY_STATES as readonly string[]).includes(deliveryState)
  ) {
    return null;
  }
  return {
    id,
    ...(typeof (row.team_id ?? row.teamId) === 'string'
      ? { teamId: (row.team_id ?? row.teamId) as string }
      : {}),
    ...(typeof (row.team_name ?? row.teamName) === 'string'
      ? { teamName: (row.team_name ?? row.teamName) as string }
      : {}),
    ...(typeof (row.inviter_name ?? row.inviterName) === 'string'
      ? { inviterName: (row.inviter_name ?? row.inviterName) as string }
      : {}),
    targetEmail,
    targetUserId:
      typeof (row.target_user_id ?? row.targetUserId) === 'string'
        ? ((row.target_user_id ?? row.targetUserId) as string)
        : null,
    initialRole: initialRole as TeamBaseRole,
    state: state as TeamInvitationState,
    deliveryState: deliveryState as TeamInvitationDeliveryState,
    deliveryErrorCode: errorCode(row.delivery_error_code ?? row.deliveryErrorCode),
    expiresAt,
    ...(typeof (row.created_at ?? row.createdAt) === 'string'
      ? { createdAt: (row.created_at ?? row.createdAt) as string }
      : {}),
    ...(typeof (row.last_sent_at ?? row.lastSentAt) === 'string'
      ? { lastSentAt: (row.last_sent_at ?? row.lastSentAt) as string }
      : {}),
    ...(typeof (row.invite_url ?? row.inviteUrl) === 'string'
      ? { inviteUrl: (row.invite_url ?? row.inviteUrl) as string }
      : {})
  };
}

function invitationGuard(value: unknown): value is TeamInvitationSummary {
  return mapInvitation(value) !== null;
}

function teamPermissions(value: unknown): TeamPermissions | null {
  const row = asRecord(value);
  if (!row || !TEAM_PERMISSION_FLAGS.every(flag => typeof row[flag] === 'boolean')) return null;
  return Object.fromEntries(
    TEAM_PERMISSION_FLAGS.map(flag => [flag, row[flag] as boolean])
  ) as TeamPermissions;
}

function permissionOverrides(value: unknown): TeamPermissionOverrides | null {
  const row = asRecord(value);
  if (!row) return null;
  const entries = Object.entries(row);
  if (
    entries.some(
      ([key, allowed]) =>
        !(TEAM_PERMISSION_FLAGS as readonly string[]).includes(key) || typeof allowed !== 'boolean'
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries) as TeamPermissionOverrides;
}

function mapMember(value: unknown): TeamMemberSummary | null {
  const row = asRecord(value);
  if (!row) return null;
  const role = row.role;
  const baseRole = row.base_role ?? row.baseRole;
  const effective = teamPermissions(row.effective_permissions ?? row.effectivePermissions);
  const overrides = permissionOverrides(row.permission_overrides ?? row.permissionOverrides);
  if (
    typeof (row.membership_id ?? row.membershipId) !== 'string' ||
    typeof (row.user_id ?? row.userId) !== 'string' ||
    typeof role !== 'string' ||
    !['owner', 'admin', 'editor', 'viewer'].includes(role) ||
    typeof baseRole !== 'string' ||
    !(TEAM_BASE_ROLES as readonly string[]).includes(baseRole) ||
    typeof (row.joined_at ?? row.joinedAt) !== 'string' ||
    !effective ||
    !overrides
  ) {
    return null;
  }
  return {
    membershipId: (row.membership_id ?? row.membershipId) as string,
    userId: (row.user_id ?? row.userId) as string,
    displayName:
      typeof (row.display_name ?? row.displayName) === 'string'
        ? ((row.display_name ?? row.displayName) as string)
        : null,
    email: typeof row.email === 'string' ? row.email : null,
    role: role as TeamRole,
    baseRole: baseRole as TeamBaseRole,
    permissionOverrides: overrides,
    effectivePermissions: effective,
    joinedAt: (row.joined_at ?? row.joinedAt) as string
  };
}

function memberRpcResultGuard(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length === 1 && mapMember(value[0]) !== null;
}

/**
 * Mirrors `private.record_team_audit`'s own key whitelist
 * (`20260823120000_team_ux_lifecycle.sql`). The two lists have to be read as
 * one: the server refuses to write a key that is not here, and an unknown key
 * arriving here fails `mapAuditEvent`, which fails the *whole* history rather
 * than the one row. Widening the server list without widening this one is how
 * a single `task.deleted` event took the entire space history down.
 */
const AUDIT_TARGET_KEYS = new Set([
  'member_id',
  'invitation_id',
  'connection_id',
  'material_id',
  'operation_id',
  'relation',
  'role',
  'state',
  'warning_code',
  'task_id',
  'task_title'
]);

function mapAuditEvent(value: unknown): TeamAuditEventSummary | null {
  const row = asRecord(value);
  const target = asRecord(row?.target);
  const result = row?.result;
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.action !== 'string' ||
    !target ||
    Object.entries(target).some(
      ([key, entry]) => !AUDIT_TARGET_KEYS.has(key) || typeof entry !== 'string'
    ) ||
    !['succeeded', 'denied', 'failed', 'canceled'].includes(String(result)) ||
    typeof row.occurred_at !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    actorLabel: typeof row.actor_label === 'string' ? row.actor_label : null,
    action: row.action,
    target: target as TeamAuditEventSummary['target'],
    result: result as TeamAuditEventSummary['result'],
    errorCode: errorCode(row.error_code),
    occurredAt: row.occurred_at
  };
}

function driveFolder(value: unknown): DriveFolderSummary | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    !['my_drive', 'shared_drive'].includes(String(row.driveKind ?? row.drive_kind))
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    driveKind: (row.driveKind ?? row.drive_kind) as 'my_drive' | 'shared_drive',
    resourceKey:
      typeof (row.resourceKey ?? row.resource_key) === 'string'
        ? ((row.resourceKey ?? row.resource_key) as string)
        : null
  };
}

function driveFolderPageGuard(value: unknown): value is DriveFolderPage {
  const row = asRecord(value);
  return Boolean(
    row &&
    Array.isArray(row.folders) &&
    row.folders.every(folder => driveFolder(folder) !== null) &&
    (row.nextPageToken === null || typeof row.nextPageToken === 'string')
  );
}

function driveRootResultGuard(value: unknown): value is DriveRootResult {
  const row = asRecord(value);
  if (!row || !['confirmation_required', 'connected'].includes(String(row.state))) return false;
  const folder = driveFolder(row.folder);
  if (!folder) return false;
  return row.state === 'confirmation_required'
    ? typeof row.account === 'string' && row.independentAclWarning === true
    : typeof row.syncState === 'string';
}

function teamMaterial(value: unknown): TeamMaterialSummary | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof (row.team_id ?? row.teamId) !== 'string' ||
    typeof row.name !== 'string' ||
    !['file', 'folder', 'shortcut'].includes(String(row.kind))
  ) {
    return null;
  }
  const category = row.category;
  if (
    category !== null &&
    category !== undefined &&
    !(MATERIAL_CATEGORIES as readonly string[]).includes(String(category))
  ) {
    return null;
  }
  return {
    id: row.id,
    teamId: (row.team_id ?? row.teamId) as string,
    providerId:
      typeof (row.drive_file_id ?? row.providerId) === 'string'
        ? ((row.drive_file_id ?? row.providerId) as string)
        : row.id,
    parentFolderId:
      typeof (row.parent_folder_id ?? row.parentFolderId) === 'string'
        ? ((row.parent_folder_id ?? row.parentFolderId) as string)
        : null,
    name: row.name,
    kind: row.kind as TeamMaterialSummary['kind'],
    category: (category ?? null) as MaterialCategory | null,
    mimeType:
      typeof (row.mime_type ?? row.mimeType) === 'string'
        ? ((row.mime_type ?? row.mimeType) as string)
        : null,
    fileExtension:
      typeof (row.file_extension ?? row.fileExtension) === 'string'
        ? ((row.file_extension ?? row.fileExtension) as string)
        : null,
    sizeBytes:
      typeof (row.size_bytes ?? row.sizeBytes) === 'number'
        ? ((row.size_bytes ?? row.sizeBytes) as number)
        : null,
    modifiedAt:
      typeof (row.modified_at ?? row.modifiedAt) === 'string'
        ? ((row.modified_at ?? row.modifiedAt) as string)
        : null,
    previewState:
      typeof (row.preview_state ?? row.previewState) === 'string'
        ? ((row.preview_state ?? row.previewState) as string)
        : undefined
  };
}

function teamLandingSourceStatus(value: unknown): TeamLandingSourceStatus | null {
  const row = asRecord(value);
  return row && typeof row.has_detached_landing_candidates === 'boolean'
    ? { hasDetachedLandingCandidates: row.has_detached_landing_candidates }
    : null;
}

/** snake_case tree row → the shared node shape; the guard decides if it is whole. */
function folderNode(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return null;
  return {
    id: record.id,
    driveFileId: record.drive_file_id,
    parentFolderId: record.parent_folder_id ?? null,
    selectionId: record.selection_id ?? null,
    name: record.name,
    indexedAt: record.indexed_at ?? null,
    childFolderCount: record.child_folder_count,
    childFileCount: record.child_file_count,
    thumbnailReadyCount: record.thumbnail_ready_count
  };
}

function driveSelection(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return null;
  return {
    id: record.id,
    driveFolderId: record.drive_folder_id,
    name: record.name,
    isRoot: record.is_root,
    state: record.state
  };
}

function throwRpc(error: { message: string; code?: string } | null): void {
  if (!error) return;
  const candidates = [error.message, error.code ?? ''].flatMap(
    value => value.match(/[A-Z][A-Z0-9_]+/g) ?? []
  );
  const code = candidates[0] as TeamErrorCode | undefined;
  throw new TeamApiError(code ?? 'INVALID_RESPONSE', false);
}

function uploadSessionGuard(value: unknown): value is TeamUploadSession {
  return parseTeamUploadSession(value) !== null;
}

function fileOperationGuard(value: unknown): value is TeamFileOperationResult {
  return parseTeamFileOperationResult(value) !== null;
}

function downloadGrantGuard(value: unknown): value is TeamDownloadGrantResult {
  return parseTeamDownloadGrantResult(value) !== null;
}

function processStartGuard(value: unknown): value is TeamProcessStartResult {
  return parseTeamProcessStartResult(value) !== null;
}

function landingRenderJobGuard(value: unknown): value is TeamLandingRenderJob {
  const row = asRecord(value);
  const sourceGrant = parseTeamTransferGrant(row?.sourceGrant);
  const artifactGrant = parseTeamTransferGrant(row?.artifactGrant);
  return Boolean(
    row &&
    [
      'operationId',
      'renderId',
      'teamId',
      'materialId',
      'preset',
      'transferUrl',
      'artifactUploadUrl'
    ].every(key => typeof row[key] === 'string') &&
    sourceGrant?.purpose === 'preview_range' &&
    artifactGrant?.purpose === 'preview_range'
  );
}

function renderArtifact(value: unknown): RenderArtifactRef | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.materialId !== 'string' ||
    typeof row.sourceVersion !== 'string' ||
    typeof row.fingerprint !== 'string' ||
    typeof row.preset !== 'string' ||
    typeof row.segmentCount !== 'number' ||
    !Number.isInteger(row.segmentCount) ||
    row.segmentCount < 1 ||
    typeof row.artifactToken !== 'string' ||
    row.artifactToken.length < 16
  ) {
    return null;
  }
  if (
    row.segmentTokens !== undefined &&
    (!Array.isArray(row.segmentTokens) ||
      row.segmentTokens.length !== row.segmentCount ||
      row.segmentTokens.some(token => typeof token !== 'string' || token.length < 16))
  ) {
    return null;
  }
  return {
    materialId: row.materialId,
    sourceVersion: row.sourceVersion,
    fingerprint: row.fingerprint,
    preset: row.preset,
    segmentCount: row.segmentCount,
    artifactToken: row.artifactToken,
    ...(Array.isArray(row.segmentTokens) ? { segmentTokens: row.segmentTokens as string[] } : {})
  };
}

function renderArtifactsGuard(value: unknown): value is { artifacts: RenderArtifactRef[] } {
  const row = asRecord(value);
  return Boolean(
    row &&
    Array.isArray(row.artifacts) &&
    row.artifacts.every(item => renderArtifact(item) !== null)
  );
}

function mapOperation(value: unknown): TeamOperationSnapshot | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.team_id !== 'string' ||
    typeof row.kind !== 'string' ||
    !['pending', 'running', 'succeeded', 'failed', 'canceled'].includes(String(row.state)) ||
    typeof row.stage !== 'string' ||
    typeof row.progress !== 'number' ||
    row.progress < 0 ||
    row.progress > 100 ||
    typeof row.retryable !== 'boolean' ||
    typeof row.created_at !== 'string' ||
    typeof row.updated_at !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    teamId: row.team_id,
    kind: row.kind,
    state: row.state as TeamOperationState,
    stage: row.stage,
    progress: row.progress,
    sourceMaterialId: typeof row.source_material_id === 'string' ? row.source_material_id : null,
    resultMaterialId: typeof row.result_material_id === 'string' ? row.result_material_id : null,
    errorCode: errorCode(row.error_code),
    retryable: row.retryable,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * One row of the trash view. Local to the web client rather than in the shared
 * contract package: nothing outside this UI reads it, and `parent_path_hint` is
 * a presentation aid (the folder a file was in) rather than a protocol fact.
 */
export interface TeamTrashedMaterial {
  id: string;
  name: string;
  kind: MaterialKind;
  trashedAt: string;
  /** Name of the folder the material sat in, or null when it can no longer be resolved. */
  parentPathHint: string | null;
}

function isMaterialKind(value: unknown): value is MaterialKind {
  return value === 'file' || value === 'folder' || value === 'shortcut';
}

function mapTrashedMaterial(value: unknown): TeamTrashedMaterial | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    !isMaterialKind(row.kind) ||
    typeof row.trashed_at !== 'string' ||
    (row.parent_path_hint !== null && typeof row.parent_path_hint !== 'string')
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    trashedAt: row.trashed_at,
    parentPathHint: row.parent_path_hint
  };
}

function mapTeamTask(value: unknown): TeamTaskSummary | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.team_id !== 'string' ||
    typeof row.created_by !== 'string' ||
    typeof row.title !== 'string' ||
    (row.note !== null && typeof row.note !== 'string') ||
    (row.assignee_id !== null && typeof row.assignee_id !== 'string') ||
    (row.assignee_label_snapshot !== null && typeof row.assignee_label_snapshot !== 'string') ||
    !['todo', 'in_progress', 'done'].includes(String(row.status)) ||
    typeof row.progress_max !== 'number' ||
    !Number.isInteger(row.progress_max) ||
    typeof row.progress_value !== 'number' ||
    !Number.isInteger(row.progress_value) ||
    typeof row.progress_manually_set !== 'boolean' ||
    typeof row.created_at !== 'string' ||
    typeof row.updated_at !== 'string' ||
    (row.completed_at !== null && typeof row.completed_at !== 'string')
  ) {
    return null;
  }
  const attachmentCount = row.attachment_count ?? 0;
  if (typeof attachmentCount !== 'number' || !Number.isSafeInteger(attachmentCount)) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    createdBy: row.created_by,
    title: row.title,
    note: row.note,
    assigneeId: row.assignee_id,
    assigneeLabelSnapshot: row.assignee_label_snapshot,
    status: row.status as TeamTaskSummary['status'],
    progressMax: row.progress_max,
    progressValue: row.progress_value,
    progressManuallySet: row.progress_manually_set,
    attachmentCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function taskAttachmentMutationResult(value: unknown): TeamTaskAttachmentMutationResult | null {
  const row = asRecord(value);
  if (
    !row ||
    !Array.isArray(row.attached) ||
    !Array.isArray(row.alreadyAttached) ||
    !Array.isArray(row.rejected)
  ) {
    return null;
  }
  if (
    !row.attached.every(item => typeof item === 'string') ||
    !row.alreadyAttached.every(item => typeof item === 'string')
  ) {
    return null;
  }
  const rejected: TeamTaskAttachmentMutationResult['rejected'] = [];
  for (const item of row.rejected) {
    const rejection = asRecord(item);
    if (
      !rejection ||
      (rejection.materialId !== null && typeof rejection.materialId !== 'string') ||
      !['NOT_FOUND', 'PERMISSION_DENIED'].includes(String(rejection.code))
    ) {
      return null;
    }
    rejected.push({
      materialId: rejection.materialId as string | null,
      code: rejection.code as 'NOT_FOUND' | 'PERMISSION_DENIED'
    });
  }
  return {
    attached: row.attached as string[],
    alreadyAttached: row.alreadyAttached as string[],
    rejected
  };
}

function libraryScanResult(value: unknown): LibraryRequirementScanResult | null {
  const row = asRecord(value);
  const created = asRecord(row?.created);
  const missing = asRecord(row?.missing);
  if (!row || !created || !missing || row.started !== false) return null;
  const counts = [
    created.transcription,
    created.translation,
    created.landingOptimization,
    missing.transcription,
    missing.translation,
    missing.landingOptimization,
    row.ready
  ];
  if (
    counts.some(count => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
  ) {
    return null;
  }
  return {
    created: {
      transcription: created.transcription as number,
      translation: created.translation as number,
      landingOptimization: created.landingOptimization as number
    },
    missing: {
      transcription: missing.transcription as number,
      translation: missing.translation as number,
      landingOptimization: missing.landingOptimization as number
    },
    ready: row.ready as number,
    started: false
  };
}

function libraryJobClaimEnvelope(value: unknown): LibraryJobClaimEnvelope | null {
  const row = asRecord(value);
  if (
    !row ||
    ![
      'teamId',
      'requirementId',
      'attemptId',
      'sourceMaterialId',
      'sourceVersion',
      'kind',
      'variant',
      'leaseToken',
      'leaseExpiresAt'
    ].every(key => typeof row[key] === 'string') ||
    !['transcription', 'translation', 'landing_optimization'].includes(String(row.kind)) ||
    !Number.isFinite(Date.parse(row.leaseExpiresAt as string))
  ) {
    return null;
  }
  return row as unknown as LibraryJobClaimEnvelope;
}

function libraryUploadBatchStartResult(value: unknown): LibraryUploadBatchStartResult | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.batchId !== 'string' ||
    typeof row.destinationFolderId !== 'string' ||
    row.state !== 'running' ||
    !Array.isArray(row.items)
  ) {
    return null;
  }
  const items: LibraryUploadBatchStartResult['items'] = [];
  for (const value of row.items) {
    const item = asRecord(value);
    if (
      !item ||
      typeof item.itemId !== 'string' ||
      typeof item.clientItemKey !== 'string' ||
      item.state !== 'pending'
    ) {
      return null;
    }
    items.push({ itemId: item.itemId, clientItemKey: item.clientItemKey, state: 'pending' });
  }
  return {
    batchId: row.batchId,
    destinationFolderId: row.destinationFolderId,
    state: 'running',
    items
  };
}

function libraryPlacementMutationResult(value: unknown): LibraryPlacementMutationResult | null {
  const row = asRecord(value);
  if (!row || !['finds', 'library'].includes(String(row.targetStage))) return null;
  if (!Array.isArray(row.succeeded) || !Array.isArray(row.failed)) return null;
  const succeeded: LibraryPlacementMutationResult['succeeded'] = [];
  const failed: LibraryPlacementMutationResult['failed'] = [];
  for (const candidate of row.succeeded) {
    const item = asRecord(candidate);
    if (!item || typeof item.materialId !== 'string' || typeof item.reused !== 'boolean') {
      return null;
    }
    succeeded.push({ materialId: item.materialId, reused: item.reused });
  }
  for (const candidate of row.failed) {
    const item = asRecord(candidate);
    const code = errorCode(item?.errorCode);
    if (
      !item ||
      typeof item.materialId !== 'string' ||
      !code ||
      typeof item.retryable !== 'boolean'
    ) {
      return null;
    }
    failed.push({ materialId: item.materialId, errorCode: code, retryable: item.retryable });
  }
  return {
    targetStage: row.targetStage as LibraryPlacementMutationResult['targetStage'],
    succeeded,
    failed
  };
}

function mapProvenance(value: unknown): TeamMaterialProvenanceEntry | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.link_id !== 'string' ||
    !['processed_from', 'version_of'].includes(String(row.relation)) ||
    typeof row.source_material_id !== 'string' ||
    typeof row.derivative_material_id !== 'string' ||
    typeof row.source_name_snapshot !== 'string' ||
    typeof row.source_name !== 'string' ||
    !['active', 'trashed', 'missing'].includes(String(row.source_lifecycle)) ||
    typeof row.derivative_name !== 'string' ||
    !['active', 'trashed', 'missing'].includes(String(row.derivative_lifecycle)) ||
    typeof row.created_at !== 'string'
  ) {
    return null;
  }
  const version = row.tool_contract_version;
  if (version !== null && (typeof version !== 'number' || !Number.isInteger(version))) return null;
  return {
    linkId: row.link_id,
    relation: row.relation as TeamMaterialProvenanceEntry['relation'],
    sourceMaterialId: row.source_material_id,
    derivativeMaterialId: row.derivative_material_id,
    sourceNameSnapshot: row.source_name_snapshot,
    sourceName: row.source_name,
    sourceLifecycle: row.source_lifecycle as TeamMaterialProvenanceEntry['sourceLifecycle'],
    derivativeName: row.derivative_name,
    derivativeLifecycle:
      row.derivative_lifecycle as TeamMaterialProvenanceEntry['derivativeLifecycle'],
    toolId: typeof row.tool_id === 'string' ? row.tool_id : null,
    toolContractVersion: version as number | null,
    createdAt: row.created_at
  };
}

export const teamApi = {
  async listTeams(): Promise<TeamContextSnapshot[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_my_teams');
    throwRpc(error);
    const teams = (data ?? []).map(mapTeamContext);
    if (teams.some(team => team === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    return teams.filter((team): team is TeamContextSnapshot => team !== null);
  },

  async createTeam(name: string): Promise<TeamContextSnapshot> {
    const { data, error } = await requireSupabaseClient().rpc('create_team', { p_name: name });
    throwRpc(error);
    const team = mapTeamContext(data?.[0]);
    if (!team) throw new TeamApiError('INVALID_RESPONSE', false);
    return team;
  },

  async listMembers(teamId: string): Promise<TeamMemberSummary[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_members', {
      p_team: teamId
    });
    throwRpc(error);
    const members = (data ?? []).map(mapMember);
    if (members.some(member => member === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return members.filter((member): member is TeamMemberSummary => member !== null);
  },

  async updateMembership(input: {
    teamId: string;
    userId: string;
    baseRole: TeamBaseRole;
    permissionOverrides: TeamPermissionOverrides;
  }): Promise<TeamMemberSummary> {
    const { data, error } = await requireSupabaseClient().rpc('update_membership', {
      p_team: input.teamId,
      p_member: input.userId,
      p_base_role: input.baseRole,
      p_overrides: input.permissionOverrides
    });
    throwRpc(error);
    const member = mapMember(data?.[0]);
    if (!member) throw new TeamApiError('INVALID_RESPONSE', false);
    return member;
  },

  async removeMember(
    teamId: string,
    userId: string
  ): Promise<{ ok: true; warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }> {
    const { data, error } = await requireSupabaseClient().rpc('remove_member', {
      p_team: teamId,
      p_member: userId
    });
    throwRpc(error);
    const row = data?.[0];
    if (!row?.ok || row.warning_code !== 'EXTERNAL_DRIVE_ACCESS_REMAINS') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { ok: true, warningCode: row.warning_code };
  },

  async transferOwnership(input: {
    teamId: string;
    toUserId: string;
    demoteTo: TeamBaseRole;
  }): Promise<TeamContextSnapshot> {
    const { data, error } = await requireSupabaseClient().rpc('transfer_ownership', {
      p_team: input.teamId,
      p_to_user: input.toUserId,
      p_demote_to: input.demoteTo
    });
    throwRpc(error);
    const team = mapTeamContext(data?.[0]);
    if (!team) throw new TeamApiError('INVALID_RESPONSE', false);
    return team;
  },

  async listAuditEvents(
    teamId: string,
    options: { limit?: number; before?: string } = {}
  ): Promise<TeamAuditEventSummary[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_audit_events', {
      p_team: teamId,
      p_limit: options.limit ?? 50,
      ...(options.before ? { p_before: options.before } : {})
    });
    throwRpc(error);
    const events = (data ?? []).map(mapAuditEvent);
    if (events.some(event => event === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return events.filter((event): event is TeamAuditEventSummary => event !== null);
  },

  async listInvitations(teamId: string): Promise<TeamInvitationSummary[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_invitations', {
      p_team: teamId
    });
    throwRpc(error);
    const invitations = (data ?? []).map(mapInvitation);
    if (invitations.some(invitation => invitation === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return invitations.filter((item): item is TeamInvitationSummary => item !== null);
  },
  async listMyInvitations(): Promise<TeamInvitationSummary[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_my_invitations');
    throwRpc(error);
    const invitations = (data ?? []).map(mapInvitation);
    if (invitations.some(invitation => invitation === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return invitations.filter((item): item is TeamInvitationSummary => item !== null);
  },

  async createInvitation(input: {
    teamId: string;
    email: string;
    initialRole?: TeamBaseRole;
  }): Promise<TeamInvitationSummary> {
    const value = await invokeTeamFunction(
      'team-invitations',
      {
        action: 'create',
        teamId: input.teamId,
        email: input.email,
        initialRole: input.initialRole ?? 'viewer',
        idempotencyKey: crypto.randomUUID()
      },
      invitationGuard
    );
    const invitation = mapInvitation(value);
    if (!invitation) throw new TeamApiError('INVALID_RESPONSE', false);
    return invitation;
  },

  async directAddMember(input: {
    teamId: string;
    email: string;
    initialRole?: TeamBaseRole;
  }): Promise<TeamMemberSummary> {
    const value = await invokeTeamFunction(
      'team-invitations',
      {
        action: 'direct-add',
        teamId: input.teamId,
        email: input.email,
        initialRole: input.initialRole ?? 'viewer'
      },
      memberRpcResultGuard
    );
    const member = mapMember(value[0]);
    if (!member) throw new TeamApiError('INVALID_RESPONSE', false);
    return member;
  },

  async resendInvitation(invitationId: string): Promise<TeamInvitationSummary> {
    const value = await invokeTeamFunction(
      'team-invitations',
      { action: 'resend', invitationId },
      invitationGuard
    );
    const invitation = mapInvitation(value);
    if (!invitation) throw new TeamApiError('INVALID_RESPONSE', false);
    return invitation;
  },

  async revokeInvitation(invitationId: string): Promise<void> {
    await invokeTeamFunction(
      'team-invitations',
      { action: 'revoke', invitationId },
      (value): value is boolean => value === true
    );
  },

  async acceptInvitation(invitationId: string, token?: string): Promise<TeamContextSnapshot> {
    const { data, error } = await requireSupabaseClient().rpc('accept_invitation', {
      p_invitation: invitationId,
      ...(token ? { p_plain_token: token } : {})
    });
    throwRpc(error);
    const team = mapTeamContext(data?.[0]);
    if (!team) throw new TeamApiError('INVALID_RESPONSE', false);
    return team;
  },

  async declineInvitation(invitationId: string, token?: string): Promise<void> {
    const { error } = await requireSupabaseClient().rpc('decline_invitation', {
      p_invitation: invitationId,
      ...(token ? { p_plain_token: token } : {})
    });
    throwRpc(error);
  },

  async getConnectionStatus(teamId: string): Promise<DriveConnectionStatus> {
    const { data, error } = await requireSupabaseClient().rpc('get_drive_connection_status', {
      p_team: teamId
    });
    throwRpc(error);
    const row = data?.[0] as Record<string, unknown> | undefined;
    if (!row || typeof row.state !== 'string') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return {
      connectionId: typeof row.connection_id === 'string' ? row.connection_id : null,
      state: row.state as DriveConnectionStatus['state'],
      rootFolderName: typeof row.root_folder_name === 'string' ? row.root_folder_name : null,
      driveKind:
        row.drive_kind === 'my_drive' || row.drive_kind === 'shared_drive' ? row.drive_kind : null,
      initialSyncState: (row.initial_sync_state ??
        'not_started') as DriveConnectionStatus['initialSyncState'],
      lastSyncedAt: typeof row.last_synced_at === 'string' ? row.last_synced_at : null,
      lastErrorCode: errorCode(row.last_error_code),
      connectedAccountEmail:
        typeof row.connected_account_email === 'string' ? row.connected_account_email : null,
      capabilitiesCheckedAt:
        typeof row.capabilities_checked_at === 'string' ? row.capabilities_checked_at : null
    };
  },

  async resyncDrive(teamId: string): Promise<DriveCatalogResyncResult> {
    const { data, error } = await requireSupabaseClient().rpc('request_team_catalog_resync', {
      p_team: teamId
    });
    throwRpc(error);
    const row = data?.[0] as Record<string, unknown> | undefined;
    if (typeof row?.sync_job_id !== 'string' || row.initial_sync_state !== 'scanning') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { syncJobId: row.sync_job_id, initialSyncState: 'scanning' };
  },

  async startDriveOAuth(teamId: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
    return invokeTeamFunction(
      'drive-connect',
      { action: 'start', teamId },
      (value): value is { authorizationUrl: string; expiresAt: string } => {
        const row = asRecord(value);
        return Boolean(
          row && typeof row.authorizationUrl === 'string' && typeof row.expiresAt === 'string'
        );
      }
    );
  },

  async listFolders(
    teamId: string,
    parentId = 'root',
    pageToken?: string | null
  ): Promise<DriveFolderPage> {
    const value = await invokeTeamFunction(
      'drive-connect',
      { action: 'folders', teamId, parentId, pageToken: pageToken ?? null },
      driveFolderPageGuard
    );
    return {
      folders: value.folders.map(folder => driveFolder(folder) as DriveFolderSummary),
      nextPageToken: value.nextPageToken
    };
  },

  async confirmDriveRoot(input: {
    teamId: string;
    folderId: string;
    resourceKey?: string | null;
    expectedAccount?: string;
    confirmed: boolean;
  }): Promise<DriveRootResult> {
    return invokeTeamFunction(
      'drive-connect',
      { action: 'confirm', ...input },
      driveRootResultGuard
    );
  },

  async replaceDriveRoot(input: {
    teamId: string;
    folderId: string;
    folderName?: string;
    driveKind?: 'my_drive' | 'shared_drive';
    resourceKey?: string | null;
    expectedAccount?: string;
  }): Promise<DriveRootResult> {
    const value = await invokeTeamFunction(
      'drive-connect',
      {
        action: 'replace',
        ...input,
        confirmed: true,
        idempotencyKey: crypto.randomUUID()
      },
      (result): result is Record<string, unknown> => asRecord(result)?.state === 'connected'
    );
    return {
      state: 'connected',
      folder: {
        id: input.folderId,
        name: input.folderName ?? input.folderId,
        driveKind: input.driveKind ?? 'my_drive',
        resourceKey: input.resourceKey
      },
      syncState:
        value.initial_sync_state === 'ready' || value.initial_sync_state === 'replaying'
          ? value.initial_sync_state
          : 'queued',
      connectionId: typeof value.connection_id === 'string' ? value.connection_id : undefined
    };
  },

  async detachDrive(teamId: string, connectionId: string): Promise<void> {
    await invokeTeamFunction(
      'drive-connect',
      {
        action: 'detach',
        teamId,
        connectionId,
        confirmed: true,
        idempotencyKey: crypto.randomUUID()
      },
      (value): value is { state: 'detached' } => asRecord(value)?.state === 'detached'
    );
  },

  // ---------------------------------------------------------------------
  // Feature 011 — the explorer's reads and the storage selections.
  // Rows cross as `unknown` and are narrowed by the shared guards; a row
  // the interface could not render is refused here, not painted blank.
  // ---------------------------------------------------------------------

  async listFolderTree(teamId: string): Promise<TeamFolderNode[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_folder_tree', {
      p_team: teamId
    });
    throwRpc(error);
    const nodes = (data ?? []).map(folderNode);
    if (!nodes.every(isTeamFolderNode)) throw new TeamApiError('INVALID_RESPONSE', false);
    return nodes;
  },

  async listFolderPage(
    teamId: string,
    input: {
      parentFolderId: string | null;
      kinds?: TeamMaterialRowKind[];
      after?: FolderPageCursor | null;
      limit?: number;
    }
  ): Promise<FolderPage> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_folder_page', {
      p_team: teamId,
      ...(input.parentFolderId ? { p_parent_folder_id: input.parentFolderId } : {}),
      ...(input.kinds && input.kinds.length > 0 ? { p_kind: input.kinds } : {}),
      ...(input.after ? { p_after_sort_key: input.after.sortKey, p_after_id: input.after.id } : {}),
      p_limit: input.limit ?? 100
    });
    throwRpc(error);
    if (!isFolderPage(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async listDriveSelections(teamId: string): Promise<TeamDriveSelection[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_drive_selections', {
      p_team: teamId
    });
    throwRpc(error);
    const selections = (data ?? []).map(driveSelection);
    if (!selections.every(isTeamDriveSelection)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return selections;
  },

  async addDriveSelection(
    teamId: string,
    input: { driveFolderId: string; resourceKey: string | null; name: string }
  ): Promise<TeamDriveSelection> {
    // Through the function, not the RPC: the provider proves the folder lives
    // in the connected drive before the caller's own JWT writes the row.
    const value = await invokeTeamFunction(
      'drive-connect',
      {
        action: 'add_selection',
        teamId,
        folderId: input.driveFolderId,
        resourceKey: input.resourceKey,
        name: input.name
      },
      (result): result is Record<string, unknown> => asRecord(result) !== null
    );
    const selection = driveSelection(value);
    if (!isTeamDriveSelection(selection)) throw new TeamApiError('INVALID_RESPONSE', false);
    return selection;
  },

  async pickerToken(teamId: string): Promise<{ accessToken: string; expiresAt: string }> {
    return invokeTeamFunction(
      'drive-connect',
      { action: 'picker_token', teamId },
      (value): value is { accessToken: string; expiresAt: string } => {
        const row = asRecord(value);
        return Boolean(
          row && typeof row.accessToken === 'string' && typeof row.expiresAt === 'string'
        );
      }
    );
  },

  async chooseRoot(input: {
    teamId: string;
    folderId: string;
    resourceKey?: string | null;
    name?: string;
  }): Promise<DriveRootResult> {
    return invokeTeamFunction(
      'drive-connect',
      {
        action: 'choose_root',
        teamId: input.teamId,
        folderId: input.folderId,
        ...(input.resourceKey ? { resourceKey: input.resourceKey } : {})
      },
      driveRootResultGuard
    );
  },

  async restoreRoot(teamId: string): Promise<DriveRootResult> {
    return invokeTeamFunction(
      'drive-connect',
      { action: 'restore_root', teamId },
      driveRootResultGuard
    );
  },

  async removeDriveSelection(teamId: string, selectionId: string): Promise<void> {
    const { error } = await requireSupabaseClient().rpc('remove_team_drive_selection', {
      p_team: teamId,
      p_selection: selectionId
    });
    throwRpc(error);
  },

  async getStorageHealth(teamId: string): Promise<StorageHealth> {
    const { data, error } = await requireSupabaseClient().rpc('get_team_storage_health', {
      p_team: teamId
    });
    throwRpc(error);
    if (!isStorageHealth(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async mintThumbnailSession(teamId: string): Promise<ThumbnailSession> {
    return invokeTeamFunction(
      'drive-transfer',
      { action: 'thumbnail_session', teamId },
      (value): value is ThumbnailSession => isThumbnailSession(value)
    );
  },

  thumbnailUrl(session: ThumbnailSession, materialId: string): string {
    const url = new URL(browserFunctionUrl(session.endpoint));
    url.searchParams.set('material', materialId);
    url.searchParams.set('session', session.token);
    return url.toString();
  },

  async listMaterials(
    teamId: string,
    parentFolderId: string | null
  ): Promise<TeamMaterialSummary[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_materials', {
      p_team: teamId,
      ...(parentFolderId ? { p_parent_folder_id: parentFolderId } : {})
    });
    throwRpc(error);
    const materials = (data ?? []).map(teamMaterial);
    if (materials.some(material => material === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return materials.filter((item): item is TeamMaterialSummary => item !== null);
  },

  async searchCatalog(
    teamId: string,
    request: CatalogSearchRequestInput,
    scope?: CatalogSearchScope
  ): Promise<CatalogSearchResponse> {
    const normalized = normalizeCatalogSearchRequest(request);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await requireSupabaseClient().rpc('search_materials', {
      p_team: teamId,
      p_query: normalized.query || undefined,
      p_filters: normalized.filters as unknown as Json,
      p_page: normalized.page,
      p_page_size: normalized.pageSize,
      // 011: the explorer narrows to the open folder and to row kinds.
      ...(scope?.parentFolderId ? { p_parent_folder_id: scope.parentFolderId } : {}),
      ...(scope?.kinds && scope.kinds.length > 0 ? { p_kind: scope.kinds } : {})
    });
    throwRpc(error);
    const result = decodeCatalogSearchResponse(data, teamId);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },

  async getCatalogVocabulary(teamId: string): Promise<CatalogVocabulary> {
    const { data, error } = await requireSupabaseClient().rpc('get_team_vocab_and_facets', {
      p_team: teamId
    });
    throwRpc(error);
    const row = asRecord(data);
    if (
      !row ||
      !Array.isArray(row.geo) ||
      !Array.isArray(row.languages) ||
      !Array.isArray(row.offers) ||
      !Array.isArray(row.tags) ||
      ![row.geo, row.languages, row.offers, row.tags].every(values =>
        values.every(value => typeof value === 'string')
      )
    ) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return row as unknown as CatalogVocabulary;
  },

  async getLandingSourceStatus(teamId: string): Promise<TeamLandingSourceStatus> {
    const { data, error } = await requireSupabaseClient().rpc('get_team_landing_source_status', {
      p_team: teamId
    });
    throwRpc(error);
    const status = teamLandingSourceStatus(data?.[0]);
    if (!status) throw new TeamApiError('INVALID_RESPONSE', false);
    return status;
  },

  async listLandingRenders(
    teamId: string,
    materialIds: string[],
    preset: string
  ): Promise<LandingRenderPointer[]> {
    if (materialIds.length === 0) return [];
    const { data, error } = await requireSupabaseClient().rpc('list_landing_renders', {
      p_team: teamId,
      p_material_ids: materialIds,
      p_preset: preset
    });
    throwRpc(error);

    const rows = Array.isArray(data) ? data.map(asRecord) : [];
    if (rows.some(row => row === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    const validRows = rows.filter(
      row => row?.render_state === 'ready' && row.valid === true && row.segment_count
    );
    const tokenByMaterial = new Map<string, RenderArtifactRef>();
    if (validRows.length > 0) {
      try {
        const tokens = await invokeTeamFunction(
          'drive-transfer',
          {
            action: 'landing_render_tokens',
            teamId,
            materialIds: validRows.map(row => row!.material_id),
            preset
          },
          renderArtifactsGuard
        );
        for (const artifact of tokens.artifacts) tokenByMaterial.set(artifact.materialId, artifact);
      } catch {
        // The gallery still reports truthful non-ready states if token minting is unavailable.
      }
    }

    const pointers: LandingRenderPointer[] = [];
    for (const row of rows) {
      if (!row || typeof row.material_id !== 'string' || typeof row.preset !== 'string') {
        throw new TeamApiError('INVALID_RESPONSE', false);
      }
      const rawState = row.render_state;
      if (!['rendering', 'ready', 'stale', 'failed'].includes(String(rawState))) {
        throw new TeamApiError('INVALID_RESPONSE', false);
      }
      const state = rawState === 'ready' && row.valid !== true ? 'stale' : rawState;
      const failureReason = [
        'unsupported',
        'corrupt',
        'protected',
        'too_large',
        'render_error'
      ].includes(String(row.failure_reason))
        ? (row.failure_reason as LandingRenderPointer['failureReason'])
        : undefined;
      const sourceVersion = typeof row.source_version === 'string' ? row.source_version : '';
      const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint : '';
      const artifact = tokenByMaterial.get(row.material_id);
      pointers.push({
        materialId: row.material_id,
        state: state as LandingRenderPointer['state'],
        ...(failureReason ? { failureReason } : {}),
        sourceVersion,
        fingerprint,
        preset: row.preset,
        ...(state === 'ready' && artifact ? { artifact } : {})
      });
    }
    return pointers;
  },

  async startLandingRender(
    teamId: string,
    materialId: string,
    preset = 'default'
  ): Promise<TeamLandingRenderJob> {
    const job = await invokeTeamFunction(
      'drive-transfer',
      { action: 'landing_render_start', teamId, materialId, preset },
      landingRenderJobGuard
    );
    /* The two addresses in the job are handed on to the local Agent, so they
       must be the ones a process on this machine can reach. Behind the gateway
       the function reports its own internal hop — on the local stack that is
       `http://127.0.0.1:8081/drive-transfer/range`, whose path lacks the
       `/functions/v1` prefix the Agent requires, so every render was refused
       with INVALID_INPUT before it began. */
    return {
      ...job,
      transferUrl: browserFunctionUrl(job.transferUrl),
      artifactUploadUrl: browserFunctionUrl(job.artifactUploadUrl)
    };
  },

  /**
   * Reports a render this browser could not hand to the Agent.
   *
   * The Agent reports its own failures, but a job it refused outright never
   * reaches that path, and the row stays "rendering" for good: no worker holds
   * it and nothing retries it, so the storage chip promises previews that will
   * never arrive. Uses the same endpoint and artifact grant the Agent uses.
   */
  async failLandingRender(job: TeamLandingRenderJob, reason = 'render_error'): Promise<void> {
    await fetch(`${job.artifactUploadUrl}/${encodeURIComponent(job.operationId)}/fail`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wishly-transfer-grant': job.artifactGrant.ticket
      },
      body: JSON.stringify({ reason }),
      redirect: 'error'
    });
  },

  async getLandingRenderArtifact(
    teamId: string,
    materialId: string,
    preset = 'default'
  ): Promise<RenderArtifactRef | null> {
    const result = await invokeTeamFunction(
      'drive-transfer',
      {
        action: 'landing_render_tokens',
        teamId,
        materialIds: [materialId],
        preset,
        allSegments: true
      },
      renderArtifactsGuard
    );
    return result.artifacts[0] ?? null;
  },

  landingRenderImageUrl(artifact: RenderArtifactRef, segment = 0): string {
    if (!publicConfig.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    const normalizedSegment = Math.max(0, Math.trunc(segment));
    const token =
      artifact.segmentTokens?.[normalizedSegment] ??
      (normalizedSegment === 0 ? artifact.artifactToken : null);
    if (!token) throw new TeamApiError('INVALID_RESPONSE', false);
    const url = new URL(
      `${publicConfig.value.supabaseUrl}/functions/v1/drive-transfer/render-range`
    );
    url.searchParams.set('grant', token);
    url.searchParams.set('segment', String(normalizedSegment));
    return url.toString();
  },

  async updateMaterialMetadata(
    teamId: string,
    materialId: string,
    patch: MaterialMetadataPatch
  ): Promise<CatalogMaterialItem> {
    const normalized = normalizeMaterialMetadataPatch(patch);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await requireSupabaseClient().rpc('update_material_metadata', {
      p_team: teamId,
      p_material: materialId,
      p_patch: normalized as unknown as Json
    });
    throwRpc(error);
    const material = decodeCatalogMaterial(data, teamId);
    if (!material) throw new TeamApiError('INVALID_RESPONSE', false);
    return material;
  },

  async startUpload(input: TeamUploadStartInput): Promise<TeamUploadSession> {
    const value = await invokeTeamFunction(
      'drive-ops/uploads/start',
      { ...input },
      uploadSessionGuard
    );
    const parsed = parseTeamUploadSession(value);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  /**
   * Sends one chunk through the upload relay.
   *
   * The resumable session Google hands back is opened by the server, with no
   * browser origin attached, so a `PUT` from a tab is refused before it leaves.
   * The relay forwards the same bytes under the team's own credential; the
   * session address travels in a header and is never persisted or logged.
   */
  /**
   * Where this browser reaches the upload relay. Built here from the public
   * address, the way render ranges already are: the function itself sits behind
   * a gateway and sees only an internal host, so the address it reports is one
   * no tab can use.
   */
  uploadRelayUrl(operationId: string): string {
    if (!publicConfig.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return `${publicConfig.value.supabaseUrl}/functions/v1/drive-ops/uploads/${encodeURIComponent(operationId)}/relay`;
  },

  async relayUploadChunk(input: {
    relayUrl: string;
    sessionUri: string;
    contentRange: string;
    chunk: Blob;
    signal?: AbortSignal;
  }): Promise<{ complete: boolean; driveFileId: string | null; receivedRange: string | null }> {
    if (!publicConfig.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    const { data } = await requireSupabaseClient().auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new TeamApiError('AUTH_REQUIRED', false);
    let response: Response;
    try {
      response = await fetch(input.relayUrl, {
        // The function takes POST for every route, relay included.
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          apikey: publicConfig.value.supabasePublishableKey,
          'content-type': 'application/octet-stream',
          'content-range': input.contentRange,
          'x-wishly-upload-session': input.sessionUri
        },
        body: input.chunk,
        cache: 'no-store',
        signal: input.signal
      });
    } catch {
      throw new TeamApiError('DRIVE_UNAVAILABLE', true);
    }
    const parsed = parseTeamEdgeResult(await response.json().catch(() => null));
    if (!parsed.ok) {
      throw new TeamApiError(parsed.error.code, parsed.error.retryable, parsed.error.details);
    }
    const value = asRecord(parsed.value);
    if (!value || typeof value.complete !== 'boolean') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return {
      complete: value.complete,
      driveFileId: typeof value.driveFileId === 'string' ? value.driveFileId : null,
      receivedRange: typeof value.receivedRange === 'string' ? value.receivedRange : null
    };
  },

  async finalizeUpload(input: {
    operationId: string;
    driveFileId: string;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult> {
    const value = await invokeTeamFunction(
      `drive-ops/uploads/${encodeURIComponent(input.operationId)}/finalize`,
      { driveFileId: input.driveFileId, idempotencyKey: input.idempotencyKey },
      fileOperationGuard
    );
    const parsed = parseTeamFileOperationResult(value);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async renameMaterial(input: {
    teamId: string;
    materialId: string;
    newName: string;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult> {
    const value = await invokeTeamFunction('drive-ops/rename', { ...input }, fileOperationGuard);
    return parseTeamFileOperationResult(value) as TeamFileOperationResult;
  },

  async moveMaterial(input: {
    teamId: string;
    materialId: string;
    /** The folder's provider id, or null for the space root. */
    destinationFolderId: string | null;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult> {
    const value = await invokeTeamFunction('drive-ops/move', { ...input }, fileOperationGuard);
    return parseTeamFileOperationResult(value) as TeamFileOperationResult;
  },

  async trashMaterial(input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult> {
    const value = await invokeTeamFunction(
      'drive-ops/trash',
      { ...input, confirmed: true },
      fileOperationGuard
    );
    return parseTeamFileOperationResult(value) as TeamFileOperationResult;
  },

  async restoreMaterial(input: {
    teamId: string;
    materialId: string;
    destinationFolderId?: string | null;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult> {
    const value = await invokeTeamFunction('drive-ops/restore', { ...input }, fileOperationGuard);
    return parseTeamFileOperationResult(value) as TeamFileOperationResult;
  },

  async editText(input: TeamTextEditRequest): Promise<TeamFileOperationResult> {
    const value = await invokeTeamFunction('drive-ops/text-edit', { ...input }, fileOperationGuard);
    return parseTeamFileOperationResult(value) as TeamFileOperationResult;
  },

  async requestDownload(
    teamId: string,
    materialId: string,
    consumer: 'browser' | 'agent'
  ): Promise<TeamDownloadGrantResult> {
    const value = await invokeTeamFunction(
      'drive-transfer',
      { action: 'grant', purpose: 'download', teamId, materialId, consumer },
      downloadGrantGuard
    );
    const parsed = parseTeamDownloadGrantResult(value);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.kind === 'browser'
      ? { ...parsed, rangeUrl: browserFunctionUrl(parsed.rangeUrl) }
      : parsed;
  },

  async startProcess(input: TeamProcessStartInput): Promise<TeamProcessStartResult> {
    const value = await invokeTeamFunction(
      'drive-ops/process/start',
      { ...input },
      processStartGuard
    );
    const parsed = parseTeamProcessStartResult(value);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async getOperation(teamId: string, operationId: string): Promise<TeamOperationSnapshot> {
    const { data, error } = await requireSupabaseClient().rpc('get_operation', {
      p_team: teamId,
      p_operation: operationId
    });
    throwRpc(error);
    const operation = mapOperation(data?.[0]);
    if (!operation) throw new TeamApiError('INVALID_RESPONSE', false);
    return operation;
  },

  async cancelOperation(teamId: string, operationId: string): Promise<TeamOperationSnapshot> {
    const { data, error } = await requireSupabaseClient().rpc('cancel_team_operation', {
      p_team: teamId,
      p_operation: operationId
    });
    throwRpc(error);
    const operation = mapOperation(data?.[0]);
    if (!operation) throw new TeamApiError('INVALID_RESPONSE', false);
    return operation;
  },

  async getMaterialProvenance(
    teamId: string,
    materialId: string
  ): Promise<TeamMaterialProvenanceEntry[]> {
    const { data, error } = await requireSupabaseClient().rpc('get_material_provenance', {
      p_team: teamId,
      p_material: materialId
    });
    throwRpc(error);
    const provenance = (data ?? []).map(mapProvenance);
    if (provenance.some(item => item === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return provenance.filter((item): item is TeamMaterialProvenanceEntry => item !== null);
  },

  async previewMaterial(
    teamId: string,
    materialId: string,
    mode: 'media' | 'transcript' | 'archive' | 'landing'
  ): Promise<TeamPreviewResult> {
    const value = await invokeTeamFunction(
      'drive-transfer',
      { teamId, materialId, mode },
      (candidate): candidate is TeamPreviewResult => parseTeamPreviewResult(candidate) !== null
    );
    const parsed = parseTeamPreviewResult(value);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.kind === 'media'
      ? { ...parsed, rangeUrl: browserFunctionUrl(parsed.rangeUrl) }
      : parsed;
  },

  async listLibraryMaterials(input: {
    teamId: string;
    stage: 'finds' | 'library';
    cursor?: string | null;
    pageSize?: number;
  }): Promise<LibraryAssetSummary[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_library_materials', {
      p_team: input.teamId,
      p_stage: input.stage,
      p_cursor: input.cursor ?? undefined,
      p_page_size: input.pageSize ?? 50
    });
    throwRpc(error);
    const items = (data ?? []).map(parseLibraryAssetSummary);
    if (items.some(item => item === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    return items.filter((item): item is LibraryAssetSummary => item !== null);
  },

  async moveLibraryMaterials(
    request: LibraryPlacementMutationRequest
  ): Promise<LibraryPlacementMutationResult> {
    const normalized = parseLibraryPlacementMutation(request);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const value = await invokeTeamFunction(
      'library-ops/placement/move',
      { action: 'placement_move', ...normalized },
      (candidate): candidate is LibraryPlacementMutationResult =>
        libraryPlacementMutationResult(candidate) !== null
    );
    return libraryPlacementMutationResult(value) as LibraryPlacementMutationResult;
  },

  async startLibraryUploadBatch(
    request: UploadBatchRequest
  ): Promise<LibraryUploadBatchStartResult> {
    const normalized = parseUploadBatchRequest(request);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    return invokeTeamFunction(
      'library-ops/batches/start',
      normalized as unknown as Record<string, unknown>,
      (value): value is LibraryUploadBatchStartResult =>
        libraryUploadBatchStartResult(value) !== null
    );
  },

  async finalizeLibraryBatchItem(input: {
    teamId: string;
    batchId: string;
    clientItemKey: string;
    materialId: string;
  }): Promise<{ state: 'succeeded'; materialId: string; reused: boolean }> {
    const value = await invokeTeamFunction(
      'library-ops/batches/items/finalize',
      { action: 'batch_item_finalize', ...input },
      (candidate): candidate is { state: 'succeeded'; materialId: string; reused: boolean } => {
        const row = asRecord(candidate);
        return Boolean(
          row &&
          row.state === 'succeeded' &&
          typeof row.materialId === 'string' &&
          typeof row.reused === 'boolean'
        );
      }
    );
    return value;
  },

  async failLibraryBatchItem(input: {
    teamId: string;
    batchId: string;
    clientItemKey: string;
    errorCode: string;
  }): Promise<{ state: 'failed'; errorCode: string }> {
    return invokeTeamFunction(
      'library-ops/batches/items/fail',
      { action: 'batch_item_fail', ...input },
      (candidate): candidate is { state: 'failed'; errorCode: string } => {
        const row = asRecord(candidate);
        return Boolean(
          row &&
          row.state === 'failed' &&
          typeof row.errorCode === 'string' &&
          /^[A-Z][A-Z0-9_]{0,63}$/u.test(row.errorCode)
        );
      }
    );
  },

  async createTask(input: {
    teamId: string;
    title: string;
    note?: string | null;
    assigneeId?: string | null;
    initialMaterialId?: string | null;
  }): Promise<TeamTaskSummary> {
    const title = input.title.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (title.length < 1 || title.length > 160 || (input.note?.length ?? 0) > 2_000) {
      throw new TeamApiError('INVALID_INPUT', false);
    }
    const { data, error } = await requireSupabaseClient().rpc('create_team_task', {
      p_team: input.teamId,
      p_title: title,
      p_note: input.note ?? undefined,
      p_assignee: input.assigneeId ?? undefined,
      p_initial_material: input.initialMaterialId ?? undefined
    });
    throwRpc(error);
    const task = mapTeamTask(data);
    if (!task) throw new TeamApiError('INVALID_RESPONSE', false);
    return task;
  },

  async listTasks(input: {
    teamId: string;
    createdFrom?: string | null;
    createdTo?: string | null;
    status?: TeamTaskStatus | null;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<TeamTaskSummary[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_tasks', {
      p_team: input.teamId,
      p_created_from: input.createdFrom ?? undefined,
      p_created_to: input.createdTo ?? undefined,
      p_status: input.status ?? undefined,
      p_cursor: input.cursor ?? undefined,
      p_page_size: input.pageSize ?? 50
    });
    throwRpc(error);
    const tasks = (data ?? []).map(mapTeamTask);
    if (tasks.some(task => task === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    return tasks.filter((task): task is TeamTaskSummary => task !== null);
  },

  async getTask(input: {
    teamId: string;
    taskId: string;
    attachmentCursor?: number | null;
    attachmentPageSize?: number;
  }): Promise<{ task: TeamTaskSummary; attachments: TeamTaskAttachmentSummary[] }> {
    const { data, error } = await requireSupabaseClient().rpc('get_team_task', {
      p_team: input.teamId,
      p_task: input.taskId,
      p_attachment_cursor: input.attachmentCursor ?? undefined,
      p_attachment_page_size: input.attachmentPageSize ?? 50
    });
    throwRpc(error);
    const payload = asRecord(data);
    const task = mapTeamTask(payload?.task);
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments.map(parseTeamTaskAttachmentSummary)
      : null;
    if (!task || !attachments || attachments.some(attachment => attachment === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return {
      task,
      attachments: attachments.filter(
        (attachment): attachment is TeamTaskAttachmentSummary => attachment !== null
      )
    };
  },

  async updateTask(teamId: string, taskId: string, patch: TeamTaskPatch): Promise<TeamTaskSummary> {
    const normalized = parseTeamTaskPatch(patch);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await requireSupabaseClient().rpc('update_team_task', {
      p_team: teamId,
      p_task: taskId,
      p_patch: normalized as unknown as Json
    });
    throwRpc(error);
    const task = mapTeamTask(data);
    if (!task) throw new TeamApiError('INVALID_RESPONSE', false);
    return task;
  },

  async attachTaskMaterials(input: {
    teamId: string;
    taskId: string;
    materialIds: string[];
  }): Promise<TeamTaskAttachmentMutationResult> {
    const normalized = parseTaskAttachmentMutation(input);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await requireSupabaseClient().rpc('attach_team_task_materials', {
      p_team: normalized.teamId,
      p_task: normalized.taskId,
      p_materials: normalized.materialIds
    });
    throwRpc(error);
    const result = taskAttachmentMutationResult(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },

  async detachTaskMaterial(teamId: string, taskId: string, materialId: string): Promise<boolean> {
    const { data, error } = await requireSupabaseClient().rpc('detach_team_task_material', {
      p_team: teamId,
      p_task: taskId,
      p_material: materialId
    });
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async scanLibraryRequirements(
    teamId: string,
    interfaceLanguage: string,
    sourceMaterialId?: string
  ): Promise<LibraryRequirementScanResult> {
    const { data, error } = await requireSupabaseClient().rpc('scan_library_requirements', {
      p_team: teamId,
      p_interface_language: interfaceLanguage,
      p_source: sourceMaterialId
    });
    throwRpc(error);
    const result = libraryScanResult(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },

  async getLibraryProcessingContext(
    teamId: string,
    sourceMaterialId: string
  ): Promise<LibraryProcessingContext> {
    const { data, error } = await requireSupabaseClient().rpc('get_library_processing_context', {
      p_team: teamId,
      p_source: sourceMaterialId
    });
    throwRpc(error);
    const row = asRecord(data);
    if (
      !row ||
      typeof row.sourceMaterialId !== 'string' ||
      typeof row.sourceName !== 'string' ||
      !['video', 'landing', 'archive'].includes(String(row.category)) ||
      typeof row.destinationFolderId !== 'string'
    ) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return row as unknown as LibraryProcessingContext;
  },

  async claimLibraryJob(input: LibraryJobClaimRequest): Promise<LibraryJobClaimEnvelope> {
    const normalized = parseLibraryJobClaim(input);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await requireSupabaseClient().rpc('claim_library_job', {
      p_team: normalized.teamId,
      p_agent_instance: normalized.agentInstanceId,
      p_supported_kinds: normalized.supportedKinds,
      p_interface_language: normalized.interfaceLanguage,
      p_source: normalized.sourceMaterialId
    });
    throwRpc(error);
    const result = libraryJobClaimEnvelope(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },

  async heartbeatLibraryJob(input: LibraryJobHeartbeatRequest): Promise<{
    attemptId: string;
    progress: number;
    stage: string;
    leaseExpiresAt: string;
  }> {
    const normalized = parseLibraryJobHeartbeat(input);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await requireSupabaseClient().rpc('heartbeat_library_job', {
      p_team: normalized.teamId,
      p_attempt: normalized.attemptId,
      p_agent_instance: normalized.agentInstanceId,
      p_lease_token: normalized.leaseToken,
      p_progress: normalized.progress,
      p_stage: normalized.stage
    });
    throwRpc(error);
    const row = asRecord(data);
    if (
      !row ||
      typeof row.attemptId !== 'string' ||
      typeof row.progress !== 'number' ||
      typeof row.stage !== 'string' ||
      typeof row.leaseExpiresAt !== 'string'
    ) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return row as unknown as {
      attemptId: string;
      progress: number;
      stage: string;
      leaseExpiresAt: string;
    };
  },

  async cancelLibraryJob(input: {
    teamId: string;
    attemptId: string;
    agentInstanceId: string;
    leaseToken: string;
  }): Promise<boolean> {
    const { data, error } = await requireSupabaseClient().rpc('cancel_library_job', {
      p_team: input.teamId,
      p_attempt: input.attemptId,
      p_agent_instance: input.agentInstanceId,
      p_lease_token: input.leaseToken
    });
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async failLibraryJob(input: {
    teamId: string;
    attemptId: string;
    agentInstanceId: string;
    leaseToken: string;
    errorCode: string;
  }): Promise<boolean> {
    const { data, error } = await requireSupabaseClient().rpc('fail_library_job', {
      p_team: input.teamId,
      p_attempt: input.attemptId,
      p_agent_instance: input.agentInstanceId,
      p_lease_token: input.leaseToken,
      p_error_code: input.errorCode
    });
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async retryFailedLibraryJobs(teamId: string, sourceMaterialId?: string): Promise<number> {
    const { data, error } = await requireSupabaseClient().rpc('retry_failed_library_jobs', {
      p_team: teamId,
      p_source: sourceMaterialId
    });
    throwRpc(error);
    if (typeof data !== 'number' || !Number.isSafeInteger(data) || data < 0) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return data;
  },

  async finalizeLibraryJob(input: LibraryJobFinalizeRequest): Promise<LibraryJobFinalizeResult> {
    const normalized = parseLibraryJobFinalize(input);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    return invokeTeamFunction(
      'library-ops/jobs/finalize',
      { action: 'job_finalize', ...normalized },
      (candidate): candidate is LibraryJobFinalizeResult => {
        const row = asRecord(candidate);
        return Boolean(
          row &&
          ((row.state === 'accepted' &&
            typeof row.resultId === 'string' &&
            typeof row.materialId === 'string') ||
            (row.state === 'skipped' &&
              row.reason === 'already_completed' &&
              (row.materialId === null || typeof row.materialId === 'string')))
        );
      }
    );
  },

  async listVideoTextVariants(teamId: string, videoId: string): Promise<LibraryVideoTextVariants> {
    const { data, error } = await requireSupabaseClient().rpc('list_video_text_variants', {
      p_team: teamId,
      p_video: videoId
    });
    throwRpc(error);
    const variants = parseLibraryVideoTextVariants(data);
    if (!variants) throw new TeamApiError('INVALID_RESPONSE', false);
    return variants;
  },

  async getLibrarySharePreference(teamId: string): Promise<{
    allowLinkOnCopy: boolean;
    remembered: boolean;
  }> {
    const { data, error } = await requireSupabaseClient().rpc('get_share_preference', {
      p_team: teamId
    });
    throwRpc(error);
    const row = asRecord(data);
    if (!row || typeof row.allowLinkOnCopy !== 'boolean' || typeof row.remembered !== 'boolean') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { allowLinkOnCopy: row.allowLinkOnCopy, remembered: row.remembered };
  },

  async shareLibraryMaterial(request: LibraryShareCopyRequest): Promise<LibraryShareCopyResult> {
    const normalized = parseLibraryShareCopyRequest(request);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const value = await invokeTeamFunction(
      'library-ops/share/copy',
      { action: 'share_copy', ...normalized },
      (candidate): candidate is LibraryShareCopyResult =>
        parseLibraryShareCopyResult(candidate) !== null
    );
    return parseLibraryShareCopyResult(value) as LibraryShareCopyResult;
  },

  async resetLibrarySharePreference(teamId: string): Promise<boolean> {
    const { data, error } = await requireSupabaseClient().rpc('reset_share_preference', {
      p_team: teamId
    });
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async commitLandingPreviewValidation(input: {
    teamId: string;
    materialId: string;
    operationId: string;
    ticket: string;
    validation: TeamLandingValidationRecord;
  }): Promise<boolean> {
    const value = await invokeTeamFunction(
      'drive-transfer',
      {
        action: 'landing_validation',
        teamId: input.teamId,
        materialId: input.materialId,
        operationId: input.operationId,
        ticket: input.ticket,
        validation: input.validation
      },
      (candidate): candidate is { validated: boolean } =>
        typeof asRecord(candidate)?.validated === 'boolean'
    );
    return value.validated;
  },

  /**
   * Self-service exit from a space. Succeeds with the standing warning that
   * Google Drive's own sharing ACL is not revoked by leaving — the caller is
   * expected to show it, not to swallow it.
   */
  async leaveTeam(
    teamId: string
  ): Promise<{ ok: true; warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }> {
    const { data, error } = await requireSupabaseClient().rpc('leave_team', {
      p_team: teamId
    });
    throwRpc(error);
    const row = data?.[0];
    if (!row?.ok || row.warning_code !== 'EXTERNAL_DRIVE_ACCESS_REMAINS') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { ok: true, warningCode: row.warning_code };
  },

  /**
   * Delete a space that never completed setup. The server decides what "draft"
   * means (a space that has never had a drive connection) and answers
   * `TEAM_NOT_DRAFT` when the lobby's presentation was out of date.
   */
  async deleteDraftTeam(teamId: string): Promise<true> {
    const { data, error } = await requireSupabaseClient().rpc('delete_draft_team', {
      p_team: teamId
    });
    throwRpc(error);
    if (data?.[0]?.ok !== true) throw new TeamApiError('INVALID_RESPONSE', false);
    return true;
  },

  /** Delete a saved task. Attachment links go with it; the materials do not. */
  async deleteTask(input: { teamId: string; taskId: string }): Promise<true> {
    const { data, error } = await requireSupabaseClient().rpc('delete_team_task', {
      p_team: input.teamId,
      p_task: input.taskId
    });
    throwRpc(error);
    if (data?.[0]?.ok !== true) throw new TeamApiError('INVALID_RESPONSE', false);
    return true;
  },

  /**
   * Newest-first page of trashed materials. `before` is the `trashedAt` of the
   * last row already shown — keyset paging, so a restore happening mid-scroll
   * cannot shift the window and hide a row.
   */
  async listTrashedMaterials(input: {
    teamId: string;
    limit?: number;
    before?: string | null;
  }): Promise<TeamTrashedMaterial[]> {
    const { data, error } = await requireSupabaseClient().rpc('list_team_trashed_materials', {
      p_team: input.teamId,
      p_limit: input.limit ?? 50,
      p_before: input.before ?? undefined
    });
    throwRpc(error);
    const rows = (data ?? []).map(mapTrashedMaterial);
    if (rows.some(row => row === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    return rows.filter((row): row is TeamTrashedMaterial => row !== null);
  }
};
