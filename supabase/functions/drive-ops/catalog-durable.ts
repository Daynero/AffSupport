import {
  CatalogVideoPreparationPending,
  parseCatalogVideoGenerationProgress,
  type CatalogVideoGenerationProgress,
  catalogPlanSegments,
  createCatalogInitialVideoPlan,
  createCatalogInitialVideoPlanV2,
  prepareCatalogInitialVideo,
  type CatalogInitialVideoPlan,
  type CatalogVideoPreparingResult
} from './catalog-video-generation.ts';
import { catalogTimings, timeCatalogMethods } from '../_shared/catalog-timings.ts';
import { parseCatalogDrawnImage, type CatalogDrawnImage } from '../_shared/catalog-image-rows.ts';
import { launchFailure } from '../_shared/launch-failures.ts';
import {
  CatalogStepYield,
  CREATIVE_IMAGE_INVOCATION_BYTES,
  publishCreativeImagesBounded,
  workerShutdownAnnounced
} from './creative-image-pool.ts';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode
} from '../../../packages/shared/dist/team/transport.js';
import {
  launchCreativeAnalytics,
  parseCatalogCreativeDiagnostics,
  safeLaunchAnalyticsCode,
  type CatalogCreativeDiagnostics,
  type CreativeImageStage
} from '../../../packages/shared/dist/team/launches.js';
import { parseCatalogRowRecipe } from '../_shared/product-catalog.ts';
import { buildXlsx, type XlsxCell } from '../_shared/xlsx.ts';
import { PRODUCT_CATALOG_SHEET_NAME } from '../_shared/product-catalog.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { GoogleDriveClient, DriveFileMetadata } from '../_shared/drive.ts';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type CreateProductCatalogRequest,
  type ProductCatalogDeps,
  type CatalogDrive,
  type CatalogCreativeImageLink,
  type CreateProductCatalogResult
} from './product-catalog.ts';

/** 062: the per-image checkpoint of an image catalog (`creativeImage_<ordinal>`). */
function parseCreativeImageCheckpoint(
  value: unknown,
  ordinal: number
): CatalogCreativeImageLink | null {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    !/^https:\/\/\S+$/u.test(value.url) ||
    (value.linkKind !== 'r2' && value.linkKind !== 'drive') ||
    (value.id !== null && value.id !== undefined && typeof value.id !== 'string')
  )
    return null;
  return {
    ordinal,
    link: value.url,
    linkKind: value.linkKind,
    ...(typeof value.id === 'string' ? { imageId: value.id } : {})
  };
}

