import {
  attachCatalogForeground,
  catalogForeground,
  catalogForegroundScope
} from './catalog-video-foreground-client';
import type { CatalogForegroundExecutor } from './catalog-video-foreground';
import {
  isCatalogUpdaterVariantsSnapshot,
  type CatalogUpdaterVariantsSnapshot
} from './catalog-updater-variants';
import {
  parseCatalogVideoRowProgress,
  type CatalogVideoRowProgress
} from './catalog-video-row-progress';
import {
  isCatalogCreatedVideoProgress,
  type CatalogCreatedVideoProgress,
  isCatalogVideoPreparingResult,
  type CatalogVideoCreationPreferences,
  type CatalogVideoPreparingResult
} from './catalog-video-creation';
import {
  parseCatalogPublicationSnapshot,
  type CatalogPublicationCommand
} from '@video-compressor/shared';
import { privateCacheActor } from '../team/private-cache-scope';
import { FunctionsFetchError } from '@supabase/supabase-js';
import {
  executeTariffGrant,
  pendingTariffGrant,
  TariffGrantIntentError
} from '../pages/admin/tariffGrantIntent';
import { catalogImageClient, getGlobalCatalogImageReadiness } from './team-catalog-images';
import { catalogVideoR2Client } from './team-catalog-video-r2';
import { taskRpc } from '../team/tasks/diagnostics';
import {
  normalizeCatalogCommandRequest,
  parseCatalogCommandReceipt,
  isCatalogCommandUuid,
  type CatalogCommandRequest,
  type CatalogCommandReceipt,
  isTaskCleanupReceipt,
  type TaskCleanupReceipt,
  parseBulkTrashGroup,
  parseBulkTrashGroups,
  type BulkTrashGroup,
  RESTITCH_CONTRACT_VERSION,
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
  type TeamTransferGrant,
  type CatalogUpdateProfile,
  type CatalogUpdateProfilePatch,
  type CatalogUpdateAttempt,
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
  parseTeamAccount,
  parseTeamAccountAgent,
  parseTeamAgentRunMarkerSnapshots,
  parseTeamTaskAgentTags,
  parseTeamTaskLabel,
  TEAM_TASK_LABEL_FILTER_MAX,
  type TeamLabelScope,
  parseTeamTaskLabelRefs,
  normalizeTeamTaskLabelName,
  isTeamTaskLabelColor,
  isTeamTaskSort,
  isTeamTaskDate,
  type TeamTaskAgentTag,
  type TeamTaskLabel,
  type TeamTaskLabelColor,
  type TeamTaskLabelRef,
  type TeamTaskSort,
  normalizeTeamAccountName,
  normalizeTeamAgentId,
  validFinanceTimezone,
  validFinanceDate,
  financeToday,
  normalizeTeamAgentNote,
  type TeamAccountAgentSummary,
  type TeamAccountSummary,
  type TeamAgentRunMarker,
  type TeamAgentRunMarkerSnapshot,
  parseUploadBatchRequest,
  isFolderPage,
  isStorageHealth,
  isThumbnailSession,
  isTeamDriveSelection,
  isTeamFolderNode,
  isTeamMaterialTagColor,
  type TeamMaterialTagColor,
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
  type TeamTaskAttachmentSummary,
  parseMaterialRestitchPrep,
  parseRestitchDrawResult,
  parseRestitchSourcesListing,
  parseTeamRestitchDefaults,
  type MaterialRestitchPrep,
  type TeamRestitchDefaults,
  parseAdminLegacySpaces,
  parseAdminOwnerSpaces,
  parseAdminSpaceRequests,
  parseAdminTariffEvents,
  parseAdminTariffPreview,
  parseAdminTariffRow,
  parseAdminTariffRows,
  parseAdminTariffSeats,
  parseAdminTariffSettings,
  parseSpaceAccess,
  parseSpaceOwnerNudge,
  parseTariffPlans,
  parseTeamTariff,
  type AdminLegacySpace,
  type AdminOwnerSpace,
  type AdminSpaceRequest,
  type AdminTariffEvent,
  type AdminTariffPreview,
  type AdminTariffRow,
  type AdminTariffSeat,
  type AdminTariffSettings,
  type SpaceAccess,
  type SpaceOwnerNudgeResult,
  type TariffContactChannel,
  type TariffPlan,
  type TeamTariff
} from '@video-compressor/shared';
import type {
  RestitchDrawResult,
  RestitchSlot,
  RestitchSourceInput,
  RestitchSourcesListing
} from '@video-compressor/shared';
import { parseFolderSyncStatus, type FolderSyncStatus } from '../team/syncStatus';
import { parseUpdaterInterval, type UpdaterInterval } from '../team/catalog-updater/limits';
import type { Database, Json } from '../lib/database.types';
import { publicConfig } from '../lib/config';
import { requireSupabaseClient, withFreshSession } from '../lib/supabase';
import { memberAttempt } from '../team/members/diagnostics';

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

export interface CatalogMutationOptions {
  expectedActorId: string;
  signal?: AbortSignal;
}
/** Capture before session acquisition; the server refuses a replacement account. */
function catalogMutationActor(options?: CatalogMutationOptions): string {
  if (options !== undefined && (!options || typeof options.expectedActorId !== 'string'))
    throw new TeamApiError('INVALID_INPUT', false);
  const actor = options?.expectedActorId ?? privateCacheActor();
  if (actor === null || actor === undefined) throw new TeamApiError('AUTH_REQUIRED', false);
  if (!isCatalogCommandUuid(actor)) throw new TeamApiError('INVALID_INPUT', false);
  return actor.toLowerCase();
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

/** 022 — a video's product catalog sheet, as the card and the tail module see it. */
export interface ProductCatalogSummary {
  id: string;
  name: string;
  sheetUrl: string;
  sourceLink: string;
  productCount: number;
  /** The variation's number (024, US15): `<video>_v<N>_catalog`. */
  variant: number;
  createdAt: string;
}

/**
 * 1.4.3 — one of the caller's own catalog creations for a video that has not
 * finished. The server lists it so a closed creation can be found, reopened and
 * canceled from the video's catalogs, in any browser.
 */
export interface UnfinishedCatalogCreation {
  idempotencyKey: string;
  variant: number;
  replacesMaterialId: string | null;
  createdAt: string;
  intentState: string;
  safeErrorCode: string | null;
  sourceLink: string | null;
  productCount: number | null;
  restitch: boolean;
  variationCount: number | null;
  duration: Record<string, unknown> | null;
  copyVideoToR2: boolean;
  /** The video set's state; null for a creation without restitch. */
  setState: string | null;
  requestedCount: number | null;
  registeredCount: number;
  workingCount: number;
  queuedCount: number;
  unknownCount: number;
  /** A video is being made but the computer making it went quiet. */
  agentSilent: boolean;
}

function unfinishedCatalogCreationFrom(value: unknown): UnfinishedCatalogCreation | null {
  const row =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !row ||
    typeof row.idempotencyKey !== 'string' ||
    !/^product-catalog:[0-9a-f-]{36}$/iu.test(row.idempotencyKey) ||
    typeof row.variant !== 'number' ||
    typeof row.createdAt !== 'string' ||
    typeof row.intentState !== 'string'
  )
    return null;
  const text = (field: unknown) => (typeof field === 'string' ? field : null);
  const count = (field: unknown) => (typeof field === 'number' ? field : null);
  return {
    idempotencyKey: row.idempotencyKey,
    variant: row.variant,
    replacesMaterialId: text(row.replacesMaterialId),
    createdAt: row.createdAt,
    intentState: row.intentState,
    safeErrorCode: text(row.safeErrorCode),
    sourceLink: text(row.sourceLink),
    productCount: count(row.productCount),
    restitch: row.restitch === true,
    variationCount: count(row.variationCount),
    duration:
      row.duration !== null && typeof row.duration === 'object' && !Array.isArray(row.duration)
        ? (row.duration as Record<string, unknown>)
        : null,
    copyVideoToR2: row.copyVideoToR2 === true,
    setState: text(row.setState),
    requestedCount: count(row.requestedCount),
    registeredCount: count(row.registeredCount) ?? 0,
    workingCount: count(row.workingCount) ?? 0,
    queuedCount: count(row.queuedCount) ?? 0,
    unknownCount: count(row.unknownCount) ?? 0,
    agentSilent: row.agentSilent === true
  };
}

/** 022 — the four values every catalog in a space is filled from. */
export interface ProductCatalogSettings {
  /** One name for every row, used only while the name pool is empty (024). */
  title: string | null;
  description: string | null;
  /** Whole dollars; the sheet writes `${price},00 USD`. The low end of the range. */
  price: number;
  /** The range each row's price is drawn from, whole dollars. */
  priceMin: number;
  priceMax: number;
  /** A picture link for every row, used only while the picture pool is empty. */
  imageLink: string | null;
  updatedAt: string;
}

export interface ProductCatalogImageSource {
  materialId: string;
  kind: 'file' | 'folder';
  name: string;
  imageCount: number;
}

export interface ProductCatalogTextSchedule {
  enabled: boolean;
  count: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

function parseProductCatalogTextSchedule(value: unknown): ProductCatalogTextSchedule {
  const row = asRecord(value);
  const nullableDate = (value: unknown) =>
    value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (
    !row ||
    typeof row.enabled !== 'boolean' ||
    typeof row.count !== 'number' ||
    !Number.isInteger(row.count) ||
    row.count < 1 ||
    row.count > 1000 ||
    !nullableDate(row.nextRunAt) ||
    !nullableDate(row.lastRunAt) ||
    (row.lastError !== null && typeof row.lastError !== 'string')
  )
    throw new TeamApiError('INVALID_RESPONSE', false);
  return row as unknown as ProductCatalogTextSchedule;
}

export interface ProductCatalogText {
  id: string;
  title: string;
  description: string;
}

export interface ProductCatalogCreateResult {
  videoGeneration?: CatalogCreatedVideoProgress;
  videoGenerationObservation?: CatalogCreatedVideoProgress;
  outcome: 'created' | 'recreated' | 'existing';
  /** The server names the sheet by `materialId`; a sheet it just made has no `createdAt` yet. */
  catalog: {
    materialId: string;
    name: string;
    sheetUrl: string;
    sourceLink: string;
    productCount: number;
    variant?: number;
    createdAt: string | null;
  };
  videoShared: boolean;
}

export interface CatalogListSnapshot<T> {
  rows: T[];
  invalidRowCount: number;
}

function catalogListSnapshotFrom<T>(
  data: unknown,
  parse: (value: unknown) => T | null
): CatalogListSnapshot<T> {
  if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
  const rows: T[] = [];
  let invalidRowCount = 0;
  for (const value of data) {
    const row = parse(value);
    if (row) rows.push(row);
    else invalidRowCount++;
  }
  return { rows, invalidRowCount };
}

/** 023 — one row of the catalog registry: a live product catalog and the video it belongs to. */
/** A scheduled video-link publication that has not been written yet (1.4.3). */
export interface CatalogRowPublication {
  dueAt: string;
  timeZone: string;
  /** The link's videos are still being made; it goes out once they are ready. */
  waitingForVideos: boolean;
}

export interface CatalogRegistryRow {
  videoGeneration?: CatalogVideoRowProgress | null;
  /** Missing on older servers; null when no scheduled publication is pending. */
  videoPublication?: CatalogRowPublication | null;
  catalogId: string;
  name: string;
  sheetUrl: string;
  videoId: string;
  videoName: string;
  folderName: string | null;
  productCount: number;
  createdAt: string;
  lastUpdatedAt: string | null;
  updateCount: number;
  inUpdater: boolean;
  lastUpdateError: string | null;
  /** This catalog's own interval; null when it is not on a schedule (024). */
  updateInterval: CatalogUpdaterInterval | null;
  /** When this catalog is due next, by the server's clock. */
  nextRunAt: string | null;
  /** An update is waiting or running for it right now. */
  updatePending: boolean;
  /** The stage the background worker last confirmed; survives page reloads. */
  updateStage: CatalogUpdateStage | null;
  /** Live progress of the video copy, reported by the member's local app. */
  /** Missing on older servers; null means the new snapshot observed no active identity. */
  runtimeObservedAt?: string;
  activeRoundAt?: string | null;
  activeAttemptId?: string | null;
  progressAttemptId?: string | null;
  restitchOperationId?: string | null;
  restitchProgress: number | null;
  restitchStage: 'downloading' | 'processing' | 'uploading' | 'finalizing' | null;
  /** The provider id of the folder the sheet is in; null at the space root. */
  folderDriveId: string | null;
  profile?: CatalogUpdateProfile;
}

function catalogUpdateProfileFrom(value: unknown, snakeCase = false): CatalogUpdateProfile | null {
  const row = asRecord(value);
  if (!row) return null;
  const get = (camel: string, snake: string): unknown => row[snakeCase ? snake : camel];
  const catalogId = get('catalogId', 'catalog_material_id');
  const refreshImages = get('refreshImages', 'refresh_images');
  const refreshTexts = get('refreshTexts', 'refresh_texts');
  const growProducts = get('growProducts', 'grow_products');
  const randomLinkVariation = get('randomLinkVariation', 'random_link_variation');
  const restitch = row.restitch;
  const videoVariantCount = get('videoVariantCount', 'video_variant_count');
  const updatedAt = get('updatedAt', 'updated_at');
  const lastErrorAt = get('lastErrorAt', 'last_error_at');
  const lastResult = get('lastResult', 'last_result');
  const optionalDate = (value: unknown): string | null | undefined =>
    value === null
      ? null
      : typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? value
        : undefined;
  if (
    typeof catalogId !== 'string' ||
    typeof refreshImages !== 'boolean' ||
    typeof refreshTexts !== 'boolean' ||
    typeof growProducts !== 'boolean' ||
    typeof randomLinkVariation !== 'boolean' ||
    typeof restitch !== 'boolean' ||
    typeof row.version !== 'number' ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    (videoVariantCount !== undefined &&
      (!Number.isSafeInteger(videoVariantCount) ||
        Number(videoVariantCount) < 1 ||
        Number(videoVariantCount) > 400)) ||
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt))
  )
    return null;
  const schedule = asRecord(row.schedule);
  if (
    row.schedule != null &&
    (!schedule ||
      typeof schedule.timeZone !== 'string' ||
      typeof schedule.weekday !== 'number' ||
      !Number.isInteger(schedule.weekday) ||
      schedule.weekday < 1 ||
      schedule.weekday > 7 ||
      typeof schedule.time !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))
  )
    return null;
  return {
    schedule: schedule
      ? {
          timeZone: schedule.timeZone as string,
          weekday: schedule.weekday as number,
          time: schedule.time as string
        }
      : null,
    catalogId,
    refreshImages,
    refreshTexts,
    growProducts,
    randomLinkVariation,
    restitch,
    ...(typeof videoVariantCount === 'number' ? { videoVariantCount } : {}),
    version: row.version,
    updatedAt,
    lastErrorAt: typeof lastErrorAt === 'string' ? lastErrorAt : null,
    lastResult:
      lastResult === undefined
        ? undefined
        : lastResult === null
          ? null
          : ['running', 'success', 'partial', 'failed', 'cancelled', 'unknown'].includes(
                String(lastResult)
              )
            ? (lastResult as CatalogUpdateProfile['lastResult'])
            : 'unknown',
    latestAttemptAt: optionalDate(get('latestAttemptAt', 'latest_attempt_at')),
    lastSuccessfulAt: optionalDate(get('lastSuccessfulAt', 'last_successful_at')),
    restitchStatus:
      snakeCase &&
      ['ready', 'preparing', 'blocked', 'waiting'].includes(String(row.restitch_status))
        ? (row.restitch_status as CatalogUpdateProfile['restitchStatus'])
        : undefined,
    restitchBlockedCode:
      snakeCase && typeof row.restitch_blocked_code === 'string' ? row.restitch_blocked_code : null,
    reconciliationRequired: snakeCase && row.reconciliation_required === true
  };
}

export type CatalogUpdateStage =
  | 'waiting_video'
  | 'restitching'
  | 'preparing'
  | 'refreshing'
  | 'building'
  | 'uploading'
  | 'verifying'
  | 'finalizing';

export type CatalogUpdaterInterval = UpdaterInterval;

/** A spare copy to prepare, as drive-ops hands it to a member's tab (023). */
export interface RestitchClaim {
  jobId: string;
  leaseToken: string;
  operationId: string;
  toolId: 'restitch';
  videoMaterialId: string;
  videoDriveVersion: string | null;
  options: { defaults: unknown; prepared: unknown; screens?: unknown; teamId?: unknown };
  sourceGrant: TeamTransferGrant;
  finalizeGrant: TeamTransferGrant;
}

function restitchClaimGuard(value: unknown): value is { job: RestitchClaim | null } {
  const row = asRecord(value);
  if (!row || !('job' in row)) return false;
  if (row.job === null) return true;
  const job = asRecord(row.job);
  return (
    !!job &&
    typeof job.jobId === 'string' &&
    typeof job.leaseToken === 'string' &&
    typeof job.operationId === 'string' &&
    job.toolId === 'restitch' &&
    typeof job.videoMaterialId === 'string' &&
    (job.videoDriveVersion === null || typeof job.videoDriveVersion === 'string') &&
    !!asRecord(job.options) &&
    !!asRecord(job.sourceGrant) &&
    !!asRecord(job.finalizeGrant)
  );
}

function cancelGuard(value: unknown): value is { cancel: boolean } {
  return typeof asRecord(value)?.cancel === 'boolean';
}

function recordedGuard(value: unknown): value is { recorded: boolean } {
  return typeof asRecord(value)?.recorded === 'boolean';
}

/** 023 — the space's catalog updater, as the chip and the dialog show it. */
export interface CatalogUpdaterState {
  state: 'running' | 'stopped';
  interval: CatalogUpdaterInterval;
  restitch: boolean;
  nextRunAt: string | null;
  startedAt: string | null;
  catalogCount: number;
  failingCount: number;
  spareReadyCount: number | null;
  /** Actual queued/running updates; absent on an older server means unknown. */
  activeCount?: number | null;
  /** Why the spare copies stand still, when a job was given back for a reason a person can fix (030). */
  restitchBlockedCode: TeamErrorCode | null;
  serverNow: string;
}

