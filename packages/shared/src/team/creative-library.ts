import {
  GEO_CODES,
  LANGUAGE_CODES,
  isRecord,
  normalizeMimeType,
  normalizeTeamFreeText
} from './contract.js';
import { TEAM_ERROR_CODES, type TeamErrorCode } from './transport.js';
import { MATERIAL_CATEGORIES, type MaterialCategory } from './material-category.js';

/** Creative Library placement, batch, enrichment and sharing contracts. */

export const LIBRARY_STAGES = ['finds', 'library'] as const;
export type LibraryStage = (typeof LIBRARY_STAGES)[number];

export const LIBRARY_PLACEMENT_STATES = [
  'unplaced',
  'planning',
  'moving',
  'ready',
  'reconciling',
  'failed'
] as const;
export type LibraryPlacementState = (typeof LIBRARY_PLACEMENT_STATES)[number];

export const LIBRARY_ENRICHMENT_KINDS = ['language', 'thumbnail', 'landing_preview'] as const;
export type LibraryEnrichmentKind = (typeof LIBRARY_ENRICHMENT_KINDS)[number];

export const LIBRARY_ENRICHMENT_STATES = [
  'pending',
  'running',
  'ready',
  'unknown',
  'failed',
  'stale',
  'canceled'
] as const;
export type LibraryEnrichmentState = (typeof LIBRARY_ENRICHMENT_STATES)[number];

export const LIBRARY_UPLOAD_REQUEST_MAX_ITEMS = 500;
export const LIBRARY_UPLOAD_MIN_SUPPORTED_SELECTION = 100;
export const LIBRARY_VIDEO_THUMBNAIL_TARGET_MS = 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLIENT_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{7,127}$/iu;
const LANGUAGE_SET = new Set<string>(LANGUAGE_CODES);
const GEO_SET = new Set<string>(GEO_CODES);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function normalizeRequiredText(value: unknown, maxLength: number): string | null {
  return normalizeTeamFreeText(value, maxLength);
}

function normalizeLanguage(value: unknown, allowUnknown = false): string | null {
  if (allowUnknown && value === 'unknown') return 'unknown';
  return typeof value === 'string' && LANGUAGE_SET.has(value) ? value : null;
}

export interface LibraryPlacement {
  stage: LibraryStage;
  offer: string;
  language: string;
  type: string;
}

export interface LibraryPlacementMutationRequest {
  teamId: string;
  materialIds: string[];
  targetStage: LibraryStage;
  placement?: LibraryPlacement;
  idempotencyKey: string;
}

export function parseLibraryPlacementMutation(
  value: unknown
): LibraryPlacementMutationRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['teamId', 'materialIds', 'targetStage', 'placement', 'idempotencyKey']) ||
    !isUuid(value.teamId) ||
    !Array.isArray(value.materialIds) ||
    value.materialIds.length < 1 ||
    value.materialIds.length > 100 ||
    typeof value.targetStage !== 'string' ||
    !(LIBRARY_STAGES as readonly string[]).includes(value.targetStage) ||
    typeof value.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotencyKey)
  ) {
    return null;
  }
  const materialIds: string[] = [];
  const seen = new Set<string>();
  for (const materialId of value.materialIds) {
    if (!isUuid(materialId) || seen.has(materialId)) return null;
    seen.add(materialId);
    materialIds.push(materialId);
  }
  const placement =
    value.placement === undefined ? undefined : parseLibraryPlacement(value.placement);
  if (value.placement !== undefined && !placement) return null;
  if (placement && placement.stage !== value.targetStage) return null;
  return {
    teamId: value.teamId,
    materialIds,
    targetStage: value.targetStage as LibraryStage,
    ...(placement ? { placement } : {}),
    idempotencyKey: value.idempotencyKey
  };
}

export interface LibraryAssetSummary {
  id: string;
  teamId: string;
  name: string;
  category: MaterialCategory | null;
  mimeType: string | null;
  fileExtension: string | null;
  sizeBytes: number | null;
  lifecycle: 'active' | 'trashed' | 'missing';
  sourceVersion: string | null;
  stage: LibraryStage;
  offer: string;
  language: string;
  type: string;
  placementState: LibraryPlacementState;
  languageDecisionSource: 'manual' | 'automatic' | 'unknown' | null;
  thumbnailState: LibraryEnrichmentState;
  thumbnailTimeMs: number | null;
  createdAt: string;
}

