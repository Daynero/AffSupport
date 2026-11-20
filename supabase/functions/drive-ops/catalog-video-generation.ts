import type { CatalogVideoForegroundProgressExecutor } from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import type { CatalogCreationVideoPreferences } from './product-catalog.ts';
import type { CatalogVideoCellDelivery } from '../_shared/product-catalog.ts';
import { parseCatalogVideoPublication } from '../../../packages/shared/dist/team/catalog-publication.js';
import { distributeVariations } from '../../../packages/shared/dist/team/launches.js';
import { TeamFunctionError } from '../_shared/errors.ts';

export interface CatalogInitialVideoReadRequest {
  teamId: string;
  idempotencyKey: string;
  expectedActorId: string;
}
export interface CatalogInitialVideoCancelRequest extends CatalogInitialVideoReadRequest {
  requestId: string;
}
export type CatalogInitialVideoReadResult =
  CatalogVideoPreparingResult | import('./product-catalog.ts').CreateProductCatalogResult | null;
export interface CatalogVideoGenerationProgress {
  videoSetId: string;
  requestedCount: number;
  registeredCount: number;
  state: 'preparing' | 'ready' | 'unknown' | 'cancel_requested' | 'canceled';
  catalogVideoCells: 'deferred_blank' | 'assigned';
  executor?: CatalogVideoForegroundProgressExecutor;
  publicationHeld?: boolean;
  providerCas?: 'unsupported';
  /** 062: every restitch set of a several-video catalog, in segment order (videoSetId is the first). */
  videoSets?: CatalogVideoSetRef[];
}
/** 062: one segment's restitch set, as receipts and waits name it. */
export interface CatalogVideoSetRef {
  ordinal: number;
  setId: string;
  sourceMaterialId: string;
}
const SET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** A stored set list, or null when absent or not exactly well-formed. */
export function parseCatalogVideoSetRefs(raw: unknown): CatalogVideoSetRef[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 400) return null;
  const sets: CatalogVideoSetRef[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(v.ordinal) ||
      Number(v.ordinal) < 0 ||
      Number(v.ordinal) > 399 ||
      typeof v.setId !== 'string' ||
      !SET_UUID.test(v.setId) ||
      typeof v.sourceMaterialId !== 'string' ||
      !SET_UUID.test(v.sourceMaterialId)
    )
      return null;
    sets.push({ ordinal: Number(v.ordinal), setId: v.setId, sourceMaterialId: v.sourceMaterialId });
  }
  return sets;
}
export function parseCatalogVideoGenerationProgress(
  raw: unknown
): CatalogVideoGenerationProgress | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.executor !== undefined && !parseForegroundProgress(p.executor)) return null;
  if (
    typeof p.videoSetId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      p.videoSetId
    ) ||
    !Number.isSafeInteger(p.requestedCount) ||
    Number(p.requestedCount) < 1 ||
    Number(p.requestedCount) > 400 ||
    !Number.isSafeInteger(p.registeredCount) ||
    Number(p.registeredCount) < 0 ||
    Number(p.registeredCount) > Number(p.requestedCount) ||
    !['preparing', 'ready', 'unknown', 'cancel_requested', 'canceled'].includes(String(p.state)) ||
    !['deferred_blank', 'assigned'].includes(String(p.catalogVideoCells)) ||
    (p.publicationHeld !== undefined && typeof p.publicationHeld !== 'boolean') ||
    (p.providerCas !== undefined && p.providerCas !== 'unsupported') ||
    (p.videoSets !== undefined && !parseCatalogVideoSetRefs(p.videoSets))
  )
    return null;
  return {
    ...(p.executor ? { executor: parseForegroundProgress(p.executor)! } : {}),
    videoSetId: p.videoSetId,
    requestedCount: Number(p.requestedCount),
    registeredCount: Number(p.registeredCount),
    state: p.state as CatalogVideoGenerationProgress['state'],
    catalogVideoCells: p.catalogVideoCells as CatalogVideoGenerationProgress['catalogVideoCells'],
    ...(p.publicationHeld === undefined ? {} : { publicationHeld: p.publicationHeld as boolean }),
    ...(p.providerCas === undefined ? {} : { providerCas: 'unsupported' as const }),
    ...(p.videoSets === undefined ? {} : { videoSets: parseCatalogVideoSetRefs(p.videoSets)! })
  };
}
export interface CatalogVideoPreparingResult {
  executor?: CatalogVideoForegroundProgressExecutor;
  outcome: 'preparing_video';
  catalogIntentId: string;
  videoSetId: string;
  requestedCount: number;
  registeredCount: number;
  state: 'preparing' | 'unknown' | 'cancel_requested' | 'canceled';
  /** The agent running this creation stopped heartbeating two minutes ago. */
  agentSilent?: true;
  /** 062: every restitch set of a several-video catalog, so each can be settled on its own. */
  videoSets?: CatalogVideoSetRef[];
  /** 062: the first segment whose set cannot be proven (its video stopped the catalog). */
  failedOrdinal?: number;
}
export class CatalogVideoPreparationPending extends Error {
  constructor(readonly result: CatalogVideoPreparingResult) {
    super('CATALOG_VIDEO_PREPARING');
  }
}
export interface CatalogInitialVideoPlan {
  preferences: CatalogCreationVideoPreferences;
  acceptedAt: number;
  /** The first video's set; with segments, `segments[0].setId`. */
  setId: string | null;
  recipeRowIds: string[];
  /** All variation requests in segment order: the old length check (= videoVariationCount) holds. */
  childRequestIds: string[];
  assignmentSeed: string;
  recipeRevision?: 1;
  /** 062 (plan V2): one block of rows per creative; absent on plans from before (one video). */
  segments?: CatalogCreativeSegment[];
}