function catalogUpdaterStateFrom(value: unknown): CatalogUpdaterState | null {
  const row = asRecord(value);
  if (
    !row ||
    (row.state !== 'running' && row.state !== 'stopped') ||
    parseUpdaterInterval(row.interval) === null ||
    typeof row.restitch !== 'boolean' ||
    (row.nextRunAt !== null && typeof row.nextRunAt !== 'string') ||
    (row.startedAt !== null && typeof row.startedAt !== 'string') ||
    typeof row.catalogCount !== 'number' ||
    typeof row.failingCount !== 'number' ||
    typeof row.serverNow !== 'string'
  ) {
    return null;
  }
  return {
    state: row.state,
    interval: row.interval as CatalogUpdaterInterval,
    restitch: row.restitch,
    nextRunAt: row.nextRunAt as string | null,
    startedAt: row.startedAt as string | null,
    catalogCount: row.catalogCount,
    failingCount: row.failingCount,
    activeCount:
      typeof row.activeCount === 'number' &&
      Number.isInteger(row.activeCount) &&
      row.activeCount >= 0
        ? row.activeCount
        : null,
    spareReadyCount: typeof row.spareReadyCount === 'number' ? row.spareReadyCount : null,
    restitchBlockedCode:
      typeof row.restitchBlockedCode === 'string' &&
      (TEAM_ERROR_CODES as readonly string[]).includes(row.restitchBlockedCode)
        ? (row.restitchBlockedCode as TeamErrorCode)
        : null,
    serverNow: row.serverNow
  };
}

/** A malformed publication note hides the note, never the row. */
function catalogRowPublicationFrom(value: unknown): CatalogRowPublication | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.due_at !== 'string' ||
    !Number.isFinite(Date.parse(row.due_at)) ||
    typeof row.time_zone !== 'string' ||
    row.time_zone.length > 64 ||
    typeof row.waiting_for_videos !== 'boolean'
  )
    return null;
  return { dueAt: row.due_at, timeZone: row.time_zone, waitingForVideos: row.waiting_for_videos };
}