export function parseLibraryAssetSummary(value: unknown): LibraryAssetSummary | null {
  if (!isRecord(value)) return null;
  const stage = value.stage ?? value.library_stage;
  const offer = value.offer ?? value.structural_offer;
  const language = value.language ?? value.structural_language;
  const type = value.type ?? value.structural_type;
  const category = value.category;
  const placementState = value.placementState ?? value.placement_state;
  const decisionSource = value.languageDecisionSource ?? value.language_decision_source;
  const thumbnailState = value.thumbnailState ?? value.thumbnail_state;
  const thumbnailTimeMs = value.thumbnailTimeMs ?? value.thumbnail_time_ms;
  const sourceVersion = value.sourceVersion ?? value.source_version;
  const createdAt = value.createdAt ?? value.created_at;
  const teamId = value.teamId ?? value.team_id;
  const mimeType = value.mimeType ?? value.mime_type;
  const fileExtension = value.fileExtension ?? value.file_extension;
  const sizeBytes = value.sizeBytes ?? value.size_bytes;
  if (
    !isUuid(value.id) ||
    !isUuid(teamId) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 1_024 ||
    (category !== null &&
      (typeof category !== 'string' ||
        !(MATERIAL_CATEGORIES as readonly string[]).includes(category))) ||
    (mimeType !== null && typeof mimeType !== 'string') ||
    (fileExtension !== null && typeof fileExtension !== 'string') ||
    (sizeBytes !== null &&
      (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) ||
    !['active', 'trashed', 'missing'].includes(value.lifecycle as string) ||
    (sourceVersion !== null && typeof sourceVersion !== 'string') ||
    typeof stage !== 'string' ||
    !(LIBRARY_STAGES as readonly string[]).includes(stage) ||
    typeof offer !== 'string' ||
    typeof language !== 'string' ||
    typeof type !== 'string' ||
    typeof placementState !== 'string' ||
    !(LIBRARY_PLACEMENT_STATES as readonly string[]).includes(placementState) ||
    (decisionSource !== null &&
      !['manual', 'automatic', 'unknown'].includes(decisionSource as string)) ||
    typeof thumbnailState !== 'string' ||
    !(LIBRARY_ENRICHMENT_STATES as readonly string[]).includes(thumbnailState) ||
    (thumbnailTimeMs !== null &&
      (typeof thumbnailTimeMs !== 'number' || !Number.isInteger(thumbnailTimeMs))) ||
    typeof createdAt !== 'string' ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return null;
  }
  return {
    id: value.id,
    teamId,
    name: value.name,
    category: category as MaterialCategory | null,
    mimeType: mimeType as string | null,
    fileExtension: fileExtension as string | null,
    sizeBytes: sizeBytes as number | null,
    lifecycle: value.lifecycle as LibraryAssetSummary['lifecycle'],
    sourceVersion: sourceVersion as string | null,
    stage: stage as LibraryStage,
    offer,
    language,
    type,
    placementState: placementState as LibraryPlacementState,
    languageDecisionSource: decisionSource as LibraryAssetSummary['languageDecisionSource'],
    thumbnailState: thumbnailState as LibraryEnrichmentState,
    thumbnailTimeMs: thumbnailTimeMs as number | null,
    createdAt
  };
}

export function parseLibraryPlacement(value: unknown): LibraryPlacement | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['stage', 'offer', 'language', 'type']) ||
    typeof value.stage !== 'string' ||
    !(LIBRARY_STAGES as readonly string[]).includes(value.stage)
  ) {
    return null;
  }
  const offer = normalizeRequiredText(value.offer, 120);
  const language = normalizeLanguage(value.language, true);
  const type = normalizeRequiredText(value.type, 64);
  if (!offer || !language || !type) return null;
  return { stage: value.stage as LibraryStage, offer, language, type };
}

export type LibraryLanguageMode = 'manual' | 'auto';