export type CatalogCreativeKind = 'video' | 'image';
/** 062: one creative's contiguous block of rows and, for a restitched video, its own set. */
export interface CatalogCreativeSegment {
  ordinal: number;
  materialId: string;
  alias: string;
  kind: CatalogCreativeKind;
  rowStart: number;
  rowCount: number;
  /** Video: its share of the variations (1 without restitch); image: 0. */
  variantCount: number;
  setId: string | null;
  childRequestIds: string[];
  /** hex(sha256(plan seed ‖ ':' ‖ ordinal)); for a single creative, the plan seed itself. */
  assignmentSeed: string;
}
export interface CatalogPlanCreative {
  materialId: string;
  alias: string;
  copies: number;
}

/** Segment seed shared with SQL: hex(sha256(`${seed}:${ordinal}`)), 64 lowercase hex. */
export async function catalogSegmentSeed(seed: string, ordinal: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${seed}:${ordinal}`)
  );
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Plan V2 (062): the single-video plan, cut into one block per creative. A single creative keeps
 * exactly the plan it always had (same set, seed and requests), so reuse and old readers agree.
 * With several videos each restitched one gets its own set and its share of the variations,
 * round-robin; the request ids stay one list whose slices belong to the segments in order.
 */
export async function createCatalogInitialVideoPlanV2(
  preferences: CatalogCreationVideoPreferences,
  kind: CatalogCreativeKind,
  creatives: readonly CatalogPlanCreative[],
  productCount: number,
  serverNow: number
): Promise<CatalogInitialVideoPlan> {
  const k = creatives.length;
  if (
    k < 1 ||
    k > productCount ||
    creatives.reduce((total, creative) => total + creative.copies, 0) !== productCount ||
    creatives.some(creative => !Number.isSafeInteger(creative.copies) || creative.copies < 1) ||
    (kind === 'image' && preferences.restitchEnabled) ||
    (preferences.restitchEnabled && preferences.videoVariationCount < k)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const plan = createCatalogInitialVideoPlan(preferences, productCount, serverNow);
  const restitch = kind === 'video' && preferences.restitchEnabled;
  const variants =
    kind === 'image'
      ? creatives.map(() => 0)
      : restitch
        ? k === 1
          ? [preferences.videoVariationCount]
          : distributeVariations(
              creatives.map(creative => creative.copies),
              preferences.videoVariationCount
            )
        : creatives.map(() => 1);
  const segments: CatalogCreativeSegment[] = [];
  let rowStart = 0;
  let requestStart = 0;
  for (const [ordinal, creative] of creatives.entries()) {
    const variantCount = variants[ordinal]!;
    const childRequestIds = restitch
      ? plan.childRequestIds.slice(requestStart, requestStart + variantCount)
      : [];
    segments.push({
      ordinal,
      materialId: creative.materialId,
      alias: creative.alias,
      kind,
      rowStart,
      rowCount: creative.copies,
      variantCount,
      setId: restitch ? (ordinal === 0 ? plan.setId : crypto.randomUUID()) : null,
      childRequestIds,
      assignmentSeed:
        k === 1 ? plan.assignmentSeed : await catalogSegmentSeed(plan.assignmentSeed, ordinal)
    });
    rowStart += creative.copies;
    requestStart += childRequestIds.length;
  }
  return { ...plan, segments };
}

/** The segments of a plan, checked against its rows; null for a plan from before 062. */
export function catalogPlanSegments(
  plan: Pick<CatalogInitialVideoPlan, 'segments' | 'recipeRowIds' | 'childRequestIds'>
): CatalogCreativeSegment[] | null {
  if (plan.segments === undefined) return null;
  const segments = plan.segments;
  if (!Array.isArray(segments) || segments.length < 1)
    throw new TeamFunctionError('INVALID_RESPONSE');
  let rowStart = 0;
  const requests: string[] = [];
  for (const [ordinal, segment] of segments.entries()) {
    if (
      !segment ||
      segment.ordinal !== ordinal ||
      segment.rowStart !== rowStart ||
      !Number.isSafeInteger(segment.rowCount) ||
      segment.rowCount < 1 ||
      (segment.kind !== 'video' && segment.kind !== 'image') ||
      segment.kind !== segments[0]!.kind ||
      !Array.isArray(segment.childRequestIds) ||
      (segment.setId !== null && segment.childRequestIds.length !== segment.variantCount) ||
      typeof segment.assignmentSeed !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(segment.assignmentSeed)
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    rowStart += segment.rowCount;
    requests.push(...segment.childRequestIds);
  }
  if (
    rowStart !== plan.recipeRowIds.length ||
    JSON.stringify(requests) !== JSON.stringify(plan.childRequestIds)
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return segments;
}

/** The recipe rows of one segment, in plan order. */
export function catalogSegmentRowIds(
  plan: Pick<CatalogInitialVideoPlan, 'recipeRowIds'>,
  segment: Pick<CatalogCreativeSegment, 'rowStart' | 'rowCount'>
): string[] {
  return plan.recipeRowIds.slice(segment.rowStart, segment.rowStart + segment.rowCount);
}

/** The restitched video segments of a plan (each with its set), or the one set of an older plan. */
export function catalogPlanVideoSets(
  plan: CatalogInitialVideoPlan,
  primaryMaterialId: string
): Array<{
  ordinal: number;
  setId: string;
  sourceMaterialId: string;
  rowIds: string[];
  variantCount: number;
}> {
  const segments = catalogPlanSegments(plan);
  if (!segments)
    return plan.setId
      ? [
          {
            ordinal: 0,
            setId: plan.setId,
            sourceMaterialId: primaryMaterialId,
            rowIds: [...plan.recipeRowIds],
            variantCount: plan.preferences.videoVariationCount
          }
        ]
      : [];
  return segments.flatMap(segment =>
    segment.setId
      ? [
          {
            ordinal: segment.ordinal,
            setId: segment.setId,
            sourceMaterialId: segment.materialId,
            rowIds: catalogSegmentRowIds(plan, segment),
            variantCount: segment.variantCount
          }
        ]
      : []
  );
}
/** Called only after the canonical intent exists. Persist this complete plan
 * before admitting children: retries keep identifiers, rows and the original due. */
export function createCatalogInitialVideoPlan(
  preferences: CatalogCreationVideoPreferences,
  productCount: number,
  serverNow: number
): CatalogInitialVideoPlan {
  const publication = parseCatalogVideoPublication(preferences.videoPublication, serverNow);
  if (
    !Number.isSafeInteger(productCount) ||
    productCount < 1 ||
    productCount > 400 ||
    !Number.isSafeInteger(preferences.videoVariationCount) ||
    preferences.videoVariationCount < 1 ||
    preferences.videoVariationCount > productCount
  )
    throw new TeamFunctionError('INVALID_INPUT');
  return {
    preferences: { ...structuredClone(preferences), videoPublication: publication },
    acceptedAt: serverNow,
    recipeRevision: 1,
    assignmentSeed: Array.from(crypto.getRandomValues(new Uint8Array(32)), b =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    setId: preferences.restitchEnabled ? crypto.randomUUID() : null,
    recipeRowIds: Array.from({ length: productCount }, () => crypto.randomUUID()),
    childRequestIds: preferences.restitchEnabled
      ? Array.from({ length: preferences.videoVariationCount }, () => crypto.randomUUID())
      : []
  };
}
export interface CatalogInitialVideoAuthority {
  /** Whether this stack's targeted cell writer will publish deferred links
   * (see targetedCatalogWriterEnabled). Absent means unknown, reported as
   * unsupported. */
  readonly targetedWriterEnabled?: boolean;
  serverNow(): Promise<number>;
  prepare(input: { intentId: string; plan: CatalogInitialVideoPlan }): Promise<
    | {
        state: 'ready';
        videoLinks: readonly string[];
        executor?: CatalogVideoForegroundProgressExecutor;
      }
    | {
        state: 'preparing' | 'unknown' | 'cancel_requested' | 'canceled';
        registeredCount: number;
        executor?: CatalogVideoForegroundProgressExecutor;
        /** 062: the first segment whose set holds an unprovable variation. */
        failedOrdinal?: number;
      }
  >;
  /** Trusted post-creation readback registers the initial blank/delivered target.
   * No client flag or metadata URL constitutes this proof. */
  registerCreated(input: {
    intentId: string;
    plan: CatalogInitialVideoPlan;
    catalogMaterialId: string;
  }): Promise<void>;
  /** Claims one paced re-verification of a registered intent's initial
   * publication in its own transaction: 'go' runs it, 'paced' and 'exhausted'
   * skip it, 'done' means nothing is owed. */
  claimReverify?(intentId: string): Promise<'go' | 'paced' | 'exhausted' | 'done'>;
  /** Records the closed code a re-verification attempt ended with. */
  noteReverify?(intentId: string, code: string): Promise<void>;
}
/** The plan's restitch sets when there are several; null for one set or none. */
function planSetRefs(plan: CatalogInitialVideoPlan): CatalogVideoSetRef[] | null {
  const sets = (plan.segments ?? []).flatMap(segment =>
    segment.setId
      ? [{ ordinal: segment.ordinal, setId: segment.setId, sourceMaterialId: segment.materialId }]
      : []
  );
  return sets.length > 1 ? sets : null;
}
export async function prepareCatalogInitialVideo(
  authority: CatalogInitialVideoAuthority,
  intentId: string,
  plan: CatalogInitialVideoPlan,
  observe?: (progress: CatalogVideoGenerationProgress) => void
): Promise<CatalogVideoCellDelivery | undefined> {
  if (!plan.preferences.restitchEnabled) {
    if (plan.preferences.videoPublication.mode === 'scheduled') return { kind: 'deferred' };
    return undefined;
  }
  const result = await authority.prepare({ intentId, plan: structuredClone(plan) });
  const scheduled = plan.preferences.videoPublication.mode === 'scheduled';
  observe?.({
    videoSetId: plan.setId!,
    requestedCount: plan.preferences.videoVariationCount,
    registeredCount:
      result.state === 'ready' ? plan.preferences.videoVariationCount : result.registeredCount,
    state: result.state,
    ...(result.executor ? { executor: result.executor } : {}),
    catalogVideoCells: scheduled ? 'deferred_blank' : 'assigned',
    // Only a stack whose cell writer answers may promise the deferred link.
    ...(scheduled && !authority.targetedWriterEnabled
      ? { providerCas: 'unsupported' as const }
      : {}),
    ...(scheduled ? { publicationHeld: false } : {}),
    ...(planSetRefs(plan) ? { videoSets: planSetRefs(plan)! } : {})
  });
  if (
    scheduled &&
    (result.state === 'ready' || result.state === 'preparing' || result.state === 'unknown')
  )
    return { kind: 'deferred' };
  if (result.state !== 'ready')
    throw new CatalogVideoPreparationPending({
      outcome: 'preparing_video',
      catalogIntentId: intentId,
      videoSetId: plan.setId!,
      requestedCount: plan.preferences.videoVariationCount,
      registeredCount: result.registeredCount,
      state: result.state,
      ...(result.executor ? { executor: result.executor } : {}),
      ...(planSetRefs(plan) ? { videoSets: planSetRefs(plan)! } : {}),
      ...('failedOrdinal' in result && typeof result.failedOrdinal === 'number'
        ? { failedOrdinal: result.failedOrdinal }
        : {})
    });
  if (
    result.videoLinks.length !== plan.recipeRowIds.length ||
    result.videoLinks.some(link => {
      try {
        return new URL(link).protocol !== 'https:';
      } catch {
        return true;
      }
    })
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return plan.preferences.videoPublication.mode === 'scheduled'
    ? { kind: 'deferred' }
    : { kind: 'assigned', videoLinks: [...result.videoLinks] };
}

export async function readCatalogInitialVideoProgress(
  service: import('../_shared/credentials.ts').ServiceRpcClient,
  actorId: string,
  body: unknown
): Promise<
  CatalogVideoPreparingResult | import('./product-catalog.ts').CreateProductCatalogResult | null
> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new TeamFunctionError('INVALID_INPUT');
  const value = body as Record<string, unknown>;
  if (
    value.expectedActorId !== actorId ||
    typeof value.teamId !== 'string' ||
    typeof value.idempotencyKey !== 'string'
  )
    throw new TeamFunctionError('PERMISSION_DENIED');
  const result = await service.rpc('service_read_initial_catalog_video', {
    p_team: value.teamId,
    p_actor: actorId,
    p_key: value.idempotencyKey
  });
  if (result.error) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  if (result.data === null) return null;
  const data = result.data as Record<string, unknown>;
  if (
    data &&
    ['created', 'recreated', 'existing'].includes(String(data.outcome)) &&
    typeof data.videoShared === 'boolean' &&
    data.catalog &&
    typeof data.catalog === 'object' &&
    typeof (data.catalog as Record<string, unknown>).materialId === 'string'
  )
    return data as unknown as import('./product-catalog.ts').CreateProductCatalogResult;
  if (
    !data ||
    data.outcome !== 'preparing_video' ||
    typeof data.catalogIntentId !== 'string' ||
    typeof data.videoSetId !== 'string' ||
    typeof data.requestedCount !== 'number' ||
    typeof data.registeredCount !== 'number' ||
    !Number.isSafeInteger(data.requestedCount) ||
    !Number.isSafeInteger(data.registeredCount) ||
    data.registeredCount < 0 ||
    data.registeredCount > data.requestedCount ||
    !['preparing', 'unknown', 'cancel_requested', 'canceled'].includes(String(data.state))
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return data as unknown as CatalogVideoPreparingResult;
}

export async function cancelCatalogInitialVideo(
  service: import('../_shared/credentials.ts').ServiceRpcClient,
  actorId: string,
  body: unknown
): Promise<
  CatalogVideoPreparingResult | import('./product-catalog.ts').CreateProductCatalogResult
> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new TeamFunctionError('INVALID_INPUT');
  const value = body as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (value.expectedActorId !== actorId) throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    typeof value.teamId !== 'string' ||
    !uuid.test(value.teamId) ||
    typeof value.idempotencyKey !== 'string' ||
    typeof value.requestId !== 'string' ||
    !uuid.test(value.requestId)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const result = await service.rpc('service_cancel_initial_catalog_video', {
    p_team: value.teamId,
    p_actor: actorId,
    p_key: value.idempotencyKey,
    p_request: value.requestId
  });
  if (result.error)
    throw new TeamFunctionError(
      result.error.message === 'PERMISSION_DENIED'
        ? 'PERMISSION_DENIED'
        : result.error.message === 'WRONG_STATE'
          ? 'WRONG_STATE'
          : 'PROCESS_RESULT_UNCERTAIN'
    );
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    const created = result.data as Record<string, unknown>;
    if (
      ['created', 'recreated', 'existing'].includes(String(created.outcome)) &&
      created.catalog &&
      typeof created.catalog === 'object' &&
      parseCatalogVideoGenerationProgress(created.videoGenerationObservation)
    )
      return created as unknown as import('./product-catalog.ts').CreateProductCatalogResult;
  }
  const data = result.data as CatalogVideoPreparingResult;
  if (
    !data ||
    data.outcome !== 'preparing_video' ||
    !['cancel_requested', 'canceled'].includes(data.state)
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return data;
}

/** Backend-only accepted request reconstruction for explicit resume after reopen.
 * Callers supply only identity; frozen content remains inside the server. */
export async function readAcceptedInitialCatalogRequest(
  service: import('../_shared/credentials.ts').ServiceRpcClient,
  actorId: string,
  body: unknown
): Promise<Record<string, unknown>> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new TeamFunctionError('INVALID_INPUT');
  const value = body as Record<string, unknown>;
  if (
    value.expectedActorId !== actorId ||
    typeof value.teamId !== 'string' ||
    typeof value.idempotencyKey !== 'string'
  )
    throw new TeamFunctionError('PERMISSION_DENIED');
  const result = await service.rpc('service_read_initial_catalog_request', {
    p_team: value.teamId,
    p_actor: actorId,
    p_key: value.idempotencyKey
  });
  if (result.error || !result.data || typeof result.data !== 'object' || Array.isArray(result.data))
    throw new TeamFunctionError('WRONG_STATE');
  return result.data as Record<string, unknown>;
}

function parseForegroundProgress(raw: unknown): CatalogVideoForegroundProgressExecutor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  return p.mode === 'paired_session' &&
    typeof p.enrollmentId === 'string' &&
    uuid.test(p.enrollmentId) &&
    typeof p.nativeInstanceId === 'string' &&
    uuid.test(p.nativeInstanceId)
    ? { mode: 'paired_session', enrollmentId: p.enrollmentId, nativeInstanceId: p.nativeInstanceId }
    : null;
}

/** Current writer capability over a stored receipt: the SQL snapshots stamp
 * `providerCas: 'unsupported'` unconditionally, so a stack whose targeted
 * writer answers removes the stamp from the progress it hands back. Receipts
 * themselves are never rewritten. */
export function withCatalogVideoWriter<T>(value: T, targetedWriterEnabled: boolean): T {
  if (!targetedWriterEnabled || !value || typeof value !== 'object' || Array.isArray(value))
    return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const key of ['videoGeneration', 'videoGenerationObservation']) {
    const progress = copy[key];
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const rest = { ...(progress as Record<string, unknown>) };
      delete rest.providerCas;
      copy[key] = rest;
    }
  }
  return copy as T;
}