function catalogRegistryRowFrom(value: unknown): CatalogRegistryRow | null {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.catalog_id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.sheet_url !== 'string' ||
    !/^https:\/\//u.test(row.sheet_url) ||
    typeof row.video_id !== 'string' ||
    typeof row.video_name !== 'string' ||
    typeof row.product_count !== 'number' ||
    !Number.isSafeInteger(row.product_count) ||
    row.product_count < 0 ||
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    typeof row.update_count !== 'number' ||
    !Number.isSafeInteger(row.update_count) ||
    row.update_count < 0 ||
    (row.last_updated_at != null &&
      (typeof row.last_updated_at !== 'string' ||
        !Number.isFinite(Date.parse(row.last_updated_at)))) ||
    (row.next_run_at != null &&
      (typeof row.next_run_at !== 'string' || !Number.isFinite(Date.parse(row.next_run_at)))) ||
    (row.update_interval != null && parseUpdaterInterval(row.update_interval) === null) ||
    (Object.prototype.hasOwnProperty.call(row, 'update_pending') &&
      typeof row.update_pending !== 'boolean') ||
    (Object.prototype.hasOwnProperty.call(row, 'active_round_at') &&
      row.active_round_at !== null &&
      (typeof row.active_round_at !== 'string' ||
        !Number.isFinite(Date.parse(row.active_round_at)))) ||
    typeof row.in_updater !== 'boolean'
  ) {
    return null;
  }
  return {
    catalogId: row.catalog_id,
    name: row.name,
    sheetUrl: row.sheet_url,
    videoId: row.video_id,
    videoName: row.video_name,
    folderName: typeof row.folder_name === 'string' ? row.folder_name : null,
    productCount: row.product_count,
    createdAt: row.created_at,
    lastUpdatedAt: typeof row.last_updated_at === 'string' ? row.last_updated_at : null,
    updateCount: row.update_count,
    inUpdater: row.in_updater,
    lastUpdateError: typeof row.last_update_error === 'string' ? row.last_update_error : null,
    updateInterval: parseUpdaterInterval(row.update_interval),
    nextRunAt: typeof row.next_run_at === 'string' ? row.next_run_at : null,
    updatePending: row.update_pending === true,
    updateStage:
      row.update_stage === 'waiting_video' ||
      row.update_stage === 'restitching' ||
      row.update_stage === 'preparing' ||
      row.update_stage === 'refreshing' ||
      row.update_stage === 'building' ||
      row.update_stage === 'uploading' ||
      row.update_stage === 'verifying' ||
      row.update_stage === 'finalizing'
        ? row.update_stage
        : null,
    ...(Object.prototype.hasOwnProperty.call(row, 'active_round_at')
      ? {
          activeRoundAt: typeof row.active_round_at === 'string' ? row.active_round_at : null,
          activeAttemptId: typeof row.active_attempt_id === 'string' ? row.active_attempt_id : null,
          progressAttemptId:
            typeof row.progress_attempt_id === 'string' ? row.progress_attempt_id : null,
          restitchOperationId:
            typeof row.restitch_operation_id === 'string' ? row.restitch_operation_id : null
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(row, 'video_generation')
      ? { videoGeneration: parseCatalogVideoRowProgress(row.video_generation) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(row, 'video_publication')
      ? { videoPublication: catalogRowPublicationFrom(row.video_publication) }
      : {}),
    restitchProgress:
      typeof row.restitch_progress === 'number' &&
      Number.isInteger(row.restitch_progress) &&
      row.restitch_progress >= 0 &&
      row.restitch_progress <= 100
        ? row.restitch_progress
        : null,
    restitchStage:
      row.restitch_stage === 'downloading' ||
      row.restitch_stage === 'processing' ||
      row.restitch_stage === 'uploading' ||
      row.restitch_stage === 'finalizing'
        ? row.restitch_stage
        : null,
    folderDriveId: typeof row.folder_drive_id === 'string' ? row.folder_drive_id : null
  };
}

function productCatalogSettingsFrom(value: unknown): ProductCatalogSettings | null {
  const row = asRecord(value);
  const optional = (value: unknown) => (typeof value === 'string' ? value : null);
  if (
    !row ||
    !(row.title === null || typeof row.title === 'string') ||
    !(row.description === null || typeof row.description === 'string') ||
    typeof row.price !== 'number' ||
    !Number.isInteger(row.price) ||
    !(row.image_link === null || typeof row.image_link === 'string') ||
    typeof row.updated_at !== 'string'
  ) {
    return null;
  }
  return {
    title: optional(row.title),
    description: optional(row.description),
    price: row.price,
    priceMin: typeof row.price_min === 'number' ? row.price_min : row.price,
    priceMax: typeof row.price_max === 'number' ? row.price_max : row.price,
    imageLink: optional(row.image_link),
    updatedAt: row.updated_at
  };
}

function productCatalogCreateGuard(value: unknown): value is ProductCatalogCreateResult {
  const row = asRecord(value);
  const catalog = asRecord(row?.catalog);
  return Boolean(
    row &&
    catalog &&
    ['created', 'recreated', 'existing'].includes(String(row.outcome)) &&
    typeof row.videoShared === 'boolean' &&
    (row.videoGeneration === undefined ||
      (isCatalogCreatedVideoProgress(row.videoGeneration) &&
        row.videoGeneration.requestedCount <= Number(catalog.productCount))) &&
    (row.videoGenerationObservation === undefined ||
      (isCatalogCreatedVideoProgress(row.videoGenerationObservation) &&
        row.videoGenerationObservation.requestedCount <= Number(catalog.productCount) &&
        (row.videoGeneration === undefined ||
          row.videoGeneration.videoSetId === row.videoGenerationObservation.videoSetId))) &&
    typeof catalog.materialId === 'string' &&
    typeof catalog.name === 'string' &&
    typeof catalog.sheetUrl === 'string' &&
    /^https:\/\//u.test(catalog.sheetUrl) &&
    typeof catalog.sourceLink === 'string' &&
    typeof catalog.productCount === 'number' &&
    (catalog.createdAt === null || typeof catalog.createdAt === 'string')
  );
}

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
  guard: UnknownGuard<T>,
  options: { method?: 'GET' | 'POST'; signal?: AbortSignal } = {}
): Promise<T> {
  const supabase = requireSupabaseClient();
  const { data, error } = await supabase.functions.invoke(
    functionName,
    options.method === 'GET'
      ? { method: 'GET', ...(options.signal ? { signal: options.signal } : {}) }
      : { body, ...(options.signal ? { signal: options.signal } : {}) }
  );
  let payload = data;
  if (error && data === null) {
    payload = await envelopeFromInvokeError(error);
    // A transport failure carries no envelope at all; that alone is retryable.
    if (payload === null) {
      if (error instanceof FunctionsFetchError)
        throw new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true);
      throw new TeamApiError('DRIVE_UNAVAILABLE', true);
    }
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

/** Safe assignment labels, without management-only identity or permission fields. */
export type TeamAssigneeSummary = Pick<TeamMemberSummary, 'userId' | 'displayName'>;

export interface TeamAuditEventSummary {
  id: string;
  actorLabel: string | null;
  /** Who did it, for "Mine" (024); null from an older server. */
  actorId?: string | null;
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
      | 'warning_code'
      | 'task_id'
      | 'task_title'
      | 'from'
      | 'to'
      | 'agent'
      | 'note',
      string
    >
  >;
  result: 'succeeded' | 'denied' | 'failed' | 'canceled';
  errorCode: TeamErrorCode | null;
  occurredAt: string;
  /**
   * The thing it happened to — a file's name, an invitation's address. Null for
   * events about the space itself. Without it three cancelled jobs read as
   * three identical lines, which is what made the history unreadable.
   */
  subjectLabel: string | null;
}

export interface DriveConnectionStatus {
  connectionId: string | null;
  state: TeamContextSnapshot['connectionState'];
  rootFolderName: string | null;
  /** The folder's Drive id, so the settings can open it in Drive (024). */
  rootFolderId?: string | null;
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
  /** Present when the request was made with a key (028, release B). */
  requestId?: string;
  outcome?: string;
}

function catalogResyncAcceptance(value: unknown): DriveCatalogResyncResult {
  const row = Array.isArray(value) && value.length === 1 ? asRecord(value[0]) : null;
  if (
    !row ||
    typeof row.sync_job_id !== 'string' ||
    !row.sync_job_id ||
    row.initial_sync_state !== 'scanning'
  ) {
    throw new TeamApiError('INVALID_RESPONSE', false);
  }
  return {
    syncJobId: row.sync_job_id,
    initialSyncState: 'scanning',
    ...(typeof row.request_id === 'string' ? { requestId: row.request_id } : {}),
    ...(typeof row.outcome === 'string' ? { outcome: row.outcome } : {})
  };
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
  /** With a folder: that folder and every folder under it, not only its own rows. */
  recursive?: boolean;
}

/**
 * Whether this server's `search_materials` takes `p_recursive` (search rework,
 * 2026-10). Unknown until the first recursive search; a server that predates
 * the parameter answers PGRST202, and from then on the folder is searched on
 * its own rather than failing every search in it.
 */
let searchTakesRecursive: boolean | null = null;

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
  /** Shared landing render state, retained when the Explorer opens a material. */
  landingRender?: { state: 'ready' | 'rendering' | 'stale' | 'failed' | 'none' };
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
  /** Overwrite: upload the result as a new Drive version of this material (must equal materialId). */
  versionOfMaterialId?: string;
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

/** What a folder holds for the batch, and how far the read got. */
export interface FolderSubtree {
  videos: TeamMaterialSummary[];
  landings: TeamMaterialSummary[];
  /** Folders passed through, the starting folder included. */
  foldersVisited: number;
  /** True when the ceiling stopped the read before the tree ran out. */
  truncated: boolean;
}

export interface LibraryRequirementScanResult {
  created: {
    transcription: number;
    landingOptimization: number;
  };
  missing: {
    transcription: number;
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
  'task_title',
  'from',
  'to',
  'agent',
  'note'
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
    !['succeeded', 'denied', 'failed', 'canceled'].includes(String(result)) ||
    typeof row.occurred_at !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    actorLabel: typeof row.actor_label === 'string' ? row.actor_label : null,
    subjectLabel: typeof row.subject_label === 'string' ? row.subject_label : null,
    action: row.action,
    /* The keys this build knows, as strings; anything newer is left out rather than refusing
       the whole history (024): a server that learned a new detail emptied the panel before. */
    target: Object.fromEntries(
      Object.entries(target).filter(
        ([key, entry]) => AUDIT_TARGET_KEYS.has(key) && typeof entry === 'string'
      )
    ) as TeamAuditEventSummary['target'],
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
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

/**
 * A call the caller cut short with an `AbortSignal`. supabase-js reports the
 * abort as an ordinary `{ error }` whose message starts with the DOM name, so
 * it would otherwise surface as `INVALID_RESPONSE` and be mistaken for a bad
 * server answer. The shared error-code set is not widened for this: nobody
 * but the aborting caller ever sees it.
 */
export class RequestAbortedError extends Error {
  constructor() {
    super('AbortError');
    this.name = 'AbortError';
  }
}

export function isRequestAborted(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Attaches the caller's signal to a PostgREST builder when there is one. */
function abortable<T extends { abortSignal: (signal: AbortSignal) => T }>(
  builder: T,
  options: { signal?: AbortSignal }
): T {
  return options.signal ? builder.abortSignal(options.signal) : builder;
}

function throwRpc(error: { message: string; code?: string } | null): void {
  if (!error) return;
  if (/^AbortError\b/.test(error.message)) throw new RequestAbortedError();
  // PostgREST wraps rejected fetches as a status-0 error with an empty code.
  // Recognize only its known browser transport messages, never SQL text alone.
  if (
    !error.code &&
    /^TypeError: (?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/u.test(
      error.message
    )
  )
    throw new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true);
  // A unique index that fired before the function's own check could — two
  // people naming the same account in the same second — arrives as bare
  // SQLSTATE 23505 with no uppercase token in it. It means the same thing.
  if (error.code === '23505') throw new TeamApiError('NAME_CONFLICT', false);
  const candidates = [error.message, error.code ?? ''].flatMap(
    value => value.match(/[A-Z][A-Z0-9_]+/g) ?? []
  );
  const code = TEAM_ERROR_CODES.find(known => candidates.includes(known));
  if (code === 'PERMISSION_DENIED' || code === 'SPACE_BLOCKED') requestSpaceAccessRecheck();
  // A slow or overloaded server (statement timeout, pool exhaustion, a 5xx from the
  // gateway) says nothing about the request itself: it must stay retryable, or a
  // caller that closes on a permanent failure throws away an open dialog (1.4.3).
  if (!code && isTransientServerFailure(error))
    throw new TeamApiError('TEAM_TRANSPORT_UNAVAILABLE', true);
  throw new TeamApiError(code ?? 'INVALID_RESPONSE', false);
}

/** SQLSTATEs and PostgREST codes for a server that is busy, not for a bad request. */
const TRANSIENT_SERVER_CODES = new Set([
  '57014', // statement timeout / query canceled
  '57P01',
  '57P02',
  '57P03', // server shutting down / restarting
  '53300',
  '53400', // too many connections / configuration limit
  '08000',
  '08001',
  '08003',
  '08004',
  '08006', // connection failures
  '40001',
  '40P01', // serialization failure / deadlock — safe to retry
  'PGRST000',
  'PGRST001',
  'PGRST002',
  'PGRST003' // PostgREST could not reach the database in time
]);

function isTransientServerFailure(error: { message: string; code?: string }): boolean {
  if (error.code && TRANSIENT_SERVER_CODES.has(error.code)) return true;
  if (error.code) return false;
  // A gateway answer has no PostgREST code; its body names the status instead.
  return /\b(?:50[234]|52[0-4]|Bad Gateway|Service Unavailable|Gateway Time-?out|upstream (?:request )?timeout|timed out|statement timeout)\b/iu.test(
    error.message
  );
}
/** One authenticated, abortable RPC seam; each consumer still validates its own payload. */
export async function invokeTeamRpc<
  Name extends keyof Database['public']['Functions'],
  Args extends Database['public']['Functions'][NoInfer<Name>]['Args']
>(name: Name, args: Args, options: { signal?: AbortSignal } = {}): Promise<unknown> {
  const { data, error } = await withFreshSession(
    () => abortable(requireSupabaseClient().rpc(name, args), options),
    options
  );
  throwRpc(error);
  return data;
}

/**
 * 034 — a refusal may mean the space was just paused (or opened). The access
 * hook listens for this and asks again, so an open tab learns within seconds
 * rather than at the next reload (FR-018).
 */
export const SPACE_ACCESS_RECHECK_EVENT = 'soty:space-access-recheck';

/**
 * Asks the server to look for Drive changes now when this space's sync has
 * gone idle (an idle space's Drive feed is polled less and less often, up to
 * every 10 minutes). Best effort: a failure only means the next poll comes at
 * its usual time.
 */
export async function wakeCatalogSync(teamId: string): Promise<void> {
  try {
    await requireSupabaseClient().rpc('wake_team_catalog_sync', { p_team: teamId });
  } catch {
    // No client or no session: nothing to wake.
  }
}

export function requestSpaceAccessRecheck(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SPACE_ACCESS_RECHECK_EVENT));
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

function workspaceFolderGuard(
  value: unknown
): value is { folderId: string; created: boolean; name: string } {
  const row = asRecord(value);
  return Boolean(
    row &&
    typeof row.folderId === 'string' &&
    row.folderId.length > 0 &&
    typeof row.created === 'boolean' &&
    typeof row.name === 'string'
  );
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
    !Number.isFinite(Date.parse(row.trashed_at)) ||
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
  // The list and detail reads carry the tags; a write RPC returns the bare row
  // and the caller keeps the tags it already has (as it does attachmentCount).
  const agents = parseTeamTaskAgentTags(row.agents);
  if (agents === null) return null;
  const labels = parseTeamTaskLabelRefs(row.labels);
  if (labels === null) return null;
  const dateOn = row.task_date ?? null;
  if (dateOn !== null && !isTeamTaskDate(dateOn)) return null;
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
    agents,
    labels,
    dateOn,
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
    created.landingOptimization,
    missing.transcription,
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
      landingOptimization: created.landingOptimization as number
    },
    missing: {
      transcription: missing.transcription as number,
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
    !['transcription', 'landing_optimization'].includes(String(row.kind)) ||
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

/** What the settings panel saves: the stitcher's own controls plus where the pictures come from. */
export type RestitchDefaultsInput = Pick<
  TeamRestitchDefaults,
  | 'operation'
  | 'startImageIds'
  | 'endImageIds'
  | 'fitMode'
  | 'finalDurationMode'
  | 'customFinalDurationSeconds'
> &
  Partial<
    Pick<
      TeamRestitchDefaults,
      'startEnabled' | 'endEnabled' | 'startDurationMode' | 'customStartDurationMs' | 'sourceMode'
    >
  >;

export const teamApi = {
  catalogImages: catalogImageClient,
  getGlobalCatalogImageReadiness,
  catalogVideoR2: catalogVideoR2Client,
  async listTeams(options: { signal?: AbortSignal } = {}): Promise<TeamContextSnapshot[]> {
    const data = (await invokeTeamRpc('list_my_teams', {}, options)) ?? [];
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    const teams = data.map(mapTeamContext);
    if (teams.some(team => team === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    return teams.filter((team): team is TeamContextSnapshot => team !== null);
  },

  async createTeam(name: string): Promise<TeamContextSnapshot> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('create_team', { p_name: name })
    );
    throwRpc(error);
    const team = mapTeamContext(data?.[0]);
    if (!team) throw new TeamApiError('INVALID_RESPONSE', false);
    return team;
  },

  /** Renames a space (024); owner only. Returns the name as stored. */
  async renameTeam(teamId: string, name: string): Promise<string> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('rename_team', { p_team: teamId, p_name: name })
    );
    throwRpc(error);
    if (typeof data !== 'string') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async listAssignees(
    teamId: string,
    options?: { signal?: AbortSignal }
  ): Promise<TeamAssigneeSummary[]> {
    const attempt = memberAttempt('assignees_list', crypto.randomUUID());
    try {
      // The existing projection is view-gated and shared with Launches.
      const { data, error } = await withFreshSession(() => {
        const query = requireSupabaseClient().rpc('list_launch_assignees', { p_team: teamId });
        return options?.signal ? query.abortSignal(options.signal) : query;
      });
      throwRpc(error);
      if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
      const result = data.map(value => {
        const row = asRecord(value);
        if (
          !row ||
          typeof row.user_id !== 'string' ||
          (row.display_name !== null && typeof row.display_name !== 'string')
        )
          throw new TeamApiError('INVALID_RESPONSE', false);
        return { userId: row.user_id, displayName: row.display_name };
      });
      attempt.finish('success');
      return result;
    } catch (cause) {
      attempt.finish(isRequestAborted(cause) ? 'cancelled' : 'failure', cause);
      throw cause;
    }
  },

  async listMembers(
    teamId: string,
    options?: { signal?: AbortSignal }
  ): Promise<TeamMemberSummary[]> {
    const { data, error } = await withFreshSession(() => {
      const query = requireSupabaseClient().rpc('list_team_members', {
        p_team: teamId
      });
      return options?.signal ? query.abortSignal(options.signal) : query;
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('update_membership', {
        p_team: input.teamId,
        p_member: input.userId,
        p_base_role: input.baseRole,
        p_overrides: input.permissionOverrides
      })
    );
    throwRpc(error);
    const member = mapMember(data?.[0]);
    if (!member) throw new TeamApiError('INVALID_RESPONSE', false);
    return member;
  },

  async removeMember(
    teamId: string,
    userId: string
  ): Promise<{ ok: true; warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('remove_member', {
        p_team: teamId,
        p_member: userId
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('transfer_ownership', {
        p_team: input.teamId,
        p_to_user: input.toUserId,
        p_demote_to: input.demoteTo
      })
    );
    throwRpc(error);
    const team = mapTeamContext(data?.[0]);
    if (!team) throw new TeamApiError('INVALID_RESPONSE', false);
    return team;
  },

  async listAuditEvents(
    teamId: string,
    options: { limit?: number; before?: string } = {}
  ): Promise<TeamAuditEventSummary[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_audit_events', {
        p_team: teamId,
        p_limit: options.limit ?? 50,
        ...(options.before ? { p_before: options.before } : {})
      })
    );
    throwRpc(error);
    const events = (data ?? []).map(mapAuditEvent);
    if (events.some(event => event === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return events.filter((event): event is TeamAuditEventSummary => event !== null);
  },

  async listInvitations(teamId: string): Promise<TeamInvitationSummary[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_invitations', {
        p_team: teamId
      })
    );
    throwRpc(error);
    const invitations = (data ?? []).map(mapInvitation);
    if (invitations.some(invitation => invitation === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return invitations.filter((item): item is TeamInvitationSummary => item !== null);
  },
  /**
   * Whether this person may have a space at all (024, US28).
   *
   * The workspace opens gradually: the database decides, and until it says yes there is nothing
   * to create. The home screen asks so it can offer the truth — a way onto the list — instead of
   * a "create your first space" button that ends at a gate. Never throws: a refusal, a missing
   * session or a network failure all mean "not yet", because this only decides what to offer.
   */
  async canAccessTeamWorkspace(): Promise<boolean> {
    try {
      const { data, error } = await requireSupabaseClient().rpc('can_access_team_workspace');
      return !error && data === true;
    } catch {
      return false;
    }
  },

  /**
   * 034 — a space that left `list_my_teams` while this person is still its
   * member is paused, not lost. Never throws: unknown reads as "not paused",
   * which is the older behaviour.
   */
  /**
   * 034 — the access reply, or — where the database does not have it yet — the
   * pre-tariff yes/no question dressed as one. Never throws.
   */
  async getMySpaceAccess(): Promise<SpaceAccess> {
    try {
      return await spaceTariffApi.getMySpaceAccess();
    } catch {
      return fallbackSpaceAccess(await teamApi.canAccessTeamWorkspace());
    }
  },

  /** 034 — seats and term of one space, for the invitation panel and settings. */
  async getTeamTariff(teamId: string): Promise<TeamTariff> {
    return spaceTariffApi.getTeamTariff(teamId);
  },

  async isTeamPaused(teamId: string): Promise<boolean> {
    try {
      const access = await spaceTariffApi.getMySpaceAccess();
      return access.teams.some(team => team.teamId === teamId && team.accessState === 'blocked');
    } catch {
      return false;
    }
  },

  async listMyInvitations(): Promise<TeamInvitationSummary[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_my_invitations')
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('accept_invitation', {
        p_invitation: invitationId,
        ...(token ? { p_plain_token: token } : {})
      })
    );
    throwRpc(error);
    const team = mapTeamContext(data?.[0]);
    if (!team) throw new TeamApiError('INVALID_RESPONSE', false);
    return team;
  },

  async declineInvitation(invitationId: string, token?: string): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('decline_invitation', {
        p_invitation: invitationId,
        ...(token ? { p_plain_token: token } : {})
      })
    );
    throwRpc(error);
  },

  async getConnectionStatus(teamId: string): Promise<DriveConnectionStatus> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_drive_connection_status', {
        p_team: teamId
      })
    );
    throwRpc(error);
    const row = data?.[0] as Record<string, unknown> | undefined;
    if (!row || typeof row.state !== 'string') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return {
      connectionId: typeof row.connection_id === 'string' ? row.connection_id : null,
      state: row.state as DriveConnectionStatus['state'],
      rootFolderName: typeof row.root_folder_name === 'string' ? row.root_folder_name : null,
      rootFolderId: typeof row.root_folder_id === 'string' ? row.root_folder_id : null,
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

  async getTranscriptDeletePref(): Promise<'ask' | 'delete' | 'keep'> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_transcript_delete_pref')
    );
    throwRpc(error);
    return data === 'delete' || data === 'keep' ? data : 'ask';
  },

  async setTranscriptDeletePref(pref: 'ask' | 'delete' | 'keep'): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_transcript_delete_pref', {
        p_pref: pref
      })
    );
    throwRpc(error);
  },

  /** The space's starting "Maximum" for a new task — the same for whoever creates it. */
  async getTaskProgressMaxDefault(teamId: string): Promise<number> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_task_progress_max_default', { p_team: teamId })
    );
    throwRpc(error);
    return typeof data === 'number' && Number.isFinite(data) ? data : 100;
  },

  async setTaskProgressMaxDefault(teamId: string, value: number): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_task_progress_max_default', {
        p_team: teamId,
        p_value: value
      })
    );
    throwRpc(error);
  },

  /**
   * Says that a .txt is the transcript of a video — the caller-authorized half
   * of the companion link, used when a copy needs its own text attached to the
   * copy of the video.
   */
  async linkTranscriptCompanion(
    teamId: string,
    videoId: string,
    companionId: string
  ): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('link_transcript_companion', {
        p_team: teamId,
        p_video: videoId,
        p_companion: companionId
      })
    );
    throwRpc(error);
    return (
      typeof data === 'object' && data !== null && (data as { linked?: unknown }).linked === true
    );
  },

  /**
   * A transcript another video in the space already holds for the same bytes or the same
   * decoded audio (012, FR-T2), or null. A server without the function answers "nothing to
   * reuse", so the caller transcribes as it always did.
   */
  async findReusableTranscript(
    teamId: string,
    videoId: string
  ): Promise<{ id: string; name: string; videoId: string } | null> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('find_reusable_transcript', {
        p_team: teamId,
        p_video: videoId
      })
    );
    if (error) return null;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const row = data as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.videoId !== 'string') return null;
    return { id: row.id, name: typeof row.name === 'string' ? row.name : '', videoId: row.videoId };
  },

  async getTranscriptCompanion(
    teamId: string,
    materialId: string
  ): Promise<{ id: string; name: string; ingestState: string; hasText: boolean } | null> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_material_transcript_companion', {
        p_team: teamId,
        p_material: materialId
      })
    );
    throwRpc(error);
    const row = data?.[0] as Record<string, unknown> | undefined;
    if (!row || typeof row.id !== 'string') return null;
    return {
      id: row.id,
      name: typeof row.name === 'string' ? row.name : '',
      ingestState: typeof row.ingest_state === 'string' ? row.ingest_state : 'pending',
      hasText: row.has_text === true
    };
  },

  /** Every live catalog of a video — its variations (024, US15) — by number. */
  async listProductCatalogs(teamId: string, videoId: string): Promise<ProductCatalogSummary[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_material_product_catalogs', {
        p_team: teamId,
        p_video: videoId
      })
    );
    throwRpc(error);
    return (Array.isArray(data) ? data : []).flatMap(value => {
      const row = asRecord(value);
      if (
        !row ||
        typeof row.id !== 'string' ||
        typeof row.name !== 'string' ||
        typeof row.sheet_url !== 'string' ||
        !/^https:\/\//u.test(row.sheet_url) ||
        typeof row.source_link !== 'string' ||
        typeof row.product_count !== 'number' ||
        typeof row.created_at !== 'string'
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          name: row.name,
          sheetUrl: row.sheet_url,
          sourceLink: row.source_link,
          productCount: row.product_count,
          variant: typeof row.variant === 'number' ? row.variant : 1,
          createdAt: row.created_at
        }
      ];
    });
  },

  /** 1.4.3 — the caller's own creations for a video that have not finished yet. */
  async listUnfinishedProductCatalogCreations(
    teamId: string,
    videoId: string
  ): Promise<UnfinishedCatalogCreation[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_my_unfinished_product_catalog_creations', {
        p_team: teamId,
        p_video: videoId
      })
    );
    throwRpc(error);
    return (Array.isArray(data) ? data : []).flatMap(value => {
      const row = unfinishedCatalogCreationFrom(value);
      return row ? [row] : [];
    });
  },

  async listCatalogManagerSnapshot(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogListSnapshot<CatalogRegistryRow>> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_catalog_manager_snapshot', { p_team: teamId }),
        options
      )
    );
    throwRpc(error);
    const payload = asRecord(data);
    if (!payload) throw new TeamApiError('INVALID_RESPONSE', false);
    if (
      payload.observed_at !== undefined &&
      (typeof payload.observed_at !== 'string' || !Number.isFinite(Date.parse(payload.observed_at)))
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    const observation =
      typeof payload.observed_at === 'string' ? { runtimeObservedAt: payload.observed_at } : {};
    const catalogs = catalogListSnapshotFrom(payload.catalogs, catalogRegistryRowFrom);
    const profiles = catalogListSnapshotFrom(payload.profiles, value =>
      catalogUpdateProfileFrom(value, true)
    );
    const byId = new Map(profiles.rows.map(profile => [profile.catalogId, profile]));
    let invalidRowCount = catalogs.invalidRowCount + profiles.invalidRowCount;
    const rows = catalogs.rows.flatMap(row => {
      const profile = byId.get(row.catalogId);
      if (!profile) {
        invalidRowCount += 1;
        return [];
      }
      return [{ ...row, profile, ...observation }];
    });
    return { rows, invalidRowCount };
  },

  async listTeamProductCatalogSnapshot(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogListSnapshot<CatalogRegistryRow>> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_product_catalogs', { p_team: teamId }),
        options
      )
    );
    throwRpc(error);
    return catalogListSnapshotFrom(data, catalogRegistryRowFrom);
  },

  async listCatalogUpdateProfileSnapshot(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogListSnapshot<CatalogUpdateProfile>> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_catalog_update_profiles', { p_team: teamId }),
        options
      )
    );
    throwRpc(error);
    return catalogListSnapshotFrom(data, value => catalogUpdateProfileFrom(value, true));
  },

  async listTeamProductCatalogs(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogRegistryRow[]> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_product_catalogs', { p_team: teamId }),
        options
      )
    );
    throwRpc(error);
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data.map(row => {
      const parsed = catalogRegistryRowFrom(row);
      if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
      return parsed;
    });
  },

  async listCatalogUpdateProfiles(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogUpdateProfile[]> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_catalog_update_profiles', { p_team: teamId }),
        options
      )
    );
    throwRpc(error);
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data.map(row => {
      const profile = catalogUpdateProfileFrom(row, true);
      if (!profile) throw new TeamApiError('INVALID_RESPONSE', false);
      return profile;
    });
  },

  async listCatalogUpdateAttempts(
    teamId: string,
    catalogId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogUpdateAttempt[]> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_catalog_update_attempts', {
          p_team: teamId,
          p_catalog: catalogId,
          p_limit: 10
        }),
        options
      )
    );
    throwRpc(error);
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    const allowed = new Set(['running', 'success', 'partial', 'failed', 'cancelled', 'unknown']);
    const attempts = data.flatMap<CatalogUpdateAttempt>(value => {
      const row = asRecord(value);
      if (
        !row ||
        typeof row.attempt_id !== 'string' ||
        row.catalog_material_id !== catalogId ||
        (row.trigger_kind !== 'schedule' &&
          row.trigger_kind !== 'manual' &&
          row.trigger_kind !== 'retry' &&
          row.trigger_kind !== 'unknown') ||
        typeof row.started_at !== 'string' ||
        !Number.isFinite(Date.parse(row.started_at)) ||
        (row.ended_at != null &&
          (typeof row.ended_at !== 'string' || !Number.isFinite(Date.parse(row.ended_at)))) ||
        (row.delivery_verified_at != null &&
          (typeof row.delivery_verified_at !== 'string' ||
            !Number.isFinite(Date.parse(row.delivery_verified_at)))) ||
        (row.profile_version != null &&
          (typeof row.profile_version !== 'number' ||
            !Number.isSafeInteger(row.profile_version) ||
            row.profile_version < 1)) ||
        typeof row.result !== 'string' ||
        !allowed.has(row.result)
      )
        return [];
      return [
        {
          attemptId: row.attempt_id,
          catalogId: row.catalog_material_id,
          trigger: row.trigger_kind,
          startedAt: row.started_at,
          endedAt: typeof row.ended_at === 'string' ? row.ended_at : null,
          stage: null,
          stages: Array.isArray(row.stage_history)
            ? row.stage_history.flatMap(value => {
                const stage = asRecord(value);
                return stage &&
                  typeof stage.stage === 'string' &&
                  [
                    'preparing',
                    'refreshing',
                    'building',
                    'uploading',
                    'verifying',
                    'finalizing'
                  ].includes(stage.stage) &&
                  typeof stage.at === 'string' &&
                  Number.isFinite(Date.parse(stage.at))
                  ? [
                      {
                        stage: stage.stage as NonNullable<
                          CatalogUpdateAttempt['stages']
                        >[number]['stage'],
                        at: stage.at
                      }
                    ]
                  : [];
              })
            : [],
          result: row.result as CatalogUpdateAttempt['result'],
          failureCode: typeof row.failure_code === 'string' ? row.failure_code : null,
          deliveryVerifiedAt:
            typeof row.delivery_verified_at === 'string' ? row.delivery_verified_at : null,
          profileVersion: typeof row.profile_version === 'number' ? row.profile_version : null,
          sourceAttemptId: typeof row.source_attempt_id === 'string' ? row.source_attempt_id : null,
          actualChanges: (() => {
            const changes = asRecord(row.actual_changes);
            if (!changes) return null;
            const parsed: NonNullable<CatalogUpdateAttempt['actualChanges']> = {};
            for (const key of [
              'productIds',
              'linksVaried',
              'imagesRefreshed',
              'textsRefreshed',
              'productsAdded',
              'videoReplaced'
            ] as const) {
              if (typeof changes[key] === 'boolean') parsed[key] = changes[key];
            }
            return parsed;
          })(),
          profileSnapshot: (() => {
            const snapshot = asRecord(row.profile_snapshot);
            if (
              !snapshot ||
              typeof snapshot.refreshImages !== 'boolean' ||
              typeof snapshot.refreshTexts !== 'boolean' ||
              typeof snapshot.growProducts !== 'boolean' ||
              typeof snapshot.randomLinkVariation !== 'boolean' ||
              typeof snapshot.restitch !== 'boolean'
            )
              return null;
            return {
              refreshImages: snapshot.refreshImages,
              refreshTexts: snapshot.refreshTexts,
              growProducts: snapshot.growProducts,
              randomLinkVariation: snapshot.randomLinkVariation,
              restitch: snapshot.restitch
            };
          })()
        }
      ];
    });
    if (attempts.length !== data.length) throw new TeamApiError('INVALID_RESPONSE', false);
    return attempts;
  },

  async patchCatalogUpdateProfile(
    teamId: string,
    catalogId: string,
    expectedVersion: number,
    patch: CatalogUpdateProfilePatch,
    options?: CatalogMutationOptions
  ): Promise<CatalogUpdateProfile> {
    const actor = catalogMutationActor(options);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('patch_team_catalog_update_profile_as_actor', {
            p_team: teamId,
            p_catalog: catalogId,
            p_expected_version: expectedVersion,
            p_patch: {
              ...patch,
              schedule: patch.schedule ? { ...patch.schedule } : patch.schedule
            },
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    const parsed = catalogUpdateProfileFrom(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async getCatalogUpdater(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogUpdaterState> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('get_team_catalog_updater', { p_team: teamId }),
        options
      )
    );
    throwRpc(error);
    const parsed = catalogUpdaterStateFrom(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  /** The next spare copy this member's computer should prepare, or null (023). */
  async claimRestitchJob(
    teamId: string,
    screenRefusals: Array<{
      slot: 'start' | 'end';
      materialId: string;
      checksum: string;
      settingsRevision?: string;
    }> = [],
    installedContractVersion = 1,
    options?: CatalogMutationOptions
  ): Promise<RestitchClaim | null> {
    if (
      !Number.isSafeInteger(installedContractVersion) ||
      installedContractVersion < 1 ||
      installedContractVersion > RESTITCH_CONTRACT_VERSION
    )
      throw new TeamApiError('INVALID_INPUT', false);
    const actor = catalogMutationActor(options);
    const value = await invokeTeamFunction(
      'drive-ops/updater/claim-as-actor',
      // Advertise only the intersection of this page and its actual installed executor.
      {
        teamId,
        expectedActorId: actor,
        restitchContractVersion: installedContractVersion,
        ...(screenRefusals.length ? { screenRefusals } : {})
      },
      restitchClaimGuard
    );
    const job = value.job;
    if (!job || !Array.isArray(job.options.screens)) return job;
    return {
      ...job,
      options: {
        ...job.options,
        screens: job.options.screens.map((screen: unknown) => {
          const row = asRecord(screen);
          const transfer = asRecord(row?.transfer);
          if (!row || !transfer || typeof transfer.transferUrl !== 'string') return screen;
          return {
            ...row,
            transfer: { ...transfer, transferUrl: browserFunctionUrl(transfer.transferUrl) }
          };
        })
      }
    };
  },

  /** Keeps the lease; true means the updater no longer wants this copy. */
  async heartbeatRestitchJob(
    jobId: string,
    leaseToken: string,
    progress?: {
      progress: number;
      stage: 'downloading' | 'processing' | 'uploading' | 'finalizing';
    }
  ): Promise<boolean> {
    const value = await invokeTeamFunction(
      'drive-ops/updater/heartbeat',
      { jobId, leaseToken, ...progress },
      cancelGuard
    );
    return value.cancel;
  },

  async completeRestitchJob(input: {
    jobId: string;
    leaseToken: string;
    outcome: 'finalized' | 'failed';
    errorCode: string | null;
  }): Promise<boolean> {
    const value = await invokeTeamFunction(
      'drive-ops/updater/complete',
      { ...input },
      recordedGuard
    );
    return value.recorded;
  },

  /** Puts catalogs on an interval, changes it, or — with null — takes them off (024). */
  async setCatalogUpdateInterval(
    teamId: string,
    catalogIds: string[],
    interval: CatalogUpdaterInterval | null
  ): Promise<CatalogUpdaterState> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_catalog_update_interval', {
        p_team: teamId,
        p_catalogs: catalogIds,
        p_interval: interval
      })
    );
    throwRpc(error);
    const parsed = catalogUpdaterStateFrom(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  /** Records exactly one actor-bound intent. Acceptance is not provider delivery. */
  async requestCatalogUpdateCommand(
    teamId: string,
    actorId: string,
    input: CatalogCommandRequest
  ): Promise<CatalogCommandReceipt> {
    const request = normalizeCatalogCommandRequest(input);
    if (!request || !isCatalogCommandUuid(actorId)) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('request_team_catalog_update_command', {
        p_team: teamId,
        p_command: request.commandId,
        p_catalogs: request.catalogIds,
        p_expected_actor: actorId.toLowerCase(),
        p_source_attempt: request.sourceAttemptId ?? null
      })
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    const receipt = parseCatalogCommandReceipt(data, request);
    if (!receipt) throw new TeamApiError('INVALID_RESPONSE', false);
    return receipt;
  },

  /** Null means no committed receipt was observed, not that an in-flight write cannot commit. */
  async getCatalogUpdateCommand(
    teamId: string,
    input: CatalogCommandRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<CatalogCommandReceipt | null> {
    const request = normalizeCatalogCommandRequest(input);
    if (!request) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('get_team_catalog_update_command', {
            p_team: teamId,
            p_command: request.commandId
          }),
          options
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    if (data === null) return null;
    const receipt = parseCatalogCommandReceipt(data, request);
    if (!receipt) throw new TeamApiError('INVALID_RESPONSE', false);
    return receipt;
  },

  /** Seals a not-yet-accepted intent, or returns its already accepted work unchanged. */
  async cancelCatalogCommandIntent(
    teamId: string,
    actorId: string,
    input: CatalogCommandRequest
  ): Promise<CatalogCommandReceipt> {
    const request = normalizeCatalogCommandRequest(input);
    if (!request || !isCatalogCommandUuid(actorId)) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('cancel_team_catalog_command_intent', {
        p_team: teamId,
        p_command: request.commandId,
        p_catalogs: request.catalogIds,
        p_expected_actor: actorId.toLowerCase(),
        p_source_attempt: request.sourceAttemptId ?? null
      })
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    const receipt = parseCatalogCommandReceipt(data, request);
    if (!receipt) throw new TeamApiError('INVALID_RESPONSE', false);
    return receipt;
  },

  /** Opens an update for catalogs this minute; resolves with how many were not already waiting. */
  async runCatalogUpdateNow(teamId: string, catalogIds: string[]): Promise<number> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('run_team_catalog_update_now', {
        p_team: teamId,
        p_catalogs: catalogIds
      })
    );
    throwRpc(error);
    if (
      typeof data !== 'number' ||
      !Number.isSafeInteger(data) ||
      data < 0 ||
      data > new Set(catalogIds).size
    ) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return data;
  },

  async cancelCatalogUpdate(
    teamId: string,
    catalogId: string,
    observed?: { roundAt: string; attemptId: string | null },
    options?: CatalogMutationOptions
  ): Promise<boolean> {
    if (observed === undefined) throw new TeamApiError('CATALOG_STOP_TARGET_UNKNOWN', false);
    if (
      !observed ||
      typeof observed.roundAt !== 'string' ||
      !Number.isFinite(Date.parse(observed.roundAt)) ||
      (observed.attemptId !== null && !isCatalogCommandUuid(observed.attemptId))
    )
      throw new TeamApiError('INVALID_INPUT', false);
    const actor = catalogMutationActor(options);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('cancel_team_catalog_update_attempt_as_actor', {
            p_team: teamId,
            p_catalog: catalogId,
            p_expected_round: observed.roundAt,
            p_expected_attempt: observed.attemptId,
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async retryCatalogUpdate(
    teamId: string,
    catalogId: string,
    sourceAttemptId: string
  ): Promise<number> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('retry_team_catalog_update', {
        p_team: teamId,
        p_catalog: catalogId,
        p_source_attempt: sourceAttemptId
      })
    );
    throwRpc(error);
    if (typeof data !== 'number' || !Number.isSafeInteger(data) || data < 0 || data > 1) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return data;
  },

  async setCatalogUpdaterRestitch(
    teamId: string,
    restitch: boolean,
    options?: CatalogMutationOptions
  ): Promise<CatalogUpdaterState> {
    const actor = catalogMutationActor(options);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('set_team_catalog_updater_restitch_as_actor', {
            p_team: teamId,
            p_restitch: restitch,
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    const parsed = catalogUpdaterStateFrom(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async getCatalogUpdaterRestitchDefault(teamId: string): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_catalog_updater_restitch_default', { p_team: teamId })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async getProductCatalogSettings(teamId: string): Promise<ProductCatalogSettings | null> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_product_catalog_settings_v3', { p_team: teamId })
    );
    throwRpc(error);
    const first = Array.isArray(data) ? data[0] : null;
    if (first === undefined || first === null) return null;
    const parsed = productCatalogSettingsFrom(first);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  async setProductCatalogSettings(
    teamId: string,
    input: {
      title: string | null;
      description: string | null;
      priceMin: number;
      priceMax: number;
      imageLink?: string | null;
    }
  ): Promise<ProductCatalogSettings> {
    const policy = await getGlobalCatalogImageReadiness(teamId);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_product_catalog_settings', {
        p_team: teamId,
        p_settings: {
          title: input.title,
          description: input.description,
          priceMin: input.priceMin,
          priceMax: input.priceMax,
          ...(policy.state === 'prepared' ? { imageLink: input.imageLink } : {})
        }
      })
    );
    throwRpc(error);
    const parsed = productCatalogSettingsFrom(data);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed;
  },

  /** The picture pool's sources — images and folders — and how many pictures each holds (024). */
  async listProductCatalogImageSources(
    teamId: string
  ): Promise<{ sources: ProductCatalogImageSource[]; poolSize: number }> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_product_catalog_image_sources', { p_team: teamId })
    );
    throwRpc(error);
    const rows = data ?? [];
    return {
      sources: rows.map(row => ({
        materialId: row.material_id,
        kind: row.kind === 'folder' ? 'folder' : 'file',
        name: row.name,
        imageCount: Number(row.image_count)
      })),
      poolSize: rows.length > 0 ? Number(rows[0]!.pool_size) : 0
    };
  },

  async setProductCatalogImageSources(
    teamId: string,
    sources: ReadonlyArray<{ materialId: string; kind: 'file' | 'folder' }>
  ): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_product_catalog_image_sources', {
        p_team: teamId,
        p_items: sources.map(source => ({ materialId: source.materialId, kind: source.kind }))
      })
    );
    throwRpc(error);
  },

  async getProductCatalogTextSchedule(teamId: string): Promise<ProductCatalogTextSchedule> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_product_catalog_text_schedule', { p_team: teamId })
    );
    throwRpc(error);
    return parseProductCatalogTextSchedule(data);
  },

  async setProductCatalogTextSchedule(
    teamId: string,
    input: { enabled: boolean; count: number }
  ): Promise<ProductCatalogTextSchedule> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_product_catalog_text_schedule', {
        p_team: teamId,
        p_enabled: input.enabled,
        p_count: input.count
      })
    );
    throwRpc(error);
    return parseProductCatalogTextSchedule(data);
  },

  async listProductCatalogTexts(teamId: string): Promise<ProductCatalogText[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_product_catalog_texts', { p_team: teamId })
    );
    throwRpc(error);
    return (data ?? []).map(row => ({
      id: row.id,
      title: row.title,
      description: row.description
    }));
  },

  async replaceProductCatalogTexts(
    teamId: string,
    texts: ReadonlyArray<{ title: string; description: string }>
  ): Promise<number> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('replace_team_product_catalog_texts', {
        p_team: teamId,
        p_items: texts.map(text => ({ title: text.title, description: text.description }))
      })
    );
    throwRpc(error);
    return typeof data === 'number' ? data : texts.length;
  },

  async updateProductCatalogText(
    teamId: string,
    text: ProductCatalogText
  ): Promise<ProductCatalogText> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('update_team_product_catalog_text', {
        p_team: teamId,
        p_id: text.id,
        p_title: text.title,
        p_description: text.description
      })
    );
    throwRpc(error);
    const row = asRecord(data);
    if (!row || typeof row.title !== 'string' || typeof row.description !== 'string') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { id: text.id, title: row.title, description: row.description };
  },

  /** The names of the pictures a catalog would draw from (024, US27). */
  async listProductCatalogPoolNames(teamId: string): Promise<string[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_product_catalog_pool_names', { p_team: teamId })
    );
    throwRpc(error);
    return (Array.isArray(data) ? data : []).flatMap(row => {
      const name = asRecord(row)?.name;
      return typeof name === 'string' ? [name] : [];
    });
  },

  async getCatalogUpdaterRefreshImages(teamId: string): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_catalog_updater_refresh_images', { p_team: teamId })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async setCatalogUpdaterRefreshImages(
    teamId: string,
    refresh: boolean,
    options?: CatalogMutationOptions
  ): Promise<boolean> {
    const actor = catalogMutationActor(options);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('set_team_catalog_updater_refresh_images_as_actor', {
            p_team: teamId,
            p_refresh: refresh,
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async getCatalogUpdaterRefreshTexts(teamId: string): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_catalog_updater_refresh_texts', { p_team: teamId })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async setCatalogUpdaterRefreshTexts(
    teamId: string,
    refresh: boolean,
    options?: CatalogMutationOptions
  ): Promise<boolean> {
    const actor = catalogMutationActor(options);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('set_team_catalog_updater_refresh_texts_as_actor', {
            p_team: teamId,
            p_refresh: refresh,
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async getCatalogUpdaterRandomLinkVariation(teamId: string): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_catalog_updater_random_link_variation', {
        p_team: teamId
      })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async setCatalogUpdaterRandomLinkVariation(
    teamId: string,
    enabled: boolean,
    options?: CatalogMutationOptions
  ): Promise<boolean> {
    const actor = catalogMutationActor(options);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('set_team_catalog_updater_random_link_variation_as_actor', {
            p_team: teamId,
            p_enabled: enabled,
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async getCatalogUpdaterGrow(teamId: string): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_catalog_updater_grow', { p_team: teamId })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async setCatalogUpdaterGrow(
    teamId: string,
    grow: boolean,
    options?: CatalogMutationOptions
  ): Promise<boolean> {
    const actor = catalogMutationActor(options);
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('set_team_catalog_updater_grow_as_actor', {
            p_team: teamId,
            p_grow: grow,
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async readCatalogPublication(
    teamId: string,
    catalogId: string,
    requestId?: string,
    options?: { signal?: AbortSignal }
  ) {
    return invokeTeamFunction(
      'drive-ops/catalog-publication/read',
      { teamId, catalogId, ...(requestId ? { requestId } : {}) },
      (value): value is NonNullable<ReturnType<typeof parseCatalogPublicationSnapshot>> | null =>
        value === null || parseCatalogPublicationSnapshot(value) !== null,
      { signal: options?.signal }
    );
  },
  async verifyCatalogPublication(
    teamId: string,
    catalogId: string,
    expectedRevision: number,
    requestId: string,
    options?: { signal?: AbortSignal }
  ) {
    return invokeTeamFunction(
      'drive-ops/catalog-publication/verify',
      { teamId, catalogId, expectedRevision, requestId, expectedActorId: catalogMutationActor() },
      (value): value is NonNullable<ReturnType<typeof parseCatalogPublicationSnapshot>> =>
        parseCatalogPublicationSnapshot(value) !== null,
      { signal: options?.signal }
    );
  },
  async changeCatalogPublication(
    teamId: string,
    input: {
      catalogId: string;
      requestId: string;
      expectedRevision: number;
      action: 'add_now' | 'reschedule' | 'cancel';
      publication?: Extract<
        CatalogVideoCreationPreferences['videoPublication'],
        { mode: 'scheduled' }
      >;
    },
    options?: { signal?: AbortSignal }
  ) {
    return invokeTeamFunction(
      'drive-ops/catalog-publication/action',
      { teamId, ...input, expectedActorId: catalogMutationActor() },
      (value): value is NonNullable<ReturnType<typeof parseCatalogPublicationSnapshot>> =>
        parseCatalogPublicationSnapshot(value) !== null,
      { signal: options?.signal }
    );
  },
  async readCatalogPublicationVerification(
    teamId: string,
    catalogId: string,
    requestId: string,
    options?: { signal?: AbortSignal }
  ) {
    return invokeTeamFunction(
      'drive-ops/catalog-publication/verify/read',
      { teamId, catalogId, requestId, expectedActorId: catalogMutationActor() },
      (value): value is NonNullable<ReturnType<typeof parseCatalogPublicationSnapshot>> | null =>
        value === null || parseCatalogPublicationSnapshot(value) !== null,
      { signal: options?.signal }
    );
  },
  async saveCatalogPublication(
    teamId: string,
    command: CatalogPublicationCommand,
    options?: { signal?: AbortSignal }
  ) {
    return invokeTeamFunction(
      'drive-ops/catalog-publication/save',
      { teamId, ...command, expectedActorId: catalogMutationActor() },
      (value): value is NonNullable<ReturnType<typeof parseCatalogPublicationSnapshot>> =>
        parseCatalogPublicationSnapshot(value) !== null,
      { signal: options?.signal }
    );
  },

  async startCatalogUpdaterVariants(
    input: {
      teamId: string;
      catalogMaterialId: string;
      sourceMaterialId?: string;
      requestId: string;
      requestedCount: number;
      profileVersion: number;
      expectedExecutorId?: string;
      foregroundExecutor?: CatalogForegroundExecutor;
    },
    options?: { signal?: AbortSignal }
  ): Promise<CatalogUpdaterVariantsSnapshot> {
    const current = catalogForegroundScope(options?.signal);
    const run = (foregroundExecutor: CatalogForegroundExecutor | undefined) => {
      current();
      return invokeTeamFunction(
        'drive-ops/updater/variants',
        {
          ...input,
          ...(foregroundExecutor ? { foregroundExecutor, expectedExecutorId: undefined } : {}),
          expectedActorId: catalogMutationActor()
        },
        isCatalogUpdaterVariantsSnapshot,
        { signal: options?.signal }
      );
    };
    const result = input.sourceMaterialId
      ? await catalogForeground.admit(
          {
            kind: 'updater',
            teamId: input.teamId,
            sourceMaterialId: input.sourceMaterialId!,
            catalogMaterialId: input.catalogMaterialId,
            requestId: input.requestId,
            profileVersion: input.profileVersion
          },
          run,
          options?.signal,
          input.foregroundExecutor
        )
      : await run(undefined);

    return attachCatalogForeground(input.teamId, result, current, options?.signal);
  },
  async resumeCatalogUpdaterVariants(
    teamId: string,
    catalogMaterialId: string,
    requestId: string,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogUpdaterVariantsSnapshot> {
    const current = catalogForegroundScope(options?.signal);
    current();
    const result = await invokeTeamFunction(
      'drive-ops/updater/variants/resume',
      { teamId, catalogMaterialId, requestId, expectedActorId: catalogMutationActor() },
      isCatalogUpdaterVariantsSnapshot,
      { signal: options?.signal }
    );

    return attachCatalogForeground(teamId, result, current, options?.signal);
  },
  async readCatalogUpdaterVariants(
    teamId: string,
    catalogMaterialId: string,
    requestId?: string,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogUpdaterVariantsSnapshot | null> {
    const current = catalogForegroundScope(options?.signal);
    current();
    const result = await invokeTeamFunction(
      'drive-ops/updater/variants/read',
      { teamId, catalogMaterialId, requestId, expectedActorId: catalogMutationActor() },
      (value): value is CatalogUpdaterVariantsSnapshot | null =>
        value === null || isCatalogUpdaterVariantsSnapshot(value),
      { signal: options?.signal }
    );

    return attachCatalogForeground(teamId, result, current, options?.signal);
  },
  async cancelCatalogUpdaterVariants(
    teamId: string,
    catalogMaterialId: string,
    requestId: string,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogUpdaterVariantsSnapshot> {
    return invokeTeamFunction(
      'drive-ops/updater/variants/cancel',
      { teamId, catalogMaterialId, requestId, expectedActorId: catalogMutationActor() },
      isCatalogUpdaterVariantsSnapshot,
      { signal: options?.signal }
    );
  },

  async resumeProductCatalogVideo(
    teamId: string,
    idempotencyKey: string,
    options?: { signal?: AbortSignal }
  ): Promise<ProductCatalogCreateResult | CatalogVideoPreparingResult> {
    const current = catalogForegroundScope(options?.signal);
    current();
    const result = await invokeTeamFunction(
      'drive-ops/product-catalog/video/resume',
      { teamId, idempotencyKey, expectedActorId: catalogMutationActor() },
      (value): value is ProductCatalogCreateResult | CatalogVideoPreparingResult =>
        productCatalogCreateGuard(value) || isCatalogVideoPreparingResult(value),
      { signal: options?.signal }
    );

    return attachCatalogForeground(teamId, result, current, options?.signal);
  },
  async readProductCatalogVideo(
    teamId: string,
    idempotencyKey: string,
    options?: { signal?: AbortSignal }
  ): Promise<ProductCatalogCreateResult | CatalogVideoPreparingResult | null> {
    const current = catalogForegroundScope(options?.signal);
    current();
    const result = await invokeTeamFunction(
      'drive-ops/product-catalog/video/read',
      { teamId, idempotencyKey, expectedActorId: catalogMutationActor() },
      (value): value is ProductCatalogCreateResult | CatalogVideoPreparingResult | null =>
        value === null || productCatalogCreateGuard(value) || isCatalogVideoPreparingResult(value),
      { signal: options?.signal }
    );

    return attachCatalogForeground(teamId, result, current, options?.signal);
  },
  async cancelProductCatalogVideo(
    teamId: string,
    idempotencyKey: string,
    requestId: string,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogVideoPreparingResult | ProductCatalogCreateResult> {
    return invokeTeamFunction(
      'drive-ops/product-catalog/video/cancel',
      { teamId, idempotencyKey, requestId, expectedActorId: catalogMutationActor() },
      (value): value is CatalogVideoPreparingResult | ProductCatalogCreateResult =>
        isCatalogVideoPreparingResult(value) || productCatalogCreateGuard(value),
      { signal: options?.signal }
    );
  },

  /** Opt-in beta protocol. Pending progress is never passed to legacy completed-catalog callers. */
  async createProductCatalogVideo(
    input: CatalogVideoCreationPreferences & {
      teamId: string;
      videoMaterialId: string;
      sourceLink: string;
      productCount: number;
      randomLinkVariation?: boolean;
      replacesMaterialId: string | null;
      idempotencyKey: string;
      copyVideoToR2?: boolean;
    },
    options?: { signal?: AbortSignal }
  ): Promise<ProductCatalogCreateResult | CatalogVideoPreparingResult> {
    const current = catalogForegroundScope(options?.signal);
    const run = (foregroundExecutor: CatalogForegroundExecutor | undefined) => {
      current();
      return invokeTeamFunction(
        'drive-ops/product-catalog/create',
        {
          ...input,
          ...(foregroundExecutor ? { foregroundExecutor, expectedExecutorId: undefined } : {}),
          catalogImageContractVersion: 3,
          expectedActorId: catalogMutationActor()
        },
        (value): value is ProductCatalogCreateResult | CatalogVideoPreparingResult =>
          productCatalogCreateGuard(value) || isCatalogVideoPreparingResult(value),
        { signal: options?.signal }
      );
    };
    const result = input.restitchEnabled
      ? await catalogForeground.admit(
          {
            kind: 'create',
            teamId: input.teamId,
            sourceMaterialId: input.videoMaterialId,
            idempotencyKey: input.idempotencyKey
          },
          run,
          options?.signal,
          input.foregroundExecutor
        )
      : await run(undefined);

    return attachCatalogForeground(input.teamId, result, current, options?.signal);
  },

  async createProductCatalog(input: {
    catalogImageContractVersion?: 2 | 3;
    teamId: string;
    videoMaterialId: string;
    sourceLink: string;
    productCount: number;
    randomLinkVariation?: boolean;
    replacesMaterialId: string | null;
    restitchOperationId?: string | null;
    idempotencyKey: string;
    /** 050: copy the catalog video to R2 and issue the R2 link from the next update on. */
    copyVideoToR2?: boolean;
  }): Promise<ProductCatalogCreateResult> {
    return invokeTeamFunction(
      'drive-ops/product-catalog/create',
      { ...input, catalogImageContractVersion: 3 },
      productCatalogCreateGuard
    );
  },

  async regenerateLandingPreview(teamId: string, materialId: string): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('request_landing_render_refresh', {
        p_team: teamId,
        p_material: materialId
      })
    );
    throwRpc(error);
  },

  async resyncDrive(
    teamId: string,
    options: { signal?: AbortSignal; requestKey?: string } = {}
  ): Promise<DriveCatalogResyncResult> {
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          options.requestKey
            ? requireSupabaseClient().rpc('request_team_catalog_resync', {
                p_team: teamId,
                p_request_key: options.requestKey
              })
            : requireSupabaseClient().rpc('request_team_catalog_resync', { p_team: teamId }),
          options
        ),
      options
    );
    throwRpc(error);
    return catalogResyncAcceptance(data);
  },

  async resyncFolder(
    teamId: string,
    folderId: string,
    options: { signal?: AbortSignal; requestKey?: string } = {}
  ): Promise<DriveCatalogResyncResult> {
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          options.requestKey
            ? requireSupabaseClient().rpc('request_team_folder_resync', {
                p_team: teamId,
                p_folder: folderId,
                p_request_key: options.requestKey
              })
            : requireSupabaseClient().rpc('request_team_folder_resync', {
                p_team: teamId,
                p_folder: folderId
              }),
          options
        ),
      options
    );
    throwRpc(error);
    return catalogResyncAcceptance(data);
  },

  /** The job and request behind a key this browser generated (028, release B). */
  async findFolderSyncRequestByKey(
    teamId: string,
    requestKey: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ syncJobId: string; requestId: string; state: string } | null> {
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('find_team_folder_sync_request_by_key', {
            p_team: teamId,
            p_request_key: requestKey
          }),
          options
        ),
      options
    );
    throwRpc(error);
    const row = Array.isArray(data) && data.length === 1 ? asRecord(data[0]) : null;
    if (!row) return null;
    if (
      typeof row.sync_job_id !== 'string' ||
      typeof row.request_id !== 'string' ||
      typeof row.state !== 'string'
    ) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { syncJobId: row.sync_job_id, requestId: row.request_id, state: row.state };
  },

  /**
   * Stops this person's request. A job other requests share, or the space's
   * canonical feed, is only left; the server says which it did.
   */
  async cancelFolderSync(
    teamId: string,
    requestId: string
  ): Promise<{ jobState: string; requestOutcome: string }> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('cancel_team_folder_sync', {
        p_team: teamId,
        p_request: requestId
      })
    );
    throwRpc(error);
    const row = Array.isArray(data) && data.length === 1 ? asRecord(data[0]) : null;
    if (!row || typeof row.job_state !== 'string' || typeof row.request_outcome !== 'string') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { jobState: row.job_state, requestOutcome: row.request_outcome };
  },

  /**
   * The job a lost accept answer may have created (028). `folderId` null
   * asks about the whole space. Null when nothing was accepted in the last
   * half hour.
   */
  async findFolderSyncRequest(
    teamId: string,
    folderId: string | null,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ syncJobId: string; state: string; createdAt: string } | null> {
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('find_team_folder_sync_request', {
            p_team: teamId,
            p_folder: folderId
          }),
          options
        ),
      options
    );
    throwRpc(error);
    const row = Array.isArray(data) && data.length === 1 ? asRecord(data[0]) : null;
    if (!row) return null;
    if (
      typeof row.sync_job_id !== 'string' ||
      !row.sync_job_id ||
      typeof row.state !== 'string' ||
      typeof row.created_at !== 'string'
    ) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { syncJobId: row.sync_job_id, state: row.state, createdAt: row.created_at };
  },

  async getFolderSyncStatus(
    teamId: string,
    jobId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<FolderSyncStatus> {
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('get_team_folder_sync_status', {
            p_team: teamId,
            p_job: jobId
          }),
          options
        ),
      options
    );
    throwRpc(error);
    const status = parseFolderSyncStatus(data);
    if (!status || status.jobId !== jobId) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return status;
  },

  async getFolderResyncStatus(
    teamId: string,
    jobId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<'running' | 'succeeded' | 'failed'> {
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('get_team_folder_resync_status', {
            p_team: teamId,
            p_job: jobId
          }),
          options
        ),
      options
    );
    throwRpc(error);
    const status = data?.[0]?.status;
    if (status !== 'running' && status !== 'succeeded' && status !== 'failed') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return status;
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

  /** Where each file attached to a task lives: material id → parent folder's Drive id (024). */
  async listTaskAttachmentFolders(
    teamId: string,
    taskId: string
  ): Promise<Map<string, string | null>> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_task_attachment_folders', {
        p_team: teamId,
        p_task: taskId
      })
    );
    throwRpc(error);
    return new Map(
      (data ?? []).map(row => [
        row.material_id,
        typeof row.parent_folder_id === 'string' ? row.parent_folder_id : null
      ])
    );
  },

  /** The variation number the next catalog of this video will take (024). */
  async nextProductCatalogVariant(teamId: string, videoMaterialId: string): Promise<number> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('next_product_catalog_variant', {
        p_team: teamId,
        p_video: videoMaterialId
      })
    );
    throwRpc(error);
    if (typeof data !== 'number') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  /** The tasks a file is attached to, open ones first (024). */
  async listMaterialTasks(
    teamId: string,
    materialId: string
  ): Promise<Array<{ id: string; title: string; status: TeamTaskStatus }>> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_material_tasks', { p_team: teamId, p_material: materialId })
    );
    throwRpc(error);
    return (data ?? [])
      .filter(row => row.status === 'todo' || row.status === 'in_progress' || row.status === 'done')
      .map(row => ({ id: row.id, title: row.title, status: row.status as TeamTaskStatus }));
  },

  async listFolderTree(teamId: string): Promise<TeamFolderNode[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_folder_tree', {
        p_team: teamId
      })
    );
    throwRpc(error);
    const nodes = (data ?? []).map(folderNode);
    if (!nodes.every(isTeamFolderNode)) throw new TeamApiError('INVALID_RESPONSE', false);
    return nodes;
  },

  /**
   * Everything a batch can take under a folder, in one read.
   *
   * The browser used to walk this a folder at a time — up to five hundred
   * sequential round trips, and a ceiling it had to explain when it hit one.
   * The catalogue already holds the tree; the recursion happens there.
   */
  async listFolderSubtree(
    teamId: string,
    rootFolderId: string,
    maxFolders?: number
  ): Promise<FolderSubtree> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_folder_subtree', {
        p_team: teamId,
        p_root: rootFolderId,
        ...(maxFolders ? { p_max_folders: maxFolders } : {})
      })
    );
    throwRpc(error);
    const row = asRecord(data);
    if (!row || typeof row.foldersVisited !== 'number' || typeof row.truncated !== 'boolean') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    // Validated like every other list in this file rather than cast: a shape
    // the server changed would otherwise reach the batch as a scope of ids.
    const parsed = (Array.isArray(row.items) ? row.items : []).map(teamMaterial);
    if (parsed.some(item => item === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    const items = parsed.filter((item): item is TeamMaterialSummary => item !== null);
    return {
      videos: items.filter(item => item.category === 'video'),
      landings: items.filter(item => item.category === 'landing'),
      foldersVisited: row.foldersVisited,
      truncated: row.truncated
    };
  },

  async listFolderPage(
    teamId: string,
    input: {
      parentFolderId: string | null;
      kinds?: TeamMaterialRowKind[];
      after?: FolderPageCursor | null;
      limit?: number;
      signal?: AbortSignal;
    }
  ): Promise<FolderPage> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_folder_page', {
          p_team: teamId,
          ...(input.parentFolderId ? { p_parent_folder_id: input.parentFolderId } : {}),
          ...(input.kinds && input.kinds.length > 0 ? { p_kind: input.kinds } : {}),
          ...(input.after
            ? { p_after_sort_key: input.after.sortKey, p_after_id: input.after.id }
            : {}),
          p_limit: input.limit ?? 100
        }),
        input
      )
    );
    throwRpc(error);
    if (!isFolderPage(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  /**
   * The file's tag — one of the seven colours, or null to take it off. Refused
   * for anyone but the space's owner, in the database rather than here.
   */
  async setMaterialTag(input: {
    teamId: string;
    materialId: string;
    color: TeamMaterialTagColor | null;
  }): Promise<TeamMaterialTagColor | null> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_material_tag', {
        p_team: input.teamId,
        p_material: input.materialId,
        p_color: input.color
      })
    );
    throwRpc(error);
    if (typeof data !== 'object' || data === null) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    const { tagColor } = data as { tagColor?: unknown };
    if (tagColor !== null && !isTeamMaterialTagColor(tagColor)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return tagColor;
  },

  async listDriveSelections(teamId: string): Promise<TeamDriveSelection[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_drive_selections', {
        p_team: teamId
      })
    );
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
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('remove_team_drive_selection', {
        p_team: teamId,
        p_selection: selectionId
      })
    );
    throwRpc(error);
  },

  async getStorageHealth(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<StorageHealth> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('get_team_storage_health_v2', {
          p_team: teamId
        }),
        options
      )
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_team_materials', {
        p_team: teamId,
        ...(parentFolderId ? { p_parent_folder_id: parentFolderId } : {})
      })
    );
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
    scope?: CatalogSearchScope,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogSearchResponse> {
    const normalized = normalizeCatalogSearchRequest(request);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const base = {
      p_team: teamId,
      p_query: normalized.query || undefined,
      p_filters: normalized.filters as unknown as Json,
      p_page: normalized.page,
      p_page_size: normalized.pageSize,
      // 011: the explorer narrows to the open folder and to row kinds.
      ...(scope?.parentFolderId ? { p_parent_folder_id: scope.parentFolderId } : {}),
      ...(scope?.kinds && scope.kinds.length > 0 ? { p_kind: scope.kinds } : {})
    };
    type SearchArgs = Database['public']['Functions']['search_materials']['Args'];
    const recursive =
      Boolean(scope?.recursive && scope.parentFolderId) && searchTakesRecursive !== false;
    const call = (withRecursive: boolean) =>
      withFreshSession(() => {
        const query = requireSupabaseClient().rpc(
          'search_materials',
          // Asserted, not declared: the generated types learn the parameter
          // when the migration that adds it is applied.
          (withRecursive ? { ...base, p_recursive: true } : base) as SearchArgs
        );
        return options?.signal ? query.abortSignal(options.signal) : query;
      });
    let { data, error } = await call(recursive);
    if (recursive && error?.code === 'PGRST202') {
      searchTakesRecursive = false;
      ({ data, error } = await call(false));
    } else if (recursive && !error) {
      searchTakesRecursive = true;
    }
    throwRpc(error);
    const result = decodeCatalogSearchResponse(data, teamId);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },

  async getCatalogVocabulary(
    teamId: string,
    options?: { signal?: AbortSignal }
  ): Promise<CatalogVocabulary> {
    const { data, error } = await withFreshSession(() => {
      const query = requireSupabaseClient().rpc('get_team_vocab_and_facets', {
        p_team: teamId
      });
      return options?.signal ? query.abortSignal(options.signal) : query;
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_team_landing_source_status', {
        p_team: teamId
      })
    );
    throwRpc(error);
    const status = teamLandingSourceStatus(data?.[0]);
    if (!status) throw new TeamApiError('INVALID_RESPONSE', false);
    return status;
  },

  async listLandingRenders(
    teamId: string,
    materialIds: string[],
    preset: string,
    options: { includeArtifacts?: boolean } = {}
  ): Promise<LandingRenderPointer[]> {
    if (materialIds.length === 0) return [];
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_landing_renders', {
        p_team: teamId,
        p_material_ids: materialIds,
        p_preset: preset
      })
    );
    throwRpc(error);

    const rows = Array.isArray(data) ? data.map(asRecord) : [];
    if (rows.some(row => row === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    const validRows = rows.filter(
      row => row?.render_state === 'ready' && row.valid === true && row.segment_count
    );
    const tokenByMaterial = new Map<string, RenderArtifactRef>();
    if (options.includeArtifacts !== false && validRows.length > 0) {
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

  /**
   * Records the language a transcription heard, on a material that has none.
   * Silent about a material that already has one: the server refuses to
   * overwrite a language a person chose, and answers `false` rather than an
   * error, because neither case is something the reader asked for.
   */
  async recordMaterialSourceLanguage(
    teamId: string,
    materialId: string,
    language: string
  ): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('record_material_source_language', {
        p_team: teamId,
        p_material: materialId,
        p_language: language
      })
    );
    throwRpc(error);
    return data === true;
  },

  async updateMaterialMetadata(
    teamId: string,
    materialId: string,
    patch: MaterialMetadataPatch
  ): Promise<CatalogMaterialItem> {
    const normalized = normalizeMaterialMetadataPatch(patch);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('update_material_metadata', {
        p_team: teamId,
        p_material: materialId,
        p_patch: normalized as unknown as Json
      })
    );
    throwRpc(error);
    const material = decodeCatalogMaterial(data, teamId);
    if (!material) throw new TeamApiError('INVALID_RESPONSE', false);
    return material;
  },

  /** A file's note (024), or null when it has none. Soty's own metadata; Drive never sees it. */
  async getMaterialNote(
    teamId: string,
    materialId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<string | null> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('get_team_material_note', {
          p_team: teamId,
          p_material: materialId
        }),
        options
      )
    );
    throwRpc(error);
    if (data !== null && typeof data !== 'string')
      throw new TeamApiError('INVALID_RESPONSE', false);
    return data ?? null;
  },

  /** Writes a file's note; an empty one removes it. Returns what was kept. */
  async setMaterialNote(teamId: string, materialId: string, note: string): Promise<string | null> {
    const material = await teamApi.updateMaterialMetadata(teamId, materialId, { note });
    return material.note ?? null;
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

  /** Drive-side duplicate of a file into a folder (folders cannot be copied). */
  async copyMaterial(input: {
    teamId: string;
    materialId: string;
    /** The folder's provider id, or null for the space root. */
    destinationFolderId: string | null;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult> {
    const value = await invokeTeamFunction('drive-ops/copy', { ...input }, fileOperationGuard);
    return parseTeamFileOperationResult(value) as TeamFileOperationResult;
  },

  async trashMaterial(input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
    expectedActorId?: string;
    receiptProtocol?: 2;
  }): Promise<TeamFileOperationResult> {
    const actor = catalogMutationActor(
      input.expectedActorId === undefined ? undefined : { expectedActorId: input.expectedActorId }
    );
    const value = await invokeTeamFunction(
      'drive-ops/trash-as-actor',
      { ...input, expectedActorId: actor, confirmed: true },
      fileOperationGuard
    );
    return parseTeamFileOperationResult(value) as TeamFileOperationResult;
  },

  async restoreMaterial(input: {
    teamId: string;
    materialId: string;
    destinationFolderId?: string | null;
    idempotencyKey: string;
    expectedActorId?: string;
    receiptProtocol?: 2;
  }): Promise<TeamFileOperationResult> {
    const actor = catalogMutationActor(
      input.expectedActorId === undefined ? undefined : { expectedActorId: input.expectedActorId }
    );
    const value = await invokeTeamFunction(
      'drive-ops/restore-as-actor',
      { ...input, expectedActorId: actor },
      fileOperationGuard
    );
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

  /**
   * The space's own folder on the connected drive, made if it is not there yet.
   *
   * Nobody is ever asked to create it, name it or find it. It is recognised by a mark this
   * application writes into it, so a member may rename or move it and it is still the same
   * folder — the name is never the identity (FR-016, FR-017).
   */
  /**
   * The space's one folder for files dropped on a task, made on first use.
   * Returns the catalogue id too, which is what an upload names as its
   * destination.
   */
  async ensureTaskDropFolder(
    teamId: string,
    /** A name makes a folder *inside* the drops — how a dropped folder stays one. */
    input?: { name: string; parentMaterialId?: string | null }
  ): Promise<{ folderId: string; materialId: string; name: string; created: boolean }> {
    const value = await invokeTeamFunction(
      'drive-ops/ensure-task-drop-folder',
      {
        teamId,
        ...(input ? { name: input.name } : {}),
        ...(input?.parentMaterialId ? { parentMaterialId: input.parentMaterialId } : {})
      },
      (
        candidate
      ): candidate is {
        folderId: string;
        materialId: string;
        name: string;
        created: boolean;
      } => {
        const row = asRecord(candidate);
        return Boolean(
          row &&
          typeof row.folderId === 'string' &&
          typeof row.materialId === 'string' &&
          typeof row.name === 'string' &&
          typeof row.created === 'boolean'
        );
      }
    );
    return value;
  },

  async ensureRestitchedFolder(teamId: string): Promise<{ folderId: string; materialId: string }> {
    return invokeTeamFunction(
      'drive-ops/ensure-restitched-folder',
      { teamId },
      (candidate): candidate is { folderId: string; materialId: string } => {
        const row = asRecord(candidate);
        return Boolean(
          row && typeof row.folderId === 'string' && typeof row.materialId === 'string'
        );
      }
    );
  },

  async ensureUploadFolder(
    teamId: string,
    input: { name: string; parentMaterialId?: string | null; idempotencyKey?: string }
  ): Promise<{ folderId: string; materialId: string; name: string; created: boolean }> {
    return invokeTeamFunction(
      'drive-ops/ensure-upload-folder',
      {
        teamId,
        name: input.name,
        idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
        ...(input.parentMaterialId ? { parentMaterialId: input.parentMaterialId } : {})
      },
      (
        candidate
      ): candidate is { folderId: string; materialId: string; name: string; created: boolean } => {
        const row = asRecord(candidate);
        return Boolean(
          row &&
          typeof row.folderId === 'string' &&
          typeof row.materialId === 'string' &&
          typeof row.name === 'string' &&
          typeof row.created === 'boolean'
        );
      }
    );
  },

  async ensureWorkspaceFolder(
    teamId: string
  ): Promise<{ folderId: string; created: boolean; name: string }> {
    return invokeTeamFunction(
      'drive-ops/ensure-workspace-folder',
      { teamId },
      workspaceFolderGuard
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_operation', {
        p_team: teamId,
        p_operation: operationId
      })
    );
    throwRpc(error);
    const operation = mapOperation(data?.[0]);
    if (!operation) throw new TeamApiError('INVALID_RESPONSE', false);
    return operation;
  },

  async cancelOperation(teamId: string, operationId: string): Promise<TeamOperationSnapshot> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('cancel_team_operation', {
        p_team: teamId,
        p_operation: operationId
      })
    );
    throwRpc(error);
    const operation = mapOperation(data?.[0]);
    if (!operation) throw new TeamApiError('INVALID_RESPONSE', false);
    return operation;
  },

  async getMaterialProvenance(
    teamId: string,
    materialId: string
  ): Promise<TeamMaterialProvenanceEntry[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_material_provenance', {
        p_team: teamId,
        p_material: materialId
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_library_materials', {
        p_team: input.teamId,
        p_stage: input.stage,
        p_cursor: input.cursor ?? undefined,
        p_page_size: input.pageSize ?? 50
      })
    );
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

  async prepareBulkTrashItem(
    teamId: string,
    groupId: string,
    materialId: string
  ): Promise<BulkTrashGroup> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('prepare_team_bulk_trash_item', {
        p_team: teamId,
        p_group: groupId,
        p_material: materialId
      })
    );
    throwRpc(error);
    const group = parseBulkTrashGroup(data);
    if (!group) throw new TeamApiError('INVALID_RESPONSE', false);
    return group;
  },
  async startBulkTrash(
    teamId: string,
    groupId: string,
    materialIds: string[],
    options?: CatalogMutationOptions
  ): Promise<BulkTrashGroup> {
    const actor = catalogMutationActor(options);
    const intendedIds = [...materialIds];
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('start_team_bulk_trash_as_actor', {
            p_team: teamId,
            p_group: groupId,
            p_materials: intendedIds,
            p_expected_actor: actor
          }),
          options ?? {}
        ),
      options
    );
    if (error?.code === 'PGRST202') throw new TeamApiError('CATALOG_COMMAND_UNSUPPORTED', false);
    throwRpc(error);
    const intended = new Set(intendedIds.map(id => id.toLowerCase()));
    const group = parseBulkTrashGroup(data);
    if (
      !group ||
      group.id.toLowerCase() !== groupId.toLowerCase() ||
      group.teamId.toLowerCase() !== teamId.toLowerCase() ||
      group.actorId.toLowerCase() !== actor ||
      group.items.length === 0 ||
      group.items.length > intended.size ||
      new Set(group.items.map(item => item.materialId.toLowerCase())).size !== group.items.length ||
      group.items.some(item => !intended.has(item.materialId.toLowerCase()))
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    return group;
  },
  async listBulkTrash(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<BulkTrashGroup[]> {
    const candidate = await invokeTeamRpc('list_team_bulk_trash', { p_team: teamId }, options);
    const parsed = parseBulkTrashGroups(candidate);
    if (!parsed) throw new TeamApiError('INVALID_RESPONSE', false);
    // One malformed group (1.4.3: an old receipt's `+00:00` instant) used to make
    // the whole list INVALID_RESPONSE, and with it every panel and every new
    // bulk trash. It is dropped here and reported; the rest stays readable.
    if (parsed.rejected.length)
      console.warn('Soty bulk trash dropped malformed groups.', { groups: parsed.rejected });
    return parsed.groups;
  },
  /** Hides a bulk-trash panel for this viewer, on every device and after a reload. */
  async dismissBulkTrash(
    teamId: string,
    groupId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    await invokeTeamRpc('dismiss_team_bulk_trash', { p_team: teamId, p_group: groupId }, options);
  },

  async markBulkTrashRequest(
    teamId: string,
    groupId: string,
    materialId: string,
    errorCode: string | null = null
  ): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('mark_team_bulk_trash_request', {
        p_team: teamId,
        p_group: groupId,
        p_material: materialId,
        p_error: errorCode ?? undefined
      })
    );
    throwRpc(error);
  },

  async copyTasks(input: {
    teamId: string;
    taskIds: string[];
    idempotencyKey?: string;
  }): Promise<string[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('copy_team_tasks_once', {
        p_team: input.teamId,
        p_tasks: input.taskIds,
        p_request: input.idempotencyKey ?? crypto.randomUUID()
      })
    );
    throwRpc(error);
    if (!Array.isArray(data) || data.some(id => typeof id !== 'string')) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return data;
  },

  async createTask(input: {
    teamId: string;
    title: string;
    note?: string | null;
    assigneeId?: string | null;
    initialMaterialId?: string | null;
  }): Promise<TeamTaskSummary> {
    return taskRpc('task_create', async () => {
      const title = input.title.normalize('NFC').trim().replace(/\s+/g, ' ');
      if (title.length < 1 || title.length > 160 || (input.note?.length ?? 0) > 2_000) {
        throw new TeamApiError('INVALID_INPUT', false);
      }
      const { data, error } = await withFreshSession(() =>
        requireSupabaseClient().rpc('create_team_task', {
          p_team: input.teamId,
          p_title: title,
          p_note: input.note ?? undefined,
          p_assignee: input.assigneeId ?? undefined,
          p_initial_material: input.initialMaterialId ?? undefined
        })
      );
      throwRpc(error);
      const task = mapTeamTask(data);
      if (!task) throw new TeamApiError('INVALID_RESPONSE', false);
      return task;
    });
  },

  async listTasks(input: {
    teamId: string;
    createdFrom?: string | null;
    createdTo?: string | null;
    /** The same range in plain `YYYY-MM-DD` days (017): a task that carries a
     *  date of its own is filtered by that day, not by when its row was made. */
    dayFrom?: string | null;
    dayTo?: string | null;
    status?: TeamTaskStatus | null;
    /** Only tasks tagged with this agent (017). */
    agentRowId?: string | null;
    /** Only tasks tagged with any agent of this account (017). */
    accountId?: string | null;
    /** Only tasks carrying any of these tags (018). */
    labelIds?: readonly string[] | null;
    /** How the board is ordered (018): by date, or by tag. */
    sort?: TeamTaskSort | null;
    cursor?: string | null;
    pageSize?: number;
    signal?: AbortSignal;
  }): Promise<TeamTaskSummary[]> {
    return taskRpc('task_list', async () => {
      const labelIds = input.labelIds?.length ? [...input.labelIds] : undefined;
      if (labelIds && labelIds.length > TEAM_TASK_LABEL_FILTER_MAX) {
        throw new TeamApiError('INVALID_INPUT', false);
      }
      const sort = input.sort ?? 'date';
      if (!isTeamTaskSort(sort)) throw new TeamApiError('INVALID_INPUT', false);
      const { data, error } = await withFreshSession(() => {
        const query = requireSupabaseClient().rpc('list_team_tasks', {
          p_team: input.teamId,
          p_created_from: input.createdFrom ?? undefined,
          p_created_to: input.createdTo ?? undefined,
          p_day_from: input.dayFrom ?? undefined,
          p_day_to: input.dayTo ?? undefined,
          p_status: input.status ?? undefined,
          p_agent: input.agentRowId ?? undefined,
          p_account: input.accountId ?? undefined,
          p_labels: labelIds,
          p_sort: sort,
          p_cursor: input.cursor ?? undefined,
          p_page_size: input.pageSize ?? 50
        });
        return input.signal ? query.abortSignal(input.signal) : query;
      });
      throwRpc(error);
      if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
      const tasks = data.map(mapTeamTask);
      if (tasks.some(task => task === null)) throw new TeamApiError('INVALID_RESPONSE', false);
      return tasks.filter((task): task is TeamTaskSummary => task !== null);
    });
  },

  async getTask(input: {
    teamId: string;
    taskId: string;
    attachmentCursor?: number | null;
    attachmentPageSize?: number;
  }): Promise<{ task: TeamTaskSummary; attachments: TeamTaskAttachmentSummary[] }> {
    return taskRpc(
      'task_read',
      async () => {
        const { data, error } = await withFreshSession(() =>
          requireSupabaseClient().rpc('get_team_task', {
            p_team: input.teamId,
            p_task: input.taskId,
            p_attachment_cursor: input.attachmentCursor ?? undefined,
            p_attachment_page_size: input.attachmentPageSize ?? 50
          })
        );
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
      input.taskId
    );
  },

  async updateTask(teamId: string, taskId: string, patch: TeamTaskPatch): Promise<TeamTaskSummary> {
    return taskRpc(
      'task_update',
      async () => {
        const normalized = parseTeamTaskPatch(patch);
        if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
        const { data, error } = await withFreshSession(() =>
          requireSupabaseClient().rpc('update_team_task', {
            p_team: teamId,
            p_task: taskId,
            p_patch: normalized as unknown as Json
          })
        );
        throwRpc(error);
        const task = mapTeamTask(data);
        if (!task) throw new TeamApiError('INVALID_RESPONSE', false);
        return task;
      },
      taskId
    );
  },

  async attachTaskMaterials(input: {
    teamId: string;
    taskId: string;
    materialIds: string[];
  }): Promise<TeamTaskAttachmentMutationResult> {
    const normalized = parseTaskAttachmentMutation(input);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('attach_team_task_materials', {
        p_team: normalized.teamId,
        p_task: normalized.taskId,
        p_materials: normalized.materialIds
      })
    );
    throwRpc(error);
    const result = taskAttachmentMutationResult(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },

  async beginTaskUpload(teamId: string, taskId: string, requestKey: string): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('begin_task_upload', {
        p_team: teamId,
        p_task: taskId,
        p_request: requestKey
      })
    );
    throwRpc(error);
  },
  async detachTaskMaterialSafely(
    teamId: string,
    taskId: string,
    materialId: string
  ): Promise<TaskCleanupReceipt> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('detach_task_material_safely', {
        p_team: teamId,
        p_task: taskId,
        p_material: materialId
      })
    );
    throwRpc(error);
    if (!isTaskCleanupReceipt(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async undoTaskMaterialDetach(teamId: string, receiptId: string): Promise<TaskCleanupReceipt> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('undo_task_material_detach', {
        p_team: teamId,
        p_receipt: receiptId
      })
    );
    throwRpc(error);
    if (!isTaskCleanupReceipt(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },
  async listTaskAttachmentCleanup(teamId: string, taskId: string): Promise<TaskCleanupReceipt[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_task_attachment_cleanup', {
        p_team: teamId,
        p_task: taskId
      })
    );
    throwRpc(error);
    const candidate: unknown = data;
    if (!Array.isArray(candidate) || !candidate.every(isTaskCleanupReceipt))
      throw new TeamApiError('INVALID_RESPONSE', false);
    return candidate;
  },

  async detachTaskMaterial(teamId: string, taskId: string, materialId: string): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('detach_team_task_material', {
        p_team: teamId,
        p_task: taskId,
        p_material: materialId
      })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async scanLibraryRequirements(
    teamId: string,
    interfaceLanguage: string,
    sourceMaterialIds?: readonly string[],
    /** False just counts; true also enqueues the work it counted. */
    commit = true,
    /** The kinds to enqueue (024); absent enqueues every kind. */
    kinds?: readonly string[]
  ): Promise<LibraryRequirementScanResult> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('scan_library_requirements', {
        p_team: teamId,
        p_interface_language: interfaceLanguage,
        // An empty list is not a scope; it is the whole space, same as none.
        p_sources:
          sourceMaterialIds && sourceMaterialIds.length > 0 ? [...sourceMaterialIds] : undefined,
        p_commit: commit,
        ...(kinds ? { p_kinds: [...kinds] } : {})
      })
    );
    throwRpc(error);
    const result = libraryScanResult(data);
    if (!result) throw new TeamApiError('INVALID_RESPONSE', false);
    return result;
  },

  async getLibraryProcessingContext(
    teamId: string,
    sourceMaterialId: string
  ): Promise<LibraryProcessingContext> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_library_processing_context', {
        p_team: teamId,
        p_source: sourceMaterialId
      })
    );
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

  /**
   * The id of the material already carrying `name` in that folder, if any.
   *
   * Scoped to the one folder and matched exactly: the search is a prefix search
   * over the space, so the page it returns is filtered down to the file whose
   * name is the one asked for rather than one that merely starts with it.
   */
  async findMaterialByName(
    teamId: string,
    destinationFolderId: string,
    name: string
  ): Promise<string | null> {
    const wanted = name.normalize('NFC');
    const response = await teamApi.searchCatalog(
      teamId,
      { query: wanted, page: 1, pageSize: 50 },
      { parentFolderId: destinationFolderId }
    );
    const match = response.items.find(item => item.name.normalize('NFC') === wanted);
    return match?.id ?? null;
  },

  async claimLibraryJob(input: LibraryJobClaimRequest): Promise<LibraryJobClaimEnvelope> {
    const normalized = parseLibraryJobClaim(input);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('claim_library_job', {
        p_team: normalized.teamId,
        p_agent_instance: normalized.agentInstanceId,
        p_supported_kinds: normalized.supportedKinds,
        p_interface_language: normalized.interfaceLanguage,
        p_sources: normalized.sourceMaterialIds
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('heartbeat_library_job', {
        p_team: normalized.teamId,
        p_attempt: normalized.attemptId,
        p_agent_instance: normalized.agentInstanceId,
        p_lease_token: normalized.leaseToken,
        p_progress: normalized.progress,
        p_stage: normalized.stage
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('cancel_library_job', {
        p_team: input.teamId,
        p_attempt: input.attemptId,
        p_agent_instance: input.agentInstanceId,
        p_lease_token: input.leaseToken
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('fail_library_job', {
        p_team: input.teamId,
        p_attempt: input.attemptId,
        p_agent_instance: input.agentInstanceId,
        p_lease_token: input.leaseToken,
        p_error_code: input.errorCode
      })
    );
    throwRpc(error);
    if (typeof data !== 'boolean') throw new TeamApiError('INVALID_RESPONSE', false);
    return data;
  },

  async retryFailedLibraryJobs(
    teamId: string,
    sourceMaterialIds?: readonly string[]
  ): Promise<number> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('retry_failed_library_jobs', {
        p_team: teamId,
        p_sources:
          sourceMaterialIds && sourceMaterialIds.length > 0 ? [...sourceMaterialIds] : undefined
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_video_text_variants', {
        p_team: teamId,
        p_video: videoId
      })
    );
    throwRpc(error);
    const variants = parseLibraryVideoTextVariants(data);
    if (!variants) throw new TeamApiError('INVALID_RESPONSE', false);
    return variants;
  },

  async getLibrarySharePreference(teamId: string): Promise<{
    allowLinkOnCopy: boolean;
    remembered: boolean;
  }> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_share_preference', {
        p_team: teamId
      })
    );
    throwRpc(error);
    const row = asRecord(data);
    if (!row || typeof row.allowLinkOnCopy !== 'boolean' || typeof row.remembered !== 'boolean') {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return { allowLinkOnCopy: row.allowLinkOnCopy, remembered: row.remembered };
  },

  async shareLibraryMaterial(
    request: LibraryShareCopyRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<LibraryShareCopyResult> {
    const normalized = parseLibraryShareCopyRequest(request);
    if (!normalized) throw new TeamApiError('INVALID_INPUT', false);
    const value = await invokeTeamFunction(
      'library-ops/share/copy',
      { action: 'share_copy', ...normalized },
      (candidate): candidate is LibraryShareCopyResult =>
        parseLibraryShareCopyResult(candidate) !== null,
      { signal: options.signal ?? AbortSignal.timeout(25_000) }
    );
    return parseLibraryShareCopyResult(value) as LibraryShareCopyResult;
  },

  async resetLibrarySharePreference(teamId: string): Promise<boolean> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('reset_share_preference', {
        p_team: teamId
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('leave_team', {
        p_team: teamId
      })
    );
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
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('delete_draft_team', {
        p_team: teamId
      })
    );
    throwRpc(error);
    if (data?.[0]?.ok !== true) throw new TeamApiError('INVALID_RESPONSE', false);
    return true;
  },

  /** Delete a saved task. Attachment links go with it; the materials do not. */
  async deleteTask(input: { teamId: string; taskId: string }): Promise<true> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('delete_team_task', {
        p_team: input.teamId,
        p_task: input.taskId
      })
    );
    throwRpc(error);
    if (data?.[0]?.ok !== true) throw new TeamApiError('INVALID_RESPONSE', false);
    return true;
  },

  /** Tag a task with an agent (017). Returns the task's whole tag list. */
  async attachTaskAgent(input: {
    teamId: string;
    taskId: string;
    agentRowId: string;
  }): Promise<TeamTaskAgentTag[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('attach_team_task_agent', {
        p_team: input.teamId,
        p_task: input.taskId,
        p_agent: input.agentRowId
      })
    );
    throwRpc(error);
    const tags = parseTeamTaskAgentTags(data);
    if (!tags) throw new TeamApiError('INVALID_RESPONSE', false);
    return tags;
  },

  async detachTaskAgent(input: {
    teamId: string;
    taskId: string;
    agentRowId: string;
  }): Promise<TeamTaskAgentTag[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('detach_team_task_agent', {
        p_team: input.teamId,
        p_task: input.taskId,
        p_agent: input.agentRowId
      })
    );
    throwRpc(error);
    const tags = parseTeamTaskAgentTags(data);
    if (!tags) throw new TeamApiError('INVALID_RESPONSE', false);
    return tags;
  },

  // ---------------------------------------------------------------------------
  // Task tags (018): the space's own dictionary, and the tags a task carries.
  // ---------------------------------------------------------------------------

  /** Every tag of one set with how many things carry it — one round trip. */
  async listTaskLabels(
    teamId: string,
    scope: TeamLabelScope = 'task',
    options?: { signal?: AbortSignal }
  ): Promise<TeamTaskLabel[]> {
    const { data, error } = await withFreshSession(() => {
      const query = requireSupabaseClient().rpc('list_team_labels', {
        p_team: teamId,
        p_scope: scope
      });
      return options?.signal ? query.abortSignal(options.signal) : query;
    });
    throwRpc(error);
    const labels = (data ?? []).map(parseTeamTaskLabel);
    if (labels.some(label => label === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    return labels.filter((label): label is TeamTaskLabel => label !== null);
  },

  async createTaskLabel(input: {
    teamId: string;
    name: string;
    color: TeamTaskLabelColor;
    scope?: TeamLabelScope;
  }): Promise<TeamTaskLabel> {
    const name = normalizeTeamTaskLabelName(input.name);
    if (!name || !isTeamTaskLabelColor(input.color)) {
      throw new TeamApiError('INVALID_INPUT', false);
    }
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('create_team_label', {
        p_team: input.teamId,
        p_name: name,
        p_color: input.color,
        p_scope: input.scope ?? 'task'
      })
    );
    throwRpc(error);
    const label = parseTeamTaskLabel(data);
    if (!label) throw new TeamApiError('INVALID_RESPONSE', false);
    return label;
  },

  /** Renames and recolours in one call: a tag is a name and a colour. */
  async updateTaskLabel(input: {
    teamId: string;
    labelId: string;
    name: string;
    color: TeamTaskLabelColor;
  }): Promise<TeamTaskLabel> {
    const name = normalizeTeamTaskLabelName(input.name);
    if (!name || !isTeamTaskLabelColor(input.color)) {
      throw new TeamApiError('INVALID_INPUT', false);
    }
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('update_team_label', {
        p_team: input.teamId,
        p_label: input.labelId,
        p_name: name,
        p_color: input.color
      })
    );
    throwRpc(error);
    const label = parseTeamTaskLabel(data);
    if (!label) throw new TeamApiError('INVALID_RESPONSE', false);
    return label;
  },

  /** Deletes a tag. It comes off every task it was on; no task is lost. */
  async deleteTaskLabel(input: { teamId: string; labelId: string }): Promise<true> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('delete_team_label', {
        p_team: input.teamId,
        p_label: input.labelId
      })
    );
    throwRpc(error);
    if (data?.[0]?.ok !== true) throw new TeamApiError('INVALID_RESPONSE', false);
    return true;
  },

  /** Hangs a tag on a task (018). Returns the task's whole tag list. */
  async attachTaskLabel(input: {
    teamId: string;
    taskId: string;
    labelId: string;
  }): Promise<TeamTaskLabelRef[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('attach_team_task_label', {
        p_team: input.teamId,
        p_task: input.taskId,
        p_label: input.labelId
      })
    );
    throwRpc(error);
    const labels = parseTeamTaskLabelRefs(data);
    if (!labels) throw new TeamApiError('INVALID_RESPONSE', false);
    return labels;
  },

  async detachTaskLabel(input: {
    teamId: string;
    taskId: string;
    labelId: string;
  }): Promise<TeamTaskLabelRef[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('detach_team_task_label', {
        p_team: input.teamId,
        p_task: input.taskId,
        p_label: input.labelId
      })
    );
    throwRpc(error);
    const labels = parseTeamTaskLabelRefs(data);
    if (!labels) throw new TeamApiError('INVALID_RESPONSE', false);
    return labels;
  },

  // ---------------------------------------------------------------------------
  // Team accounts (017): the social accounts a space runs from, and their agents.
  // ---------------------------------------------------------------------------

  /** Every account of a space with its agents nested — one round trip, no paging. */
  async listAccounts(
    teamId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<TeamAccountSummary[]> {
    const { data, error } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_accounts', {
          p_team: teamId
        }),
        options
      )
    );
    throwRpc(error);
    const accounts = (data ?? []).map(parseTeamAccount);
    if (accounts.some(account => account === null)) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    const parsedAccounts = accounts.filter(
      (account): account is TeamAccountSummary => account !== null
    );
    const { data: seedRows, error: seedError } = await withFreshSession(() =>
      abortable(
        requireSupabaseClient().rpc('list_team_account_two_factor_seeds', { p_team: teamId }),
        options
      )
    );
    throwRpc(seedError);
    if (!Array.isArray(seedRows)) throw new TeamApiError('INVALID_RESPONSE', false);
    const seeds = new Map<string, string>();
    for (const row of seedRows) {
      if (!row || typeof row.account_id !== 'string' || typeof row.secret !== 'string') {
        throw new TeamApiError('INVALID_RESPONSE', false);
      }
      seeds.set(row.account_id, row.secret);
    }
    return parsedAccounts.map(account => ({
      ...account,
      twoFactorSeed: seeds.get(account.id) ?? null
    }));
  },

  async setAccountTwoFactor(input: {
    teamId: string;
    accountId: string;
    seed: string | null;
  }): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_account_two_factor_seed', {
        p_team: input.teamId,
        p_account: input.accountId,
        p_secret: input.seed
      })
    );
    throwRpc(error);
  },

  async createAccount(input: {
    teamId: string;
    name: string;
    startsOn?: string;
    timezone?: string;
  }): Promise<TeamAccountSummary> {
    const name = normalizeTeamAccountName(input.name);
    const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (
      !name ||
      !validFinanceTimezone(timezone) ||
      (input.startsOn !== undefined && !validFinanceDate(input.startsOn))
    )
      throw new TeamApiError('INVALID_INPUT', false);
    if (input.startsOn && input.startsOn > financeToday(timezone))
      throw new TeamApiError('FUTURE_FINANCE_DATE', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('create_team_account', {
        p_team: input.teamId,
        p_name: name,
        p_timezone: timezone,
        ...(input.startsOn ? { p_starts_on: input.startsOn } : {})
      })
    );
    throwRpc(error);
    const account = parseTeamAccount({ ...(data as object), agents: [] });
    if (!account || (input.startsOn !== undefined && account.startsOn !== input.startsOn))
      throw new TeamApiError('INVALID_RESPONSE', false);
    return account;
  },

  /** Returns the account without its agents; the caller keeps the ones it has. */
  async renameAccount(input: {
    teamId: string;
    accountId: string;
    name: string;
  }): Promise<Omit<TeamAccountSummary, 'agents'>> {
    const name = normalizeTeamAccountName(input.name);
    if (!name) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('rename_team_account', {
        p_team: input.teamId,
        p_account: input.accountId,
        p_name: name
      })
    );
    throwRpc(error);
    const account = parseTeamAccount({ ...(data as object), agents: [] });
    if (!account) throw new TeamApiError('INVALID_RESPONSE', false);
    const { id, teamId, name: cleanName, createdAt, updatedAt } = account;
    return { id, teamId, name: cleanName, createdAt, updatedAt };
  },

  /** Delete an account. Its agents go with it. */
  async deleteAccount(input: { teamId: string; accountId: string }): Promise<true> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('delete_team_account', {
        p_team: input.teamId,
        p_account: input.accountId
      })
    );
    throwRpc(error);
    if (data?.[0]?.ok !== true) throw new TeamApiError('INVALID_RESPONSE', false);
    return true;
  },

  async addAccountAgent(input: {
    teamId: string;
    accountId: string;
    agentId: string;
    note?: string | null;
    timezone?: string;
    startsOn?: string;
  }): Promise<TeamAccountAgentSummary> {
    const agentId = normalizeTeamAgentId(input.agentId);
    const note = normalizeTeamAgentNote(input.note);
    const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (
      !agentId ||
      note === undefined ||
      !validFinanceTimezone(timezone) ||
      (input.startsOn !== undefined && !validFinanceDate(input.startsOn))
    )
      throw new TeamApiError('INVALID_INPUT', false);
    if (input.startsOn && input.startsOn > financeToday(timezone))
      throw new TeamApiError('FUTURE_FINANCE_DATE', false);
    const { data, error } = await withFreshSession(() => {
      const supabase = requireSupabaseClient();
      return supabase.rpc('add_team_account_agent', {
        p_team: input.teamId,
        p_account: input.accountId,
        p_agent_id: agentId,
        p_note: note ?? undefined,
        p_timezone: timezone,
        ...(input.startsOn ? { p_starts_on: input.startsOn } : {})
      });
    });
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent || (input.startsOn !== undefined && agent.startsOn !== input.startsOn))
      throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  /** The id alone; runs have their own calls below. */
  async updateAccountAgent(input: {
    teamId: string;
    agentRowId: string;
    agentId: string;
  }): Promise<TeamAccountAgentSummary> {
    const agentId = normalizeTeamAgentId(input.agentId);
    if (!agentId) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('update_team_account_agent', {
        p_team: input.teamId,
        p_agent: input.agentRowId,
        p_agent_id: agentId
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  /** A run on an agent (017, part 3). Every run call returns the whole agent. */
  async addAgentRun(input: {
    teamId: string;
    agentRowId: string;
    note: string;
  }): Promise<TeamAccountAgentSummary> {
    const note = normalizeTeamAgentNote(input.note);
    if (!note) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('add_team_agent_run', {
        p_team: input.teamId,
        p_agent: input.agentRowId,
        p_note: note
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  async updateAgentRun(input: {
    teamId: string;
    runId: string;
    note: string;
  }): Promise<TeamAccountAgentSummary> {
    const note = normalizeTeamAgentNote(input.note);
    if (!note) throw new TeamApiError('INVALID_INPUT', false);
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('update_team_agent_run', {
        p_team: input.teamId,
        p_run: input.runId,
        p_note: note
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  /**
   * The run's marker — green, amber, red, or null to clear it. A press on the
   * run cycles through them, so this is called with whatever the cycle landed
   * on rather than with a colour chosen from a menu.
   */
  async setAgentRunMarker(input: {
    teamId: string;
    runId: string;
    marker: TeamAgentRunMarker | null;
  }): Promise<TeamAccountAgentSummary> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_team_agent_run_marker', {
        p_team: input.teamId,
        p_run: input.runId,
        p_marker: input.marker
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  async deleteAgentRun(input: { teamId: string; runId: string }): Promise<TeamAccountAgentSummary> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('delete_team_agent_run', {
        p_team: input.teamId,
        p_run: input.runId
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  /**
   * Takes the marker off every marked run in the space, and returns what they
   * were carrying so the toast can offer to put them back.
   */
  async clearAgentRunMarkers(input: { teamId: string }): Promise<TeamAgentRunMarkerSnapshot[]> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('clear_team_agent_run_markers', {
        p_team: input.teamId
      })
    );
    throwRpc(error);
    const cleared = parseTeamAgentRunMarkerSnapshots(data);
    if (!cleared) throw new TeamApiError('INVALID_RESPONSE', false);
    return cleared;
  },

  /** Frees the agent: every run goes. */
  async clearAgentRuns(input: {
    teamId: string;
    agentRowId: string;
  }): Promise<TeamAccountAgentSummary> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('clear_team_agent_runs', {
        p_team: input.teamId,
        p_agent: input.agentRowId
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  /** Hangs an agent tag on an agent (019); the whole agent comes back. */
  async attachAgentLabel(input: {
    teamId: string;
    agentRowId: string;
    labelId: string;
  }): Promise<TeamAccountAgentSummary> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('attach_team_agent_label', {
        p_team: input.teamId,
        p_agent: input.agentRowId,
        p_label: input.labelId
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  async detachAgentLabel(input: {
    teamId: string;
    agentRowId: string;
    labelId: string;
  }): Promise<TeamAccountAgentSummary> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('detach_team_agent_label', {
        p_team: input.teamId,
        p_agent: input.agentRowId,
        p_label: input.labelId
      })
    );
    throwRpc(error);
    const agent = parseTeamAccountAgent(data);
    if (!agent) throw new TeamApiError('INVALID_RESPONSE', false);
    return agent;
  },

  async deleteAccountAgent(input: { teamId: string; agentRowId: string }): Promise<true> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('delete_team_account_agent', {
        p_team: input.teamId,
        p_agent: input.agentRowId
      })
    );
    throwRpc(error);
    if (data?.[0]?.ok !== true) throw new TeamApiError('INVALID_RESPONSE', false);
    return true;
  },

  /**
   * Newest-first page of trashed materials. The timestamp and ID identify the
   * last row already shown — keyset paging, so a restore happening mid-scroll
   * cannot shift the window and hide a row.
   */
  async listTrashedMaterials(input: {
    teamId: string;
    limit?: number;
    before?: string | null;
    beforeId?: string | null;
    signal?: AbortSignal;
  }): Promise<TeamTrashedMaterial[]> {
    const { data, error } = await withFreshSession(
      () =>
        abortable(
          requireSupabaseClient().rpc('list_team_trashed_materials_v2', {
            p_team: input.teamId,
            p_limit: input.limit ?? 50,
            p_before: input.before ?? undefined,
            p_before_id: input.beforeId ?? undefined
          }),
          input
        ),
      input
    );
    throwRpc(error);
    if (!Array.isArray(data)) throw new TeamApiError('INVALID_RESPONSE', false);
    const rows = data.map(mapTrashedMaterial);
    if (rows.some(row => row === null)) throw new TeamApiError('INVALID_RESPONSE', false);
    return rows.filter((row): row is TeamTrashedMaterial => row !== null);
  },

  /**
   * The space's re-stitching defaults, or `null` when nobody has set them.
   *
   * A space with no row and a space whose row says it is not configured are the same answer
   * to everyone who asks, so both arrive here as `null` and the interface has one condition
   * to branch on rather than two.
   */
  async getRestitchDefaults(teamId: string): Promise<TeamRestitchDefaults | null> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_effective_restitch_defaults', {
        p_team: teamId
      })
    );
    throwRpc(error);
    if (data === null || data === undefined) return null;
    const parsed = parseTeamRestitchDefaults(data);
    if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.value.configured ? parsed.value : null;
  },

  async getMemberRestitchPreference(teamId: string): Promise<{
    ownerId: string;
    sourceUserId: string;
    useOwner: boolean;
    personalConfigured: boolean;
  }> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_member_restitch_preference', { p_team: teamId })
    );
    throwRpc(error);
    const row = asRecord(data);
    if (
      !row ||
      typeof row.ownerId !== 'string' ||
      typeof row.sourceUserId !== 'string' ||
      typeof row.useOwner !== 'boolean' ||
      typeof row.personalConfigured !== 'boolean'
    ) {
      throw new TeamApiError('INVALID_RESPONSE', false);
    }
    return {
      ownerId: row.ownerId,
      sourceUserId: row.sourceUserId,
      useOwner: row.useOwner,
      personalConfigured: row.personalConfigured
    };
  },

  async setMemberRestitchUseOwner(teamId: string, useOwner: boolean): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_member_restitch_use_owner', {
        p_team: teamId,
        p_use_owner: useOwner
      })
    );
    throwRpc(error);
  },

  /** Stores the space's defaults. Refusals arrive as their own codes, not as sentences. */
  async setRestitchDefaults(
    teamId: string,
    defaults: RestitchDefaultsInput
  ): Promise<TeamRestitchDefaults> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_restitch_defaults', {
        p_team: teamId,
        p_defaults: defaults as unknown as Json
      })
    );
    throwRpc(error);
    const parsed = parseTeamRestitchDefaults(mapRestitchRow(data));
    if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.value;
  },

  async setMemberRestitchDefaults(
    teamId: string,
    defaults: RestitchDefaultsInput
  ): Promise<TeamRestitchDefaults> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_member_restitch_defaults', {
        p_team: teamId,
        p_defaults: defaults as unknown as Json
      })
    );
    throwRpc(error);
    const parsed = parseTeamRestitchDefaults(data);
    if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.value;
  },

  /**
   * The space's (or the caller's personal) re-stitch pools, every source with its
   * availability and counts (030). `'owner'` is the space's pool, `'self'` the caller's.
   */
  async listRestitchSources(
    teamId: string,
    scope: 'owner' | 'self'
  ): Promise<RestitchSourcesListing> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('list_restitch_sources', { p_team: teamId, p_scope: scope })
    );
    throwRpc(error);
    const parsed = parseRestitchSourcesListing(data);
    if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.value;
  },

  /** Replace one slot of the space's pool (owner only). Flips the settings to drive mode. */
  async setRestitchSources(
    teamId: string,
    slot: RestitchSlot,
    items: readonly RestitchSourceInput[]
  ): Promise<RestitchSourcesListing> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_restitch_sources', {
        p_team: teamId,
        p_slot: slot,
        p_items: items as unknown as Json
      })
    );
    throwRpc(error);
    const parsed = parseRestitchSourcesListing(data);
    if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.value;
  },

  /** Replace one slot of the caller's personal pool. */
  async setMemberRestitchSources(
    teamId: string,
    slot: RestitchSlot,
    items: readonly RestitchSourceInput[]
  ): Promise<RestitchSourcesListing> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_member_restitch_sources', {
        p_team: teamId,
        p_slot: slot,
        p_items: items as unknown as Json
      })
    );
    throwRpc(error);
    const parsed = parseRestitchSourcesListing(data);
    if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.value;
  },

  /**
   * One picture per enabled slot for a job, drawn by the server from the caller's effective
   * pools (030). `exclude` is the one picture a failed grant said not to try again.
   */
  async drawRestitchScreens(
    teamId: string,
    options: { exclude?: readonly string[] } = {}
  ): Promise<RestitchDrawResult> {
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('draw_restitch_screens', {
        p_team: teamId,
        p_exclude: [...(options.exclude ?? [])]
      })
    );
    throwRpc(error);
    const parsed = parseRestitchDrawResult(data);
    if (!parsed.ok) throw new TeamApiError('INVALID_RESPONSE', false);
    return parsed.value;
  },

  /**
   * What is already known about these materials.
   *
   * Batched because the explorer asks once per page of rows, not once per row. A material
   * whose record no longer describes its current content is simply absent — the read applies
   * the invalidation rule so no caller has to remember it.
   */
  async getMaterialRestitchPrep(
    teamId: string,
    materialIds: string[]
  ): Promise<Map<string, MaterialRestitchPrep>> {
    const found = new Map<string, MaterialRestitchPrep>();
    if (!materialIds.length) return found;
    const { data, error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('get_material_restitch_prep', {
        p_team: teamId,
        p_materials: materialIds
      })
    );
    throwRpc(error);
    for (const row of Array.isArray(data) ? data : []) {
      const parsed = parseMaterialRestitchPrep(mapRestitchPrepRow(row));
      // A record that cannot be trusted is treated as absent rather than as a failure: the
      // run then inspects for itself, which is slower and always correct.
      if (parsed.ok) found.set(parsed.value.materialId, parsed.value);
    }
    return found;
  },

  /** Records what a run found, so the next one does not pay for it again. */
  async setMaterialRestitchPrep(prep: MaterialRestitchPrep): Promise<void> {
    const { error } = await withFreshSession(() =>
      requireSupabaseClient().rpc('set_material_restitch_prep', {
        p_material: prep.materialId,
        p_drive_version: prep.driveVersion,
        p_prep: {
          detectorVersion: prep.detectorVersion,
          detectedStartSeconds: prep.detectedStartSeconds,
          detectedEndSeconds: prep.detectedEndSeconds,
          profile: prep.profile,
          unsupportedReason: prep.unsupportedReason
        } as unknown as Json
      })
    );
    throwRpc(error);
  }
};

