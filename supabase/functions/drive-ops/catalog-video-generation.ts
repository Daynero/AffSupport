import type { CatalogVideoForegroundProgressExecutor } from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import type { CatalogCreationVideoPreferences } from './product-catalog.ts';
import type { CatalogVideoCellDelivery } from '../_shared/product-catalog.ts';
import { parseCatalogVideoPublication } from '../../../packages/shared/dist/team/catalog-publication.js';
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
    (p.providerCas !== undefined && p.providerCas !== 'unsupported')
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
    ...(p.providerCas === undefined ? {} : { providerCas: 'unsupported' as const })
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
}
export class CatalogVideoPreparationPending extends Error {
  constructor(readonly result: CatalogVideoPreparingResult) {
    super('CATALOG_VIDEO_PREPARING');
  }
}
export interface CatalogInitialVideoPlan {
  preferences: CatalogCreationVideoPreferences;
  acceptedAt: number;
  setId: string | null;
  recipeRowIds: string[];
  childRequestIds: string[];
  assignmentSeed: string;
  recipeRevision?: 1;
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
    ...(scheduled ? { publicationHeld: false } : {})
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
      ...(result.executor ? { executor: result.executor } : {})
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