export interface UploadBatchItemInput {
  clientItemKey: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadBatchRequest {
  teamId: string;
  stage: LibraryStage;
  offer: string;
  geo: string;
  languageMode: LibraryLanguageMode;
  language: string | null;
  typeHint?: string;
  items: UploadBatchItemInput[];
}

function parseUploadItem(value: unknown): UploadBatchItemInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['clientItemKey', 'name', 'mimeType', 'sizeBytes']) ||
    typeof value.clientItemKey !== 'string' ||
    !CLIENT_KEY.test(value.clientItemKey) ||
    typeof value.name !== 'string' ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > 100 * 1024 * 1024 * 1024
  ) {
    return null;
  }
  const name = normalizeRequiredText(value.name, 512);
  const mimeType = normalizeMimeType(value.mimeType);
  if (!name || !mimeType) return null;
  return { clientItemKey: value.clientItemKey, name, mimeType, sizeBytes: value.sizeBytes };
}

export function parseUploadBatchRequest(value: unknown): UploadBatchRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'teamId',
      'stage',
      'offer',
      'geo',
      'languageMode',
      'language',
      'typeHint',
      'items'
    ]) ||
    !isUuid(value.teamId) ||
    typeof value.stage !== 'string' ||
    !(LIBRARY_STAGES as readonly string[]).includes(value.stage) ||
    (value.languageMode !== 'manual' && value.languageMode !== 'auto') ||
    typeof value.geo !== 'string' ||
    !GEO_SET.has(value.geo) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > LIBRARY_UPLOAD_REQUEST_MAX_ITEMS
  ) {
    return null;
  }

  const offer = normalizeRequiredText(value.offer, 120);
  const language = value.languageMode === 'manual' ? normalizeLanguage(value.language) : null;
  const typeHint =
    value.typeHint === undefined ? undefined : normalizeRequiredText(value.typeHint, 64);
  if (!offer || (value.languageMode === 'manual' && !language)) {
    return null;
  }
  if (value.languageMode === 'auto' && value.language !== null && value.language !== undefined) {
    return null;
  }
  if (value.typeHint !== undefined && !typeHint) return null;

  const items: UploadBatchItemInput[] = [];
  const keys = new Set<string>();
  for (const rawItem of value.items) {
    const item = parseUploadItem(rawItem);
    if (!item || keys.has(item.clientItemKey)) return null;
    keys.add(item.clientItemKey);
    items.push(item);
  }

  return {
    teamId: value.teamId,
    stage: value.stage as LibraryStage,
    offer,
    geo: value.geo,
    languageMode: value.languageMode,
    language,
    ...(typeHint ? { typeHint } : {}),
    items
  };
}

export interface LibraryEnrichmentCommit {
  teamId: string;
  materialId: string;
  sourceVersion: string;
  kind: LibraryEnrichmentKind;
  decisionRevision: number;
  state: Extract<LibraryEnrichmentState, 'ready' | 'unknown' | 'failed'>;
  resultCode: string | null;
}

export function parseLibraryEnrichmentCommit(value: unknown): LibraryEnrichmentCommit | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'teamId',
      'materialId',
      'sourceVersion',
      'kind',
      'decisionRevision',
      'state',
      'resultCode'
    ]) ||
    !isUuid(value.teamId) ||
    !isUuid(value.materialId) ||
    typeof value.sourceVersion !== 'string' ||
    value.sourceVersion.length < 1 ||
    value.sourceVersion.length > 256 ||
    typeof value.kind !== 'string' ||
    !(LIBRARY_ENRICHMENT_KINDS as readonly string[]).includes(value.kind) ||
    !Number.isSafeInteger(value.decisionRevision) ||
    (value.decisionRevision as number) < 0 ||
    !['ready', 'unknown', 'failed'].includes(value.state as string) ||
    (value.resultCode !== null &&
      (typeof value.resultCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.resultCode)))
  ) {
    return null;
  }
  return {
    teamId: value.teamId,
    materialId: value.materialId,
    sourceVersion: value.sourceVersion,
    kind: value.kind as LibraryEnrichmentKind,
    decisionRevision: value.decisionRevision as number,
    state: value.state as LibraryEnrichmentCommit['state'],
    resultCode: value.resultCode as string | null
  };
}

export interface LibraryShareCopyRequest {
  teamId: string;
  materialId: string;
  allowIfRestricted: boolean;
  rememberChoice: boolean;
  idempotencyKey: string;
  /** Modern UI captures its intended actor before any refresh/session await. */
  expectedActorId?: string;
  expectedShareVersion?: string | null;
}