/** Postgres answers in its own column names; the contract speaks the app's. */
function mapRestitchRow(value: unknown): unknown {
  const row = asRecord(value);
  if (!row) return null;
  return {
    operation: row.operation,
    startImageIds: row.start_image_ids,
    endImageIds: row.end_image_ids,
    startEnabled: row.start_enabled,
    endEnabled: row.end_enabled,
    startDurationMode: row.start_duration_mode,
    customStartDurationMs: row.custom_start_duration_ms,
    fitMode: row.fit_mode,
    finalDurationMode: row.final_duration_mode,
    customFinalDurationSeconds: row.custom_final_duration_seconds,
    configured: row.configured,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

function mapRestitchPrepRow(value: unknown): unknown {
  const row = asRecord(value);
  if (!row) return null;
  return {
    materialId: row.material_id,
    driveVersion: row.drive_version,
    detectorVersion: Number(row.detector_version ?? 0),
    detectedStartSeconds: Number(row.detected_start_seconds),
    detectedEndSeconds: Number(row.detected_end_seconds),
    profile: row.source_profile,
    unsupportedReason: row.unsupported_reason,
    preparedAt: row.prepared_at
  };
}

/* ------------------------------------------------------------------------- */
/* 034 — space tariffs                                                        */
/* ------------------------------------------------------------------------- */

/**
 * One call to an RPC the generated types may not know yet.
 *
 * The tariff functions arrive in a migration written beside this file, and the
 * generated `database.types.ts` is regenerated from the database rather than
 * edited by hand — so these go through an untyped seam and every reply through
 * a parser from `packages/shared/src/team/tariffs.ts`, which is the contract
 * that actually holds.
 */
type UntypedRpcClient = {
  rpc: (
    name: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

async function tariffRpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = requireSupabaseClient() as unknown as UntypedRpcClient;
  const { data, error } = await withFreshSession(() => client.rpc(name, args));
  throwRpc(error);
  return data;
}

function parsedOrThrow<T>(value: T | null): T {
  if (value === null) throw new TeamApiError('INVALID_RESPONSE', false);
  return value;
}

/** PostgREST hands a `returns jsonb` function's object back as-is, and a set as an array. */
function single(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

/** What the page assumes when it can only ask the old question (034). */
export function fallbackSpaceAccess(allowed: boolean): SpaceAccess {
  return {
    mode: allowed ? 'workspace' : 'showcase',
    canCreate: false,
    pendingTariff: null,
    teams: [],
    invitations: [],
    banner: null,
    toast: null,
    showcase: allowed
      ? null
      : { plans: [], contact: { telegram: null, email: null }, email: '', request: null }
  };
}

export const spaceTariffApi = {
  async getMySpaceAccess(): Promise<SpaceAccess> {
    return parsedOrThrow(parseSpaceAccess(single(await tariffRpc('get_my_space_access'))));
  },

  async getTeamTariff(teamId: string): Promise<TeamTariff> {
    return parsedOrThrow(
      parseTeamTariff(single(await tariffRpc('get_team_tariff', { p_team: teamId })))
    );
  },

  async ackToast(eventId: string): Promise<boolean> {
    return (await tariffRpc('ack_space_tariff_toast', { p_event: eventId })) === true;
  },

  /** Records interest from the showcase: the plan and the channel the person chose. */
  async joinWaitlist(plan: string | null, channel: TariffContactChannel | null): Promise<boolean> {
    return (
      (await tariffRpc('join_team_workspace_waitlist', { p_plan: plan, p_channel: channel })) ===
      true
    );
  },

  async requestOwnerNudge(teamId: string): Promise<SpaceOwnerNudgeResult> {
    return parsedOrThrow(
      parseSpaceOwnerNudge(single(await tariffRpc('request_space_owner_nudge', { p_team: teamId })))
    );
  },

  async retryRecovery(recoveryId: string): Promise<boolean> {
    return (await tariffRpc('retry_workspace_recovery', { p_recovery: recoveryId })) === true;
  },

  async resumeCatalogUpdater(teamId: string): Promise<boolean> {
    return (await tariffRpc('resume_team_catalog_updater', { p_team: teamId })) === true;
  }
};

export type SpaceTariffClient = typeof spaceTariffApi;

export interface AdminGrantTariffInput {
  email: string;
  plan: string;
  endsOn: string;
  extraSeats: number;
  teamId: string | null;
  note: string | null;
  externalRef: string | null;
  notify: boolean;
  source?: 'manual' | 'trial';
}

export interface AdminUpdateTariffInput {
  approvedGoogleEmail?: string;
  googleApprovalRevision?: string;
  expectedUpdatedAt?: string;
  id: string;
  plan: string;
  endsOn: string;
  extraSeats: number;
  note: string | null;
  externalRef: string | null;
}

const tariffMutationIds = new Map<string, string>();
async function mutateTariff(
  id: string,
  expected: string,
  action: string,
  input: Record<string, unknown>
) {
  const signature = JSON.stringify([id, expected, action, input]);
  const operation = tariffMutationIds.get(signature) ?? crypto.randomUUID();
  if (tariffMutationIds.size >= 256 && !tariffMutationIds.has(signature)) {
    tariffMutationIds.delete(tariffMutationIds.keys().next().value!);
  }
  tariffMutationIds.set(signature, operation);
  return tariffRpc('admin_mutate_space_tariff', {
    p_id: id,
    p_operation: operation,
    p_expected: expected,
    p_action: action,
    p_input: input
  });
}

export interface DriveApprovalPreview {
  revision: string;
  accountEmail: string | null;
  spaces: Array<{ id: string; name: string }>;
}

export const adminTariffApi = {
  async previewDriveApproval(ownerId: string, email: string): Promise<DriveApprovalPreview> {
    const value = asRecord(
      single(
        await tariffRpc('admin_preview_drive_account', {
          p_owner: ownerId,
          p_email: email
        })
      )
    );
    if (
      !value ||
      typeof value.revision !== 'string' ||
      !Array.isArray(value.spaces) ||
      !value.spaces.every(item => {
        const row = asRecord(item);
        return row && typeof row.id === 'string' && typeof row.name === 'string';
      })
    )
      throw new TeamApiError('INVALID_RESPONSE', false);
    return {
      revision: value.revision,
      accountEmail: typeof value.accountEmail === 'string' ? value.accountEmail : null,
      spaces: value.spaces as DriveApprovalPreview['spaces']
    };
  },

  async listTariffs(): Promise<AdminTariffRow[]> {
    return parsedOrThrow(parseAdminTariffRows((await tariffRpc('admin_list_space_tariffs')) ?? []));
  },

  async listPlans(): Promise<TariffPlan[]> {
    return parsedOrThrow(parseTariffPlans((await tariffRpc('admin_list_tariff_plans')) ?? []));
  },

  async listOwnerSpaces(email: string): Promise<AdminOwnerSpace[]> {
    return parsedOrThrow(
      parseAdminOwnerSpaces((await tariffRpc('admin_list_owner_spaces', { p_email: email })) ?? [])
    );
  },

  async preview(email: string, teamId: string | null): Promise<AdminTariffPreview> {
    return parsedOrThrow(
      parseAdminTariffPreview(
        single(await tariffRpc('admin_preview_space_tariff', { p_email: email, p_team: teamId }))
      )
    );
  },

  async pendingGrant(): Promise<AdminGrantTariffInput | null> {
    const { data } = await requireSupabaseClient().auth.getSession();
    return data.session ? (pendingTariffGrant(data.session.user.id)?.input ?? null) : null;
  },

  async grant(input: AdminGrantTariffInput): Promise<AdminTariffRow> {
    const { data } = await requireSupabaseClient().auth.getSession();
    if (!data.session) throw new TeamApiError('PERMISSION_DENIED', false);
    if (!navigator.locks) throw new TariffGrantIntentError('storage');
    const actor = data.session.user.id;
    return navigator.locks.request(`soty.tariff-grant:${actor}`, () =>
      executeTariffGrant(
        actor,
        { ...input, source: input.source ?? 'manual' },
        async (operation, savedInput) =>
          parsedOrThrow(
            parseAdminTariffRow(
              single(
                await tariffRpc('admin_grant_space_tariff_once', {
                  p_operation: operation,
                  p_input: savedInput
                })
              )
            )
          ),
        error =>
          error instanceof TeamApiError &&
          [
            'INVALID_INPUT',
            'PERMISSION_DENIED',
            'SEATS_IN_USE',
            'TARIFF_BOUND',
            'TARIFF_DATE_INVALID',
            'WRONG_STATE',
            'NOT_FOUND',
            'NAME_CONFLICT'
          ].includes(error.code)
      )
    );
  },

  async update(input: AdminUpdateTariffInput): Promise<AdminTariffRow> {
    return parsedOrThrow(
      parseAdminTariffRow(
        single(
          await (input.expectedUpdatedAt
            ? mutateTariff(input.id, input.expectedUpdatedAt, 'update', {
                plan: input.plan,
                endsOn: input.endsOn,
                extraSeats: input.extraSeats,
                approvedGoogleEmail: input.approvedGoogleEmail,
                googleApprovalRevision: input.googleApprovalRevision,
                note: input.note,
                externalRef: input.externalRef
              })
            : tariffRpc('admin_update_space_tariff', {
                p_id: input.id,
                p_plan: input.plan,
                p_ends_on: input.endsOn,
                p_extra_seats: input.extraSeats,
                p_note: input.note,
                p_external_ref: input.externalRef
              }))
        )
      )
    );
  },

  /** The returned row carries `eventId`, which is what the toast's Undo takes back. */
  async extend(
    id: string,
    months: number,
    notify = false,
    expectedUpdatedAt?: string
  ): Promise<AdminTariffRow> {
    return parsedOrThrow(
      parseAdminTariffRow(
        single(
          await (expectedUpdatedAt
            ? mutateTariff(id, expectedUpdatedAt, 'extend', { months, notify })
            : tariffRpc('admin_extend_space_tariff', {
                p_id: id,
                p_months: months,
                p_notify: notify
              }))
        )
      )
    );
  },

  /** `now=false` ends the term today (three more days follow); `true` closes the space at once. */
  async end(id: string, now: boolean, expectedUpdatedAt?: string): Promise<AdminTariffRow> {
    return parsedOrThrow(
      parseAdminTariffRow(
        single(
          await (expectedUpdatedAt
            ? mutateTariff(id, expectedUpdatedAt, 'end', { now })
            : tariffRpc('admin_end_space_tariff', { p_id: id, p_now: now }))
        )
      )
    );
  },

  async undo(eventId: string): Promise<AdminTariffRow> {
    return parsedOrThrow(
      parseAdminTariffRow(
        single(await tariffRpc('admin_undo_space_tariff_event', { p_event: eventId }))
      )
    );
  },

  async listEvents(id: string): Promise<AdminTariffEvent[]> {
    return parsedOrThrow(
      parseAdminTariffEvents(
        (await tariffRpc('admin_list_space_tariff_events', { p_id: id })) ?? []
      )
    );
  },

  async listSeats(teamId: string): Promise<AdminTariffSeat[]> {
    return parsedOrThrow(
      parseAdminTariffSeats((await tariffRpc('admin_list_tariff_seats', { p_team: teamId })) ?? [])
    );
  },

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    return (
      (await tariffRpc('admin_remove_tariff_member', { p_team: teamId, p_user: userId })) === true
    );
  },

  async revokeInvitation(invitationId: string): Promise<boolean> {
    return (
      (await tariffRpc('admin_revoke_tariff_invitation', { p_invitation: invitationId })) === true
    );
  },

  async listLegacySpaces(): Promise<AdminLegacySpace[]> {
    return parsedOrThrow(
      parseAdminLegacySpaces((await tariffRpc('admin_list_legacy_spaces')) ?? [])
    );
  },

  async listRequests(): Promise<AdminSpaceRequest[]> {
    return parsedOrThrow(
      parseAdminSpaceRequests((await tariffRpc('admin_list_space_requests')) ?? [])
    );
  },

  async markRequest(
    userId: string,
    handled: boolean,
    note: string | null = null
  ): Promise<boolean> {
    return (
      (await tariffRpc('admin_mark_space_request', {
        p_user: userId,
        p_handled: handled,
        p_note: note
      })) === true
    );
  },

  async getSettings(): Promise<AdminTariffSettings> {
    return parsedOrThrow(
      parseAdminTariffSettings(single(await tariffRpc('admin_get_tariff_settings')))
    );
  },

  async setSettings(input: {
    telegram: string | null;
    email: string | null;
    legacyRuleEnabled: boolean;
    confirm?: boolean;
  }): Promise<AdminTariffSettings> {
    return parsedOrThrow(
      parseAdminTariffSettings(
        single(
          await tariffRpc('admin_set_tariff_settings', {
            p_telegram: input.telegram,
            p_email: input.email,
            p_legacy_rule_enabled: input.legacyRuleEnabled,
            p_confirm: input.confirm ?? false
          })
        )
      )
    );
  }
};

export interface AdminUserMatch {
  id: string;
  email: string;
  name: string | null;
}

/** 034 — accounts whose address starts like the one being typed, for the grant dialog. */
export async function searchAdminUsers(query: string): Promise<AdminUserMatch[]> {
  const data = await tariffRpc('admin_list_users', { p_search: query, p_limit: 6, p_offset: 0 });
  if (!Array.isArray(data)) return [];
  return data.flatMap(item => {
    const row = asRecord(item);
    if (!row || typeof row.id !== 'string' || typeof row.email !== 'string') return [];
    return [
      {
        id: row.id,
        email: row.email,
        name: typeof row.display_name === 'string' && row.display_name ? row.display_name : null
      }
    ];
  });
}

export type AdminTariffClient = typeof adminTariffApi & {
  searchUsers?: (query: string) => Promise<AdminUserMatch[]>;
};

export { throwRpc };
export { launchApi } from './launches';