/** 062: the plan's creative blocks must be the request's, creative for creative. */
function assertPlanMatchesCreatives(
  plan: CatalogInitialVideoPlan,
  request: CreateProductCatalogRequest
): void {
  const segments = catalogPlanSegments(plan);
  if (!request.creatives) {
    if (segments && segments.length !== 1) throw new TeamFunctionError('INVALID_RESPONSE');
    return;
  }
  if (
    !segments ||
    segments.length !== request.creatives.length ||
    segments.some(
      (segment, index) =>
        segment.materialId.toLowerCase() !== request.creatives![index]!.materialId.toLowerCase() ||
        segment.rowCount !== request.creatives![index]!.copies ||
        segment.kind !== (request.creativeKind ?? 'video')
    )
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
}

export type DurableCatalogDrive = Pick<
  GoogleDriveClient,
  | 'listAnyonePermissions'
  | 'createAnyoneReaderPermission'
  | 'createConvertedFile'
  | 'updateFileMetadata'
  | 'getFile'
  | 'findCatalogIntentFiles'
> &
  Partial<
    Pick<
      GoogleDriveClient,
      'createNativeSpreadsheet' | 'getNativeSpreadsheetSheets' | 'writeNativeSpreadsheetRows'
    >
  >;
export interface CatalogIntent {
  id: string;
  variant: number;
  state: string;
  fence: string;
  attempt: number;
  checkpoint: Record<string, unknown>;
  result: unknown;
  operationId: string | null;
}
export interface CatalogIntentStore {
  /** A Launch's store: its step may stop between images and continue in a fresh invocation. */
  yieldable?: boolean;
  imageRequestVersion?: () => Promise<1 | 2 | 3 | null>;
  resources?: (intent: CatalogIntent, owner: string) => Promise<Record<string, unknown>>;
  completed?: (intent: CatalogIntent) => Promise<CreateProductCatalogResult | null>;
  operation?: (
    intent: CatalogIntent
  ) => Promise<{ state: string; materialId: string | null } | null>;
  retryChild?: (intent: CatalogIntent, owner: string) => Promise<number>;

  begin(payload: Record<string, unknown>, owner: string): Promise<CatalogIntent>;
  checkpoint(
    intent: CatalogIntent,
    owner: string,
    state: string,
    patch: Record<string, unknown>,
    operationId?: string,
    result?: CreateProductCatalogResult
  ): Promise<void>;
  permission(
    intent: CatalogIntent,
    owner: string,
    fileId: string,
    credentialId: string,
    permissionId: string | null,
    state: 'pending' | 'created' | 'preserved'
  ): Promise<void>;
}
/** The four answers the intent's own steps give about its lease and state; they were always
 * passed on as they are, and as retryable. */
const INTENT_STEP_ANSWERS = new Set([
  'REQUEST_REUSE_CONFLICT',
  'LEASE_MISMATCH',
  'PERMISSION_DENIED',
  'WRONG_STATE'
]);
/**
 * What an intent's database step refused with, for the caller.
 *
 * GROUP_RECONCILING means "another executor holds this creation": the database says it in those
 * words, the dialog answers it by showing the progress so far and reading again, and a Launch
 * leaves the generation to that other executor. Every other answer used to be folded into it
 * too — so a creation whose picture pool could not be confirmed (GLOBAL_IMAGE_READINESS_UNKNOWN,
 * beta 2026-11-26) stood at «Готово відео: 1 з 1» for good, with «Продовжити» doing nothing and
 * no word of why. A code the database raised is now the code the caller gets: the dialog names
 * it, a Launch stops on it, and the recovery pass records it. Only an answer that is not a code
 * at all (a statement timeout, a dropped connection) is still read as "busy, try again", and
 * the log says which step gave it.
 */
export function catalogIntentRpcFailure(
  name: string,
  error: { message?: unknown; code?: unknown }
): TeamFunctionError {
  const message = typeof error.message === 'string' ? error.message : '';
  if (INTENT_STEP_ANSWERS.has(message) || message === 'GROUP_RECONCILING')
    return new TeamFunctionError(message as TeamErrorCode, { retryable: true });
  const known = TEAM_ERROR_CODES.find(code => code === message);
  if (known) return new TeamFunctionError(known);
  console.warn(
    '[catalog] intent step answered outside its codes',
    JSON.stringify({
      rpc: /^[a-z][a-z0-9_]{0,63}$/u.test(name) ? name : null,
      sqlstate:
        typeof error.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : null
    })
  );
  return new TeamFunctionError('GROUP_RECONCILING', { retryable: true });
}
export function catalogIntentStore(
  service: ServiceRpcClient,
  teamId: string,
  videoId: string,
  actorId: string,
  key: string,
  launch?: { generationId: string; owner: string; fence: string; stage: () => string }
): CatalogIntentStore {
  const call = async (name: string, parameters: Record<string, unknown>) => {
    const { data, error } = await service.rpc(name, parameters);
    if (error) throw catalogIntentRpcFailure(name, error);
    return data;
  };
  const common = (intent: CatalogIntent, owner: string) => ({
    p_team: teamId,
    p_intent: intent.id,
    p_actor: actorId,
    p_owner: owner,
    p_fence: intent.fence
  });
  return {
    ...(launch ? { yieldable: true } : {}),
    async resources(intent, owner) {
      const value = await call('service_plan_catalog_resources', common(intent, owner));
      if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      intent.checkpoint = { ...intent.checkpoint, ...value };
      return value;
    },
    async completed(intent) {
      const value = await call('service_reconcile_catalog_result', {
        p_team: teamId,
        p_intent: intent.id,
        p_actor: actorId
      });
      if (value === null) return null;
      const result = existingResult(value);
      if (!result) throw new TeamFunctionError('INVALID_RESPONSE');
      return result;
    },
    async operation(intent) {
      if (!intent.operationId) return null;
      const value = await call('service_get_team_operation', {
        p_operation: intent.operationId,
        p_actor: actorId
      });
      const row = Array.isArray(value) ? value[0] : value;
      if (
        !isRecord(row) ||
        row.team_id !== teamId ||
        row.source_material_id !== videoId ||
        typeof row.state !== 'string' ||
        (row.result_material_id !== null && typeof row.result_material_id !== 'string')
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return { state: row.state, materialId: row.result_material_id };
    },
    async retryChild(intent, owner) {
      const n = await call('service_retry_catalog_child', common(intent, owner));
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 2)
        throw new TeamFunctionError('INVALID_RESPONSE');
      intent.attempt = n;
      intent.operationId = null;
      return n;
    },
    async imageRequestVersion() {
      const version = await call('service_catalog_image_request_version_v2', {
        p_team: teamId,
        p_video: videoId,
        p_actor: actorId,
        p_key: key
      });
      if (version === null || version === 1 || version === 2 || version === 3) return version;
      throw new TeamFunctionError('INVALID_RESPONSE');
    },
    async begin(payload, owner) {
      const r = await call('service_begin_catalog_intent', {
        p_team: teamId,
        p_video: videoId,
        p_actor: actorId,
        p_key: key,
        p_payload: payload,
        p_owner: owner
      });
      if (
        !isRecord(r) ||
        typeof r.id !== 'string' ||
        typeof r.variant !== 'number' ||
        typeof r.state !== 'string' ||
        typeof r.fence !== 'string' ||
        typeof r.attempt !== 'number' ||
        !isRecord(r.checkpoint) ||
        (r.operationId !== null && typeof r.operationId !== 'string')
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return {
        id: r.id,
        variant: r.variant,
        state: r.state,
        fence: r.fence,
        attempt: r.attempt,
        checkpoint: r.checkpoint,
        result: r.result,
        operationId: r.operationId
      };
    },
    async checkpoint(intent, owner, state, patch, operationId, result) {
      await call(
        launch
          ? 'service_checkpoint_launch_catalog_intent_v1'
          : 'service_checkpoint_catalog_intent',
        {
          ...common(intent, owner),
          p_state: state,
          p_checkpoint: patch,
          p_operation: operationId ?? null,
          p_result: result ?? null,
          ...(launch
            ? {
                p_generation: launch.generationId,
                p_launch_owner: launch.owner,
                p_launch_fence: launch.fence,
                p_stage: launch.stage()
              }
            : {})
        }
      );
      intent.state = state;
      intent.checkpoint = { ...intent.checkpoint, ...patch };
      if (operationId) intent.operationId = operationId;
    },
    async permission(intent, owner, fileId, credentialId, permissionId, state) {
      await call('service_record_catalog_permission', {
        ...common(intent, owner),
        p_file: fileId,
        p_credential: credentialId,
        p_permission: permissionId,
        p_prior_anyone: state === 'preserved',
        p_state: state
      });
    }
  };
}
function existingResult(value: unknown): CreateProductCatalogResult | null {
  if (
    !isRecord(value) ||
    (value.outcome !== 'created' &&
      value.outcome !== 'recreated' &&
      value.outcome !== 'existing') ||
    typeof value.videoShared !== 'boolean' ||
    !isRecord(value.catalog)
  )
    return null;
  if (
    value.videoGeneration !== undefined &&
    !parseCatalogVideoGenerationProgress(value.videoGeneration)
  )
    return null;
  const c = value.catalog;
  if (
    typeof c.materialId !== 'string' ||
    typeof c.name !== 'string' ||
    typeof c.sheetUrl !== 'string' ||
    typeof c.sourceLink !== 'string' ||
    typeof c.productCount !== 'number' ||
    (c.createdAt !== null && typeof c.createdAt !== 'string') ||
    (c.variant !== undefined && typeof c.variant !== 'number')
  )
    return null;
  return {
    outcome: value.outcome,
    videoShared: value.videoShared,
    ...(value.videoGeneration === undefined
      ? {}
      : {
          videoGeneration: parseCatalogVideoGenerationProgress(value.videoGeneration) ?? undefined
        }),
    catalog: {
      materialId: c.materialId,
      name: c.name,
      sheetUrl: c.sheetUrl,
      sourceLink: c.sourceLink,
      productCount: c.productCount,
      createdAt: c.createdAt,
      ...(typeof c.variant === 'number' ? { variant: c.variant } : {})
    }
  };
}
/**
 * A catalog registered while its first publication verification was still open
 * (the create-time check failed after the sheet existed; the recovery pass then
 * registered the catalog) keeps its autoupdate and deferred links blocked until
 * that verification finishes. The recovery listing brings such intents back
 * here; re-running the same verification is idempotent (a verified check
 * answers at once) and a failure only leaves the check open for the next pass.
 */
async function reverifyRegisteredInitialPublication(
  deps: ProductCatalogDeps,
  intent: CatalogIntent,
  request: CreateProductCatalogRequest,
  result: CreateProductCatalogResult
): Promise<void> {
  const plan = intent.checkpoint.initialVideoPlan;
  if (
    request.catalogVideoProtocolVersion !== 1 ||
    !deps.initialVideoAuthority ||
    !isRecord(plan) ||
    !Array.isArray(plan.recipeRowIds) ||
    plan.recipeRowIds.length !== request.productCount
  )
    return;
  const authority = deps.initialVideoAuthority;
  try {
    // Pacing is claimed in its own transaction before any work: a failure
    // anywhere below can no longer roll it back and relist the intent every pass.
    if (authority.claimReverify && (await authority.claimReverify(intent.id)) !== 'go') return;
    await authority.registerCreated({
      intentId: intent.id,
      plan: plan as unknown as CatalogInitialVideoPlan,
      catalogMaterialId: result.catalog.materialId
    });
  } catch (error) {
    const code = launchFailure(error).code;
    console.error('[catalog] initial publication verification still pending', intent.id, code);
    await authority.noteReverify?.(intent.id, code).catch(() => undefined);
  }
}

/** 062: the R2 image records an image catalog's checkpoints name, confirmed as its uses. */
async function confirmCreativeImageUses(
  deps: ProductCatalogDeps,
  intent: CatalogIntent,
  catalogMaterialId: string
): Promise<void> {
  if (!deps.confirmCreativeImageUses) return;
  const ids: string[] = [];
  for (const [key, value] of Object.entries(intent.checkpoint)) {
    const ordinal = /^creativeImage_(\d{1,3})$/u.exec(key)?.[1];
    if (ordinal === undefined) continue;
    const parsed = parseCreativeImageCheckpoint(value, Number(ordinal));
    if (!parsed) throw new TeamFunctionError('INVALID_RESPONSE');
    if (parsed.imageId) ids.push(parsed.imageId);
  }
  if (ids.length > 0) await deps.confirmCreativeImageUses(catalogMaterialId, ids);
}

/** Decorates the existing generator; no second rows/template/XLSX implementation. */
export async function createDurableProductCatalog(
  deps: ProductCatalogDeps,
  store: CatalogIntentStore,
  fullDriveFor: (credentialId: string) => Promise<DurableCatalogDrive>,
  body: unknown,
  actor: string
): Promise<CreateProductCatalogResult | CatalogVideoPreparingResult> {
  const requested = parseCreateProductCatalogRequest(body);
  const acceptedVersion = await store.imageRequestVersion?.();
  // Only a server-owned accepted payload authorizes legacy retry normalization.
  const request = { ...requested };
  if (acceptedVersion === 1) delete request.catalogImageContractVersion;
  if (acceptedVersion === 2 && ![2, 3].includes(request.catalogImageContractVersion ?? 0))
    throw new TeamFunctionError('CATALOG_IMAGE_UPGRADE_REQUIRED');
  if (acceptedVersion === 2) request.catalogImageContractVersion = 2;
  // Same reason as assertCatalogImageContract: only a code an older client knows.
  if (acceptedVersion === 3 && request.catalogImageContractVersion !== 3)
    throw new TeamFunctionError('CATALOG_IMAGE_UPGRADE_REQUIRED');
  // Accepted old receipts can be read after T0; SQL refuses unfinished legacy work.
  if (acceptedVersion !== 1 && acceptedVersion !== 2)
    await deps.assertImageContract?.(request.teamId, request.catalogImageContractVersion);
  const owner = crypto.randomUUID();
  const intent = await store.begin({ ...request }, owner);
  const contentPolicy = intent.checkpoint.contentPolicyVersion;
  if (contentPolicy !== undefined && contentPolicy !== 1)
    throw new TeamFunctionError('INVALID_RESPONSE');
  // A resumed intent arrives 'interrupted', and checkpointing that state again
  // releases the lease, so the next checkpoint of the same pass failed
  // LEASE_MISMATCH. A restitch creation resumed after its videos were ready
  // lost two passes that way (settings, then the source proof) and the catalog
  // appeared a minute or more late. Work in progress is recorded as 'planning'.
  const workingState = () => (intent.state === 'interrupted' ? 'planning' : intent.state);
  // 062: typed diagnostics of a creatives request — counts, kinds, ordinals and the image
  // publication attempt, never a name, alias, material ID or link. Written whole each time
  // (the checkpoint merges top-level keys) and only for a request that names its creatives.
  let creativeDiagnostics: CatalogCreativeDiagnostics | null = null;
  if (request.creatives) {
    const known = parseCatalogCreativeDiagnostics(intent.checkpoint.creativeDiagnostics);
    const props = launchCreativeAnalytics({
      method: 'catalog',
      creativeKind: request.creativeKind ?? 'video',
      creatives: request.creatives,
      catalog: {
        productCount: request.productCount,
        restitchEnabled: request.restitchEnabled === true,
        videoVariationCount: request.videoVariationCount
      }
    })!;
    creativeDiagnostics = known ?? {
      creativeKind: props.creative_kind,
      creativeCount: props.creative_count,
      productCount: props.product_count,
      variationCount: props.variation_count,
      customDistribution: props.custom_distribution,
      images: []
    };
  }
  const recordCreativeDiagnostics = async (
    change: (current: CatalogCreativeDiagnostics) => CatalogCreativeDiagnostics,
    state = workingState()
  ) => {
    if (!creativeDiagnostics) return;
    creativeDiagnostics = change(creativeDiagnostics);
    await store.checkpoint(intent, owner, state, { creativeDiagnostics }).catch(() => undefined);
  };
  const imageStageChange =
    (ordinal: number, stage: CreativeImageStage, attemptId: string | null, code?: string) =>
    (current: CatalogCreativeDiagnostics): CatalogCreativeDiagnostics => ({
      ...current,
      images: [
        ...current.images.filter(image => image.creativeOrdinal !== ordinal),
        {
          creativeOrdinal: ordinal,
          stage,
          attemptId,
          ...(code !== undefined ? { code: safeLaunchAnalyticsCode(code) } : {})
        }
      ].sort((a, b) => a.creativeOrdinal - b.creativeOrdinal)
    });
  /** A stage seen in flight is only remembered; it reaches the intent with the image's own
   * checkpoint (or its failure), not as a write of its own. */
  const noteImageStage = (ordinal: number, stage: CreativeImageStage, attemptId: string | null) => {
    if (creativeDiagnostics)
      creativeDiagnostics = imageStageChange(ordinal, stage, attemptId)(creativeDiagnostics);
  };
  const imageStage = (
    ordinal: number,
    stage: CreativeImageStage,
    attemptId: string | null,
    code?: string
  ) => recordCreativeDiagnostics(imageStageChange(ordinal, stage, attemptId, code));
  if (intent.state === 'registered') {
    await deps.finalizeImageUses?.(request.teamId, intent.id, true);
    const result = existingResult(intent.result);
    if (!result) throw new TeamFunctionError('INVALID_RESPONSE');
    await reverifyRegisteredInitialPublication(deps, intent, request, result);
    return result;
  }
  let initialVideoPlan: CatalogInitialVideoPlan | undefined;
  let initialVideoProgress: CatalogVideoGenerationProgress | undefined;
  if (request.catalogVideoProtocolVersion === 1) {
    if (!deps.initialVideoAuthority) throw new TeamFunctionError('WRONG_STATE');
    if (intent.checkpoint.initialVideoPlan !== undefined) {
      // Exact accepted body is protected by the canonical intent payload equality.
      initialVideoPlan = intent.checkpoint.initialVideoPlan as CatalogInitialVideoPlan;
      if (
        !initialVideoPlan ||
        !Array.isArray(initialVideoPlan.recipeRowIds) ||
        initialVideoPlan.recipeRowIds.length !== request.productCount
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      assertPlanMatchesCreatives(initialVideoPlan, request);
    } else {
      const preferences = request as import('./product-catalog.ts').CatalogCreationVideoPreferences;
      const serverNow = await deps.initialVideoAuthority.serverNow();
      initialVideoPlan = request.creatives
        ? await createCatalogInitialVideoPlanV2(
            preferences,
            request.creativeKind ?? 'video',
            request.creatives,
            request.productCount,
            serverNow
          )
        : createCatalogInitialVideoPlan(preferences, request.productCount, serverNow);
      await store.checkpoint(intent, owner, workingState(), {
        initialVideoPlan,
        ...(creativeDiagnostics ? { creativeDiagnostics } : {})
      });
      intent.checkpoint = { ...intent.checkpoint, initialVideoPlan };
    }
    try {
      deps = {
        ...deps,
        videoDelivery: await prepareCatalogInitialVideo(
          deps.initialVideoAuthority,
          intent.id,
          initialVideoPlan,
          progress => {
            initialVideoProgress = progress;
          }
        )
      };
    } catch (error) {
      if (error instanceof CatalogVideoPreparationPending) {
        const failedOrdinal = error.result.failedOrdinal;
        if (failedOrdinal !== undefined && creativeDiagnostics)
          creativeDiagnostics = { ...creativeDiagnostics, failedOrdinal };
        if (intent.state !== 'canceled')
          await store.checkpoint(intent, owner, 'interrupted', {
            videoPreparationPending: true,
            safeErrorCode: null,
            ...(creativeDiagnostics ? { creativeDiagnostics } : {})
          });
        return error.result;
      }
      const failure = launchFailure(error);
      await store
        .checkpoint(intent, owner, 'interrupted', {
          videoPreparationPending: false,
          safeErrorCode: TEAM_ERROR_CODES.includes(failure.code) ? failure.code : 'UNKNOWN'
        })
        .catch(() => undefined);
      throw failure;
    }
  }
  const timings = catalogTimings(intent.attempt);
  const checkpoint = store.checkpoint.bind(store);
  store = {
    ...store,
    checkpoint: (current, leaseOwner, state, patch, operationId, result) =>
      timings.measure('checkpoint', () =>
        checkpoint(
          current,
          leaseOwner,
          state,
          Object.keys(patch).length || state === 'registered' || state === 'interrupted'
            ? { ...patch, performance: timings.snapshot(intent.attempt) }
            : patch,
          operationId,
          result
        )
      )
  };
  deps = timeCatalogMethods(deps, timings, {
    assertImageContract: 'image_contract',
    loadVideo: 'video_context',
    readSettings: 'settings',
    readLiveCatalogs: 'catalog_lookup',
    proveVideo: 'video_proof',
    destination: 'destination',
    drawTexts: 'resource_selection',
    drawImages: 'resource_selection',
    planName: 'name_conflicts',
    resolveSourceLink: 'source_link',
    resolveCreativeSourceLinks: 'source_link',
    startOperation: 'operation_start',
    markRunning: 'operation_running',
    beforeImageWrite: 'image_validation',
    bindIntent: 'intent_binding',
    finalize: 'catalog_finalize',
    link: 'catalog_link',
    finalizeImageUses: 'image_finalize'
  });
  const originalDriveFor = fullDriveFor;
  fullDriveFor = credentialId =>
    timings.measure('drive_client', async () =>
      timeCatalogMethods(await originalDriveFor(credentialId), timings, {
        createConvertedFile: 'sheet_upload',
        createNativeSpreadsheet: 'sheet_upload',
        listAnyonePermissions: 'permission_read',
        createAnyoneReaderPermission: 'permission_write'
      })
    );
  try {
    const recovered = await store.completed?.(intent);
    if (recovered) {
      await deps.finalizeImageUses?.(request.teamId, intent.id, true);
      await confirmCreativeImageUses(deps, intent, recovered.catalog.materialId);
      await store.checkpoint(intent, owner, 'registered', {}, undefined, recovered);
      // The catalog already exists, but its initial publication may never have
      // begun (the first verification failed before the policy was created).
      await reverifyRegisteredInitialPublication(deps, intent, request, recovered);
      return recovered;
    }
    let child = (await store.operation?.(intent)) ?? null;
    if (child?.state === 'canceled') throw new TeamFunctionError('WRONG_STATE');
    if (child?.state === 'failed') {
      if (!store.retryChild) throw new TeamFunctionError('WRONG_STATE');
      await store.retryChild(intent, owner);
      child = null;
    }
    let resources: Promise<Record<string, unknown>> | undefined;
    const ensureResources = async () => {
      if (store.resources) {
        resources ??= timings.measure('resource_selection', () => store.resources!(intent, owner));
        await resources;
      }
    };
    const check = () => store.checkpoint(intent, owner, workingState(), {});
    const recoverFile = async (
      parentId: string,
      credentialId: string
    ): Promise<DriveFileMetadata | null> => {
      if (
        typeof intent.checkpoint.providerFileId !== 'string' &&
        intent.checkpoint.createStarted !== true
      )
        return null;
      await check();
      if (
        intent.checkpoint.parentId !== parentId ||
        intent.checkpoint.credentialId !== credentialId
      )
        throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
      const drive = await fullDriveFor(credentialId);
      const persisted = typeof intent.checkpoint.providerFileId === 'string';
      const matches = persisted
        ? [await drive.getFile(String(intent.checkpoint.providerFileId))]
        : await drive.findCatalogIntentFiles({ marker: intent.id, parentId });
      if (matches.length !== 1)
        throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN', { retryable: true });
      const file = matches[0];
      if (
        file.trashed ||
        file.mimeType !== 'application/vnd.google-apps.spreadsheet' ||
        !file.parents.includes(parentId) ||
        file.appProperties[
          intent.checkpoint.sheetEngine === 'native'
            ? 'soty.catalog.nativeIntent'
            : 'soty.catalog.intent'
        ] !== intent.id
      )
        throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
      if (!persisted) {
        const parent = await drive.getFile(parentId);
        if (
          file.driveId
            ? parent.driveId !== file.driveId || !file.capabilities.canModifyContent
            : file.ownedByMe !== true
        )
          throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
      }
      await store.checkpoint(intent, owner, 'created', { providerFileId: file.id });
      return file;
    };
    const engine = intent.checkpoint.sheetEngine;
    if (engine !== undefined && engine !== 'native' && engine !== 'xlsx')
      throw new TeamFunctionError('INVALID_RESPONSE');
    const nativeSpreadsheet =
      engine === 'native' ||
      (engine === undefined &&
        deps.nativeSpreadsheet === true &&
        intent.state === 'reserved' &&
        !intent.operationId &&
        intent.checkpoint.createStarted !== true &&
        typeof intent.checkpoint.providerFileId !== 'string');
    if (nativeSpreadsheet && engine === undefined) {
      await store.checkpoint(intent, owner, workingState(), { sheetEngine: 'native' });
      intent.checkpoint.sheetEngine = 'native';
    }
    const publishCreativeImages = deps.publishCreativeImages;
    const wrapped: ProductCatalogDeps = {
      ...deps,
      nativeSpreadsheet,
      // 062: one checkpoint per published image, so a resumed creation never publishes twice.
      // A few images at a time (each is mostly Drive and R2 round trips), within one
      // invocation's CPU: past its budget the step yields and the generation continues at once
      // in a fresh invocation from the images already checkpointed.
      ...(publishCreativeImages
        ? {
            async publishCreativeImages(input) {
              const links: (CatalogCreativeImageLink | undefined)[] = [];
              const pending: (typeof input.images)[number][] = [];
              for (const [index, image] of input.images.entries()) {
                const known = intent.checkpoint[`creativeImage_${image.ordinal}`];
                if (known === undefined) {
                  pending.push(image);
                  continue;
                }
                const parsed = parseCreativeImageCheckpoint(known, image.ordinal);
                if (!parsed) throw new TeamFunctionError('INVALID_RESPONSE');
                links[index] = parsed;
              }
              if (pending.length > 0) {
                // The lease is proven once before the first provider side effect; every image's
                // own checkpoint proves it again before the next one is admitted.
                await check();
                // Checkpoints leave one at a time, so the diagnostics written whole never go back.
                let writes: Promise<void> = Promise.resolve();
                const serial = (write: () => Promise<void>) => {
                  const next = writes.then(write);
                  writes = next.catch(() => undefined);
                  return next;
                };
                const indexOf = new Map(input.images.map((image, index) => [image.ordinal, index]));
                await publishCreativeImagesBounded(pending, {
                  // Only an R2 copy reads and rewrites bytes; a Drive link costs no CPU.
                  budget:
                    store.yieldable && input.copyToR2
                      ? {
                          bytes: CREATIVE_IMAGE_INVOCATION_BYTES,
                          stopping: workerShutdownAnnounced
                        }
                      : null,
                  publish: async image => {
                    let attemptId: string | null = null;
                    let published: CatalogCreativeImageLink | undefined;
                    try {
                      [published] = await publishCreativeImages({
                        ...input,
                        images: [image],
                        observe: async event => {
                          attemptId = event.attemptId;
                          noteImageStage(event.ordinal, event.stage, event.attemptId);
                        }
                      });
                    } catch (error) {
                      await serial(async () => {
                        await imageStage(
                          image.ordinal,
                          'creative_image.failed',
                          attemptId,
                          launchFailure(error).code
                        );
                        // Diagnosis names which image stopped the catalog (a number, never a name).
                        await store
                          .checkpoint(intent, owner, workingState(), {
                            creativeOrdinal: image.ordinal
                          })
                          .catch(() => undefined);
                      });
                      throw error;
                    }
                    if (!published || published.ordinal !== image.ordinal)
                      throw new TeamFunctionError('INVALID_RESPONSE');
                    const link = published;
                    await serial(() =>
                      store.checkpoint(intent, owner, workingState(), {
                        [`creativeImage_${image.ordinal}`]: {
                          id: link.imageId ?? null,
                          url: link.link,
                          linkKind: link.linkKind
                        },
                        ...(creativeDiagnostics ? { creativeDiagnostics } : {})
                      })
                    );
                    links[indexOf.get(image.ordinal)!] = link;
                  }
                });
              }
              if (links.length !== input.images.length || links.some(link => !link))
                throw new TeamFunctionError('INVALID_RESPONSE');
              return links as CatalogCreativeImageLink[];
            }
          }
        : {}),
      async beforeImageWrite() {
        await deps.validateImageUses?.(request.teamId, intent.id);
        await deps.beforeImageWrite?.();
      },
      preserveUncertainOutput: true,
      async assertImageContract(team, version) {
        if (acceptedVersion === 1) return;
        await deps.assertImageContract?.(team, version);
      },
      failOperation: (id, cause) => deps.failOperation(id, launchFailure(cause)),
      readCreatedFile: recoverFile,
      async readSettings(team) {
        if (request.idempotencyKey.startsWith('launch:')) await ensureResources();
        const known = intent.checkpoint.settings;
        if (known !== undefined) {
          if (
            !isRecord(known) ||
            (known.title !== null && typeof known.title !== 'string') ||
            (known.description !== null && typeof known.description !== 'string') ||
            (known.imageLink !== null && typeof known.imageLink !== 'string') ||
            typeof known.priceMin !== 'number' ||
            typeof known.priceMax !== 'number'
          )
            throw new TeamFunctionError('INVALID_RESPONSE');
          return {
            title: known.title,
            description: known.description,
            imageLink: known.imageLink,
            priceMin: known.priceMin,
            priceMax: known.priceMax,
            ...(contentPolicy === 1 ? { contentPolicyVersion: 1 as const } : {})
          };
        }
        const previous = await deps.readSettings(team);
        const settings =
          contentPolicy === 1
            ? {
                title: null,
                description: null,
                imageLink: previous?.imageLink ?? null,
                priceMin: 20,
                priceMax: 40,
                contentPolicyVersion: 1 as const
              }
            : previous;
        if (settings) await store.checkpoint(intent, owner, workingState(), { settings });
        return settings;
      },
      readRowRecipe() {
        if (intent.checkpoint.rowRecipe === undefined) return null;
        const known = parseCatalogRowRecipe(intent.checkpoint.rowRecipe);
        if (!known) throw new TeamFunctionError('INVALID_RESPONSE');
        return known;
      },
      async rememberRowRecipe(rows) {
        if (intent.checkpoint.rowRecipe !== undefined) {
          const known = parseCatalogRowRecipe(intent.checkpoint.rowRecipe);
          if (!known) throw new TeamFunctionError('INVALID_RESPONSE');
          return known;
        }
        await store.checkpoint(intent, owner, 'planned', {
          rowRecipe: rows,
          ...(contentPolicy === 1
            ? {
                content_policy_version: 1,
                planned_row_count: rows.length,
                automatic_row_count: rows.length,
                retained_row_count: 0
              }
            : {})
        });
        return rows;
      },
      async rememberSheetRows(rows) {
        if (intent.checkpoint.sheetRows !== undefined) {
          if (!Array.isArray(intent.checkpoint.sheetRows))
            throw new TeamFunctionError('INVALID_RESPONSE');
          const known: XlsxCell[][] = [];
          for (const row of intent.checkpoint.sheetRows) {
            if (!Array.isArray(row)) throw new TeamFunctionError('INVALID_RESPONSE');
            const cells: XlsxCell[] = [];
            for (const c of row) {
              if (!isRecord(c)) throw new TeamFunctionError('INVALID_RESPONSE');
              if (c.t === 'number' && typeof c.v === 'number') cells.push({ t: 'number', v: c.v });
              else if ((c.t === 'string' || c.t === 'decimal') && typeof c.v === 'string')
                cells.push({ t: c.t, v: c.v });
              else throw new TeamFunctionError('INVALID_RESPONSE');
            }
            known.push(cells);
          }
          return known;
        }
        await store.checkpoint(intent, owner, 'planned', { sheetRows: rows });
        return rows;
      },
      async proveVideo(video, drive) {
        const live = await deps.proveVideo(video, drive);
        const key = `source_${video.id}`;
        const identity = {
          id: live.id,
          version: live.version,
          checksum: live.checksum,
          modifiedAt: live.modifiedAt,
          resourceKey: live.resourceKey
        };
        const known = intent.checkpoint[key];
        if (
          known !== undefined &&
          (!isRecord(known) ||
            known.id !== identity.id ||
            // Drive permission changes may advance version without changing binary content.
            // A proven MD5 is stronger than version; unknown checksums retain strict checks.
            (typeof known.checksum === 'string' &&
            /^[a-f0-9]{32}$/iu.test(known.checksum) &&
            typeof identity.checksum === 'string' &&
            /^[a-f0-9]{32}$/iu.test(identity.checksum)
              ? known.checksum.toLowerCase() !== identity.checksum.toLowerCase()
              : known.version !== identity.version ||
                known.checksum !== identity.checksum ||
                known.modifiedAt !== identity.modifiedAt) ||
            known.resourceKey !== identity.resourceKey ||
            (identity.version === null && identity.checksum === null))
        )
          throw new TeamFunctionError('SOURCE_CHANGED');
        if (known === undefined)
          await store.checkpoint(intent, owner, workingState(), { [key]: identity });
        return live;
      },
      async nextVariant() {
        return intent.variant;
      },
      async drawTexts(team, count) {
        await ensureResources();
        if (Array.isArray(intent.checkpoint.texts)) {
          const values = [];
          for (const row of intent.checkpoint.texts) {
            if (
              !isRecord(row) ||
              typeof row.title !== 'string' ||
              typeof row.description !== 'string'
            )
              throw new TeamFunctionError('INVALID_RESPONSE');
            values.push({ title: row.title, description: row.description });
          }
          return values;
        }
        await check();
        const texts = await deps.drawTexts(team, count);
        await store.checkpoint(intent, owner, 'planning', { texts });
        return texts;
      },
      async drawImages(team, count, options) {
        await ensureResources();
        if (Array.isArray(intent.checkpoint.images)) {
          const values: CatalogDrawnImage[] = [];
          for (const row of intent.checkpoint.images) {
            const parsed = parseCatalogDrawnImage(row);
            if (!parsed) throw new TeamFunctionError('INVALID_RESPONSE');
            values.push(parsed);
          }
          return values;
        }
        await check();
        const images = await deps.drawImages(team, count, {
          ...options,
          attemptId: intent.id,
          catalogId: intent.id
        });
        await store.checkpoint(intent, owner, 'planning', { images });
        return images;
      },
      async planName(input) {
        if (
          isRecord(intent.checkpoint.namePlan) &&
          typeof intent.checkpoint.namePlan.name === 'string' &&
          typeof intent.checkpoint.namePlan.reservationKey === 'string'
        )
          return {
            name: intent.checkpoint.namePlan.name,
            reservationKey: intent.checkpoint.namePlan.reservationKey
          };
        await check();
        const plan = await deps.planName(input);
        await store.checkpoint(intent, owner, 'planned', { namePlan: plan });
        return plan;
      },
      async startOperation(input) {
        await check();
        const operation = await deps.startOperation({
          ...input,
          idempotencyKey: `catalog:${intent.id}:${intent.attempt}`
        });
        if (operation.state === 'canceled' || operation.state === 'failed')
          throw new TeamFunctionError('WRONG_STATE');
        await store.checkpoint(intent, owner, workingState(), {}, operation.operationId);
        return { ...operation, reused: false };
      },
      async markRunning(id) {
        await check();
        if (child?.state !== 'succeeded') await deps.markRunning(id);
      },
      async driveFor(credentialId) {
        const drive = await fullDriveFor(credentialId);
        const createFile = async (
          input: { parentId: string },
          create: () => Promise<DriveFileMetadata>,
          markerKey = 'soty.catalog.intent'
        ): Promise<DriveFileMetadata> => {
          await check();
          let file: DriveFileMetadata;
          const recovered = await recoverFile(input.parentId, credentialId);
          if (recovered) return recovered;
          await store.checkpoint(intent, owner, 'create_started', {
            createStarted: true,
            parentId: input.parentId,
            credentialId
          });
          try {
            file = await create();
          } catch (error) {
            if (
              error instanceof TeamFunctionError &&
              ['NEEDS_REAUTH', 'PERMISSION_DENIED', 'RATE_LIMITED'].includes(error.code)
            )
              await store.checkpoint(intent, owner, 'planned', {
                createStarted: false,
                createRefusedCode: error.code
              });
            throw error;
          }
          if (
            file.trashed ||
            file.mimeType !== 'application/vnd.google-apps.spreadsheet' ||
            !file.parents.includes(input.parentId) ||
            file.appProperties[markerKey] !== intent.id
          )
            throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
          await store.checkpoint(intent, owner, 'created', { providerFileId: file.id });
          return file;
        };
        const wrappedDrive: CatalogDrive & Pick<GoogleDriveClient, 'getFile'> = {
          getFile: drive.getFile.bind(drive),
          async listAnyonePermissions(fileId) {
            const permissions = await drive.listAnyonePermissions(fileId);
            if (permissions.length)
              await store.permission(
                intent,
                owner,
                fileId,
                credentialId,
                permissions[0].id,
                'preserved'
              );
            return permissions;
          },
          async createAnyoneReaderPermission(fileId) {
            await check();
            await store.permission(intent, owner, fileId, credentialId, null, 'pending');
            const permission = await drive.createAnyoneReaderPermission(fileId);
            await store.permission(intent, owner, fileId, credentialId, permission.id, 'created');
            return permission;
          },
          createConvertedFile(input) {
            return createFile(input, () =>
              drive.createConvertedFile({
                ...input,
                appProperties: { ...input.appProperties, 'soty.catalog.intent': intent.id }
              })
            );
          },
          createNativeSpreadsheet(input) {
            if (!drive.createNativeSpreadsheet) throw new TeamFunctionError('INVALID_RESPONSE');
            return createFile(
              input,
              () =>
                drive.createNativeSpreadsheet!({
                  ...input,
                  appProperties: { ...input.appProperties, 'soty.catalog.nativeIntent': intent.id }
                }),
              'soty.catalog.nativeIntent'
            );
          },
          async writeNativeSpreadsheet(input) {
            await check();
            if (!drive.getNativeSpreadsheetSheets || !drive.writeNativeSpreadsheetRows)
              throw new TeamFunctionError('INVALID_RESPONSE');
            const saved = intent.checkpoint.nativeSheet;
            const written = intent.checkpoint.nativeRowsWritten;
            if (
              written !== undefined &&
              (!isRecord(written) ||
                written.fileId !== input.fileId ||
                !isRecord(saved) ||
                saved.fileId !== input.fileId ||
                written.sheetId !== saved.sheetId)
            )
              throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
            if (written === undefined) {
              const sheets = await drive.getNativeSpreadsheetSheets(input.fileId);
              if (
                saved !== undefined &&
                (!isRecord(saved) ||
                  saved.fileId !== input.fileId ||
                  typeof saved.sheetId !== 'number' ||
                  !Number.isSafeInteger(saved.sheetId))
              )
                throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
              const sheet = isRecord(saved)
                ? sheets.find(s => s.sheetId === saved.sheetId)
                : sheets.length === 1
                  ? sheets[0]
                  : undefined;
              if (!sheet) throw new TeamFunctionError('SOURCE_CHANGED');
              const binding = { fileId: input.fileId, sheetId: sheet.sheetId };
              if (saved === undefined)
                await store.checkpoint(intent, owner, workingState(), { nativeSheet: binding });
              // The frozen range is overwritten, never appended. A lost reply retries the same
              // marked file and bound sheet ID; an acknowledged write is never repeated.
              await check();
              await deps.validateImageUses?.(request.teamId, intent.id);
              await drive.writeNativeSpreadsheetRows({ ...input, sheet });
              await store.checkpoint(intent, owner, workingState(), { nativeRowsWritten: binding });
            }
            const file = await drive.getFile(input.fileId);
            if (
              file.id !== input.fileId ||
              file.trashed ||
              file.mimeType !== 'application/vnd.google-apps.spreadsheet' ||
              typeof intent.checkpoint.parentId !== 'string' ||
              !file.parents.includes(intent.checkpoint.parentId) ||
              file.appProperties['soty.catalog.nativeIntent'] !== intent.id
            )
              throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
            return file;
          },
          async updateFileMetadata(input) {
            await check();
            return drive.updateFileMetadata(input);
          }
        };
        return timeCatalogMethods(wrappedDrive, timings, { writeNativeSpreadsheet: 'sheet_write' });
      },
      async bindIntent(input) {
        await check();
        if (child?.state !== 'succeeded') await deps.bindIntent(input);
      },
      async finalize(input) {
        await check();
        const result =
          child?.state === 'succeeded' && child.materialId
            ? { materialId: child.materialId }
            : await deps.finalize(input);
        await store.checkpoint(intent, owner, 'finalized', { materialId: result.materialId });
        return result;
      },
      async link(input) {
        await check();
        const linked = await deps.link(input);
        if (linked.linked)
          await store.checkpoint(intent, owner, workingState(), { linkCompleted: true });
        return linked;
      }
    };
    const measured = timeCatalogMethods(wrapped, timings, {
      rememberRowRecipe: 'row_recipe',
      rememberSheetRows: 'sheet_rows'
    });
    const baseResult = await createProductCatalog(
      {
        ...measured,
        buildWorkbook: rows =>
          timings.measure('xlsx_build', () =>
            buildXlsx({ sheetName: PRODUCT_CATALOG_SHEET_NAME, rows })
          )
      },
      request,
      actor
    );
    const result = initialVideoProgress
      ? { ...baseResult, videoGeneration: initialVideoProgress }
      : baseResult;
    if (initialVideoPlan && deps.initialVideoAuthority)
      await deps.initialVideoAuthority.registerCreated({
        intentId: intent.id,
        plan: initialVideoPlan,
        catalogMaterialId: result.catalog.materialId
      });
    await deps.bindGlobalImageCatalog?.(request.teamId, intent.id, result.catalog.materialId);
    await deps.finalizeImageUses?.(request.teamId, intent.id, true);
    // 062 (R33): the catalog holds its R2 images from registration on, so a scheduled
    // publication still finds its `c1/` object when it is due.
    await confirmCreativeImageUses(deps, intent, result.catalog.materialId);
    await store.checkpoint(intent, owner, 'registered', {}, undefined, result);
    return result;
  } catch (error) {
    // A yield is not an interruption: the intent keeps its state and its lease is handed on
    // by the Launch (service_yield_launch_generation) to the invocation that continues it.
    if (error instanceof CatalogStepYield) throw error;
    const failure = launchFailure(error);
    await deps
      .finalizeImageUses?.(
        request.teamId,
        intent.id,
        initialVideoPlan !== undefined && typeof intent.checkpoint.materialId === 'string'
      )
      .catch(() => undefined);
    await store
      .checkpoint(intent, owner, 'interrupted', {
        safeErrorCode: TEAM_ERROR_CODES.includes(failure.code) ? failure.code : 'UNKNOWN'
      })
      .catch(() => undefined);
    // The standalone form uses these closed reasons to explain how to repair
    // its input. Keep only the known enum, never arbitrary provider details.
    if (
      error instanceof TeamFunctionError &&
      error.code === 'WRONG_STATE' &&
      (error.details?.reason === 'settings_missing' || error.details?.reason === 'not_a_video')
    ) {
      throw new TeamFunctionError(error.code, {
        status: error.status,
        retryable: error.retryable,
        details: { reason: error.details.reason }
      });
    }
    throw failure;
  }
}

/** The dialog resumes a creation once its videos are ready, and the recovery
 * pass woken by the same event may already hold the lease. Begin then refuses
 * with GROUP_RECONCILING; the resume answers with the current progress instead
 * of a 409, and the dialog keeps polling until the holder registers the catalog. */
export async function resumeOrReadInitialCatalog<T, P>(
  resumed: Promise<T>,
  readProgress: () => Promise<P | null>
): Promise<T | P> {
  try {
    return await resumed;
  } catch (error) {
    if (!(error instanceof TeamFunctionError) || error.code !== 'GROUP_RECONCILING') throw error;
    const progress = await readProgress().catch(() => null);
    if (progress === null) throw error;
    return progress;
  }
}

export { existingResult as parseStoredProductCatalogResult };