export function parseLibraryShareCopyRequest(value: unknown): LibraryShareCopyRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'teamId',
      'materialId',
      'allowIfRestricted',
      'rememberChoice',
      'idempotencyKey',
      'expectedActorId',
      'expectedShareVersion'
    ]) ||
    !isUuid(value.teamId) ||
    !isUuid(value.materialId) ||
    typeof value.allowIfRestricted !== 'boolean' ||
    typeof value.rememberChoice !== 'boolean' ||
    (value.rememberChoice && !value.allowIfRestricted) ||
    typeof value.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    (value.expectedActorId !== undefined && !isUuid(value.expectedActorId)) ||
    (value.expectedShareVersion !== undefined &&
      value.expectedShareVersion !== null &&
      !isUuid(value.expectedShareVersion))
  )
    return null;
  return {
    teamId: value.teamId,
    materialId: value.materialId,
    allowIfRestricted: value.allowIfRestricted,
    rememberChoice: value.rememberChoice,
    idempotencyKey: value.idempotencyKey,
    ...(value.expectedActorId !== undefined ? { expectedActorId: value.expectedActorId } : {}),
    ...(value.expectedShareVersion !== undefined
      ? { expectedShareVersion: value.expectedShareVersion }
      : {})
  };
}

export function trustedMaterialUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 8192 ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['drive.google.com', 'docs.google.com'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? value
      : null;
  } catch {
    return null;
  }
}
interface MaterialLinkEvidence {
  /** Missing is an older read-only server; never authorizes a mutation fallback. */
  linkProtocol?: 2;
  serverNow?: string;
  shareVersion?: string | null;
  sharing?: 'unchanged' | 'confirmed' | 'uncertain';
  visibilityCode?: TeamErrorCode;
  preferenceSaved?: boolean;
  preferenceCode?: TeamErrorCode;
  /** Returned only to the original actor, never another member's private ID. */
  pendingCommandId?: string;
}
export type LibraryShareCopyResult = MaterialLinkEvidence &
  (
    | {
        state: 'ready';
        url: string;
        public: boolean | null;
        permissionChanged: boolean | null;
        canShare?: boolean;
      }
    | {
        state: 'confirmation_required';
        url: string;
        public: false;
        canShare: boolean;
        permissionChanged?: false;
      }
  );
const shareErrorCodes = new Set<string>(TEAM_ERROR_CODES);
export function parseLibraryShareCopyResult(value: unknown): LibraryShareCopyResult | null {
  if (!isRecord(value)) return null;
  const url = trustedMaterialUrl(value.url);
  if (
    !url ||
    (value.linkProtocol !== undefined && value.linkProtocol !== 2) ||
    (value.canShare !== undefined && typeof value.canShare !== 'boolean') ||
    (value.sharing !== undefined &&
      (typeof value.sharing !== 'string' ||
        !['unchanged', 'confirmed', 'uncertain'].includes(value.sharing))) ||
    (value.serverNow !== undefined &&
      (typeof value.serverNow !== 'string' ||
        value.serverNow.length !== 24 ||
        !Number.isFinite(Date.parse(value.serverNow)) ||
        new Date(value.serverNow).toISOString() !== value.serverNow)) ||
    (value.linkProtocol === 2 &&
      (value.serverNow === undefined || value.shareVersion === undefined)) ||
    (value.shareVersion !== undefined &&
      value.shareVersion !== null &&
      !isUuid(value.shareVersion)) ||
    (value.pendingCommandId !== undefined && !isUuid(value.pendingCommandId)) ||
    (value.preferenceSaved !== undefined && typeof value.preferenceSaved !== 'boolean')
  )
    return null;
  for (const key of ['visibilityCode', 'preferenceCode'] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || !shareErrorCodes.has(value[key]))
    )
      return null;
  }
  if (value.preferenceCode !== undefined && value.preferenceSaved !== false) return null;
  if (value.public === null && (value.linkProtocol !== 2 || value.visibilityCode === undefined))
    return null;
  if (
    value.permissionChanged === null &&
    (value.linkProtocol !== 2 ||
      typeof value.sharing !== 'string' ||
      !['confirmed', 'uncertain'].includes(value.sharing))
  )
    return null;
  if (value.state === 'ready') {
    if (
      (typeof value.public !== 'boolean' && value.public !== null) ||
      (typeof value.permissionChanged !== 'boolean' && value.permissionChanged !== null)
    )
      return null;
  } else if (value.state === 'confirmation_required') {
    if (
      value.public !== false ||
      typeof value.canShare !== 'boolean' ||
      (value.permissionChanged !== undefined && value.permissionChanged !== false)
    )
      return null;
  } else return null;
  const result: Record<string, unknown> = { state: value.state, url, public: value.public };
  for (const key of [
    'permissionChanged',
    'canShare',
    'linkProtocol',
    'serverNow',
    'shareVersion',
    'sharing',
    'visibilityCode',
    'preferenceSaved',
    'preferenceCode',
    'pendingCommandId'
  ] as const) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result as unknown as LibraryShareCopyResult;
}

export const CREATIVE_LIBRARY_CONTRIBUTION_CATEGORIES = [
  'local_processing',
  'human_activity'
] as const;
export type CreativeLibraryContributionCategory =
  (typeof CREATIVE_LIBRARY_CONTRIBUTION_CATEGORIES)[number];

export const CREATIVE_LIBRARY_CONTRIBUTION_ACTIONS = [
  'transcription',
  'landing_optimization',
  'find_selected',
  'task_created',
  'task_completed',
  'batch_completed'
] as const;
export type CreativeLibraryContributionAction =
  (typeof CREATIVE_LIBRARY_CONTRIBUTION_ACTIONS)[number];

export const CREATIVE_LIBRARY_CONTRIBUTION_OUTCOMES = [
  'success',
  'failure',
  'canceled',
  'skipped'
] as const;
export type CreativeLibraryContributionOutcome =
  (typeof CREATIVE_LIBRARY_CONTRIBUTION_OUTCOMES)[number];

export const CREATIVE_LIBRARY_FORBIDDEN_FIELDS = Object.freeze([
  'email',
  'filename',
  'file_name',
  'path',
  'query',
  'transcript',
  'content',
  'drive_id',
  'folder_id',
  'material_id',
  'provider',
  'provider_id',
  'share_url',
  'grant',
  'grant_id',
  'ticket',
  'lease_token',
  'metadata',
  'offer',
  'tags',
  'geo',
  'language'
]);

export interface CreativeLibraryContribution {
  category: CreativeLibraryContributionCategory;
  action: CreativeLibraryContributionAction;
  outcome: CreativeLibraryContributionOutcome;
  agentInstanceId?: string;
}

const LOCAL_ACTIONS = new Set<CreativeLibraryContributionAction>([
  'transcription',
  'landing_optimization'
]);
const HUMAN_ACTIONS = new Set<CreativeLibraryContributionAction>([
  'find_selected',
  'task_created',
  'task_completed',
  'batch_completed'
]);

export function parseCreativeLibraryContribution(
  value: unknown
): CreativeLibraryContribution | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['category', 'action', 'outcome', 'agentInstanceId']) ||
    typeof value.category !== 'string' ||
    !(CREATIVE_LIBRARY_CONTRIBUTION_CATEGORIES as readonly string[]).includes(value.category) ||
    typeof value.action !== 'string' ||
    !(CREATIVE_LIBRARY_CONTRIBUTION_ACTIONS as readonly string[]).includes(value.action) ||
    typeof value.outcome !== 'string' ||
    !(CREATIVE_LIBRARY_CONTRIBUTION_OUTCOMES as readonly string[]).includes(value.outcome) ||
    (value.agentInstanceId !== undefined && !isUuid(value.agentInstanceId))
  ) {
    return null;
  }
  const action = value.action as CreativeLibraryContributionAction;
  if (value.category === 'local_processing' && !LOCAL_ACTIONS.has(action)) return null;
  if (value.category === 'human_activity' && !HUMAN_ACTIONS.has(action)) return null;
  if (value.category === 'human_activity' && value.agentInstanceId !== undefined) return null;
  return {
    category: value.category as CreativeLibraryContributionCategory,
    action,
    outcome: value.outcome as CreativeLibraryContributionOutcome,
    ...(value.agentInstanceId ? { agentInstanceId: value.agentInstanceId } : {})
  };
}
