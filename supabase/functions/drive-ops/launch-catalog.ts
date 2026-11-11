import {
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
import {
  parseCatalogVideoGenerationProgress,
  type CatalogInitialVideoAuthority
} from './catalog-video-generation.ts';
import { launchFailure } from '../_shared/launch-failures.ts';
import {
  parseLaunchConfig,
  parseLaunchRevision,
  parseLaunchSources,
  launchPreview,
  launchRevisionImpact,
  type LaunchRevision,
  type LaunchConfig
} from '../../../packages/shared/dist/team/launches.js';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import {
  createDurableProductCatalog,
  catalogIntentStore,
  type CatalogIntentStore,
  type DurableCatalogDrive
} from './catalog-durable.ts';
import type { ProductCatalogDeps } from './product-catalog.ts';
import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
export interface LaunchCatalogExecutionDeps {
  service: ServiceRpcClient;
  createInitialVideoAuthority?: (identity: {
    teamId: string;
    actorId: string;
    sourceMaterialId: string;
    expectedExecutorId?: string;
    readyVideoSetId?: string;
    restitchEnabled: boolean;
    frozenRestitchDefaults?: TeamRestitchDefaults;
  }) => Promise<CatalogInitialVideoAuthority>;
  readCatalogVideoFailure?: (scope: {
    teamId: string;
    actorId: string;
    sourceMaterialId: string;
    setId: string;
  }) => Promise<import('./catalog-video-failure.ts').CatalogVideoFailureCode | null>;
  catalog: ProductCatalogDeps;
  driveFor: (credentialId: string) => Promise<DurableCatalogDrive>;
  /** Must prove current source identity before the first provider side effect. */
  proveSource: (config: LaunchConfig, sources: Record<string, unknown>) => Promise<void>;
  proveCatalog: (catalog: NonNullable<LaunchRevision['catalog']>) => Promise<void>;
}
async function call(
  service: ServiceRpcClient,
  name: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await service.rpc(name, params);
  if (error)
    throw new TeamFunctionError(
      TEAM_ERROR_CODES.find(c => c === error.message) ?? 'INVALID_RESPONSE'
    );
  return data;
}
export async function executeLaunchCatalog(
  deps: LaunchCatalogExecutionDeps,
  teamId: string,
  generationId: string,
  actorId: string
): Promise<unknown> {
  const owner = crypto.randomUUID();
  const claimed = await call(deps.service, 'service_claim_launch_generation', {
    p_team: teamId,
    p_generation: generationId,
    p_actor: actorId,
    p_owner: owner
  });
  if (!isRecord(claimed)) throw new TeamFunctionError('INVALID_RESPONSE');
  if (claimed.state === 'succeeded') return claimed;
  if (
    (claimed.catalogImageContractVersion !== 1 && claimed.catalogImageContractVersion !== 2) ||
    typeof claimed.fence !== 'string' ||
    typeof claimed.advertisingUrl !== 'string' ||
    !isRecord(claimed.sources)
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  const parsed = parseLaunchConfig(claimed.config);
  if (!parsed.ok || parsed.value.method !== 'catalog') throw new TeamFunctionError('INVALID_INPUT');
  const config = parsed.value;
  const protocolVideo = config.catalog.catalogVideoProtocolVersion === 1;
  const frozenVideo = protocolVideo
    ? await call(deps.service, 'service_read_launch_catalog_video_context', {
        p_team: teamId,
        p_generation: generationId,
        p_actor: actorId,
        p_owner: owner,
        p_fence: claimed.fence
      })
    : null;
  if (protocolVideo && (!isRecord(frozenVideo) || !isRecord(frozenVideo.requestPayload)))
    throw new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  const fence = claimed.fence;
  const authority = {
    p_team: teamId,
    p_generation: generationId,
    p_actor: actorId,
    p_owner: owner,
    p_fence: fence
  };
  let currentStage = 'preparing';
  const stage = async (value: string) => {
    await call(deps.service, 'service_touch_launch_generation', { ...authority, p_stage: value });
    currentStage = value;
  };
  /** Requeues every variant whose operation provably failed without output
   * (bounded in SQL). `terminal` counts the ones that may not be retried any
   * more; the set then cannot move and the generation must stop for good. */
  const settleVideoFailures = async (setId: string) => {
    try {
      const settled = await call(deps.service, 'service_retry_failed_catalog_video_variants', {
        p_set: setId,
        p_team: teamId,
        p_actor: actorId
      });
      if (!isRecord(settled) || typeof settled.parentState !== 'string') return null;
      return {
        parentState: settled.parentState,
        terminal: typeof settled.terminal === 'number' ? settled.terminal : 0
      };
    } catch {
      return null;
    }
  };
  /** A set that cannot move is not retried every few minutes: the generation
   * stops as non-retryable and the person restarts it deliberately. */
  const stopForVideoFailure = async (
    cause: import('./catalog-video-failure.ts').CatalogVideoFailureCode,
    final: boolean
  ) => {
    await call(
      deps.service,
      final ? 'service_fail_launch_catalog_video' : 'service_interrupt_launch_generation',
      {
        ...authority,
        // The recovery lane retries PROCESS_RESULT_UNCERTAIN by design.
        p_code: final && cause === 'PROCESS_RESULT_UNCERTAIN' ? 'PROCESS_FAILED' : cause
      }
    );
  };
  const waitForRegisteredVideoDependency = async () => {
    if (
      !protocolVideo ||
      !config.catalog.restitchEnabled ||
      config.catalog.videoPublication?.mode !== 'scheduled'
    )
      return false;
    const original = await call(deps.service, 'service_read_initial_catalog_video', {
      p_team: teamId,
      p_actor: actorId,
      p_key: `launch:${generationId}:catalog`
    });
    if (!isRecord(original) || original.outcome !== 'created') return false;
    const progress = parseCatalogVideoGenerationProgress(
      original.videoGenerationObservation ?? original.videoGeneration
    );
    if (!progress) throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
    if (progress.state === 'ready') return false;
    let stillUnknown = progress.state === 'unknown';
    // A preparing set may hold an abandoned or confirmed-but-unrecorded video;
    // settling is idempotent and bounded in SQL.
    if (progress.state === 'preparing') {
      const settled = await settleVideoFailures(progress.videoSetId);
      if (settled?.parentState === 'ready') return false;
    }
    if (stillUnknown) {
      const settled = await settleVideoFailures(progress.videoSetId);
      if (settled && settled.parentState !== 'unknown') stillUnknown = false;
      else if (deps.readCatalogVideoFailure) {
        const cause = await deps.readCatalogVideoFailure({
          teamId,
          actorId,
          sourceMaterialId: config.materialId,
          setId: progress.videoSetId
        });
        if (cause) {
          await stopForVideoFailure(cause, Boolean(settled && settled.terminal > 0));
          return 'failed' as const;
        }
      }
    }
    await call(deps.service, 'service_wait_launch_catalog_video', authority);
    return stillUnknown ? ('failed' as const) : ('waiting' as const);
  };
  try {
    // A verified blank catalog may precede its N outputs. Retain that exact receipt
    // and release the parent lease instead of attempting the ready-only attach.
    const pendingVideo = await waitForRegisteredVideoDependency();
    if (pendingVideo)
      return { id: generationId, state: pendingVideo === 'failed' ? 'interrupted' : 'accepted' };
    // Reconcile an already registered child before checking mutable source metadata.
    // Its immutable candidate belongs to this exact generation; no provider work is repeated.
    const restored = await call(
      deps.service,
      'service_restore_registered_launch_catalog',
      authority
    );
    if (restored === true) {
      await stage('result_committing');
      return await call(deps.service, 'service_publish_launch_generation', {
        p_team: teamId,
        p_generation: generationId,
        p_actor: actorId,
        p_fence: fence
      });
    }
    await stage('preparing');
    await deps.proveSource(config, claimed.sources);
    const previous = parseLaunchRevision(claimed.previousRevision);
    const sources = parseLaunchSources(claimed.sources);
    const preview = sources ? launchPreview(config, sources) : null;
    if (
      !protocolVideo &&
      previous?.catalog &&
      !Object.values(config.subConfig).some(
        value => Array.isArray(value) && value.includes('catalogName')
      ) &&
      preview?.ok &&
      !launchRevisionImpact(
        previous.baseline,
        preview.value,
        previous.config,
        config,
        previous.sources,
        sources ?? undefined
      ).catalogChanged
    ) {
      await deps.proveCatalog(previous.catalog);
      const reused = await call(deps.service, 'service_reuse_launch_catalog', authority);
      if (reused === true) {
        await stage('result_committing');
        return await call(deps.service, 'service_publish_launch_generation', {
          p_team: teamId,
          p_generation: generationId,
          p_actor: actorId,
          p_fence: fence
        });
      }
    }
    // Consume the already completed local child; this executor never starts video work.
    let restitchOperationId: string | null = null;
    let restitchMaterialId: string | null = null;
    let restitchIdentity: unknown = null;
    if (config.catalog.restitchEnabled && !protocolVideo) {
      const receipt = await call(deps.service, 'service_launch_restitch_receipt', authority);
      if (
        !isRecord(receipt) ||
        typeof receipt.operationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          receipt.operationId
        ) ||
        typeof receipt.materialId !== 'string'
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      restitchOperationId = receipt.operationId;
      restitchMaterialId = receipt.materialId;
      restitchIdentity = receipt.identity;
    }
    const store = catalogIntentStore(
      deps.service,
      teamId,
      config.materialId,
      actorId,
      `launch:${generationId}:catalog`,
      { generationId, owner, fence, stage: () => currentStage }
    );
    const resourcePlanner = store.resources;
    const guarded: CatalogIntentStore = {
      ...store,
      begin: async (payload, childOwner) => {
        await stage('catalog_planning');
        return store.begin(payload, childOwner);
      },
      checkpoint: async (intent, childOwner, state, patch, operationId, result) => {
        currentStage =
          state === 'interrupted' || state === 'cleanup_pending'
            ? currentStage
            : state === 'create_started'
              ? 'catalog_creating'
              : state === 'created'
                ? 'catalog_sharing'
                : state === 'finalized' || state === 'registered'
                  ? 'catalog_registering'
                  : 'catalog_planning';
        await store.checkpoint(intent, childOwner, state, patch, operationId, result);
      },
      resources: resourcePlanner
        ? async (intent, childOwner) => {
            await stage('catalog_planning');
            return resourcePlanner(intent, childOwner);
          }
        : undefined,
      permission: async (intent, childOwner, fileId, credentialId, permissionId, state) => {
        await stage('catalog_sharing');
        await store.permission(intent, childOwner, fileId, credentialId, permissionId, state);
      }
    };
    let initialVideoAuthority: CatalogInitialVideoAuthority | undefined;
    if (protocolVideo) {
      if (!deps.createInitialVideoAuthority || !isRecord(frozenVideo))
        throw new TeamFunctionError('WRONG_STATE');
      const frozenDefaults =
        frozenVideo.settings === null ? null : parseTeamRestitchDefaults(frozenVideo.settings);
      if (frozenDefaults && !frozenDefaults.ok) throw new TeamFunctionError('RESTITCH_INVALID');
      initialVideoAuthority = await deps.createInitialVideoAuthority({
        teamId,
        actorId,
        sourceMaterialId: config.materialId,
        restitchEnabled: config.catalog.restitchEnabled,
        ...(typeof frozenVideo.readyVideoSetId === 'string'
          ? { readyVideoSetId: frozenVideo.readyVideoSetId }
          : {}),
        ...(typeof frozenVideo.executorId === 'string'
          ? { expectedExecutorId: frozenVideo.executorId }
          : {}),
        ...(frozenDefaults?.ok ? { frozenRestitchDefaults: frozenDefaults.value } : {})
      });
    }
    const catalog: ProductCatalogDeps =
      restitchOperationId && restitchMaterialId
        ? {
            ...deps.catalog,
            resolveRestitchedVideo: async input => {
              if (
                input.teamId !== teamId ||
                input.actorId !== actorId ||
                input.videoId !== config.materialId ||
                input.operationId !== restitchOperationId
              )
                throw new TeamFunctionError('INVALID_RESPONSE');
              return deps.catalog.loadVideo({
                teamId,
                videoId: restitchMaterialId!,
                actorId,
                permission: 'view'
              });
            },
            proveVideo: async (video, drive) => {
              const live = await deps.catalog.proveVideo(video, drive);
              if (video.id === restitchMaterialId) {
                if (
                  !Array.isArray(restitchIdentity) ||
                  restitchIdentity.length !== 2 ||
                  restitchIdentity[0] !== live.id ||
                  typeof restitchIdentity[1] !== 'string' ||
                  (restitchIdentity[1].startsWith('md5:')
                    ? restitchIdentity[1] !== `md5:${live.checksum?.toLowerCase()}`
                    : restitchIdentity[1] !== `version:${live.version}`)
                )
                  throw new TeamFunctionError('SOURCE_CHANGED');
              }
              return live;
            },
            link: async input => {
              const linked = await call(deps.service, 'service_link_launch_restitch_catalog', {
                ...authority,
                p_companion: input.companionId,
                p_record: input.record
              });
              if (!isRecord(linked) || typeof linked.linked !== 'boolean')
                throw new TeamFunctionError('INVALID_RESPONSE');
              if (!linked.linked) return { linked: false, reason: 'NOT_ELIGIBLE' };
              if (typeof linked.variant !== 'number' || !Number.isSafeInteger(linked.variant))
                throw new TeamFunctionError('INVALID_RESPONSE');
              return { linked: true, retired: [], variant: linked.variant };
            }
          }
        : deps.catalog;
    const created = await createDurableProductCatalog(
      {
        ...catalog,
        ...(initialVideoAuthority ? { initialVideoAuthority } : {}),
        ...(Object.values(config.subConfig).some(
          value => Array.isArray(value) && value.includes('catalogName')
        )
          ? {
              resolveSourceLink: async (name: string) => {
                if (!sources) throw new TeamFunctionError('SOURCE_CHANGED');
                const resolved = launchPreview(config, sources, name);
                if (!resolved.ok) throw new TeamFunctionError('LAUNCH_SUB_INVALID');
                await call(deps.service, 'service_bind_launch_catalog_subs', {
                  ...authority,
                  p_name: name,
                  p_url: resolved.value.advertisingUrl,
                  p_sub_values: resolved.value.subValues
                });
                return resolved.value.advertisingUrl;
              }
            }
          : {})
      },
      guarded,
      deps.driveFor,
      protocolVideo && isRecord(frozenVideo)
        ? frozenVideo.requestPayload
        : {
            teamId,
            videoMaterialId: config.materialId,
            ...(claimed.catalogImageContractVersion === 2
              ? { catalogImageContractVersion: 2 }
              : {}),
            sourceLink: claimed.advertisingUrl,
            productCount: config.catalog.productCount,
            replacesMaterialId: null,
            restitchOperationId,
            idempotencyKey: `launch:${generationId}:catalog`,
            randomLinkVariation: true
          },
      actorId
    );
    if ('outcome' in created && created.outcome === 'preparing_video') {
      if (created.state === 'unknown') {
        // Preparation already requeued what may be retried; what is still
        // unknown here either cannot be proven or has no retry left.
        const settled = await settleVideoFailures(created.videoSetId);
        if ((!settled || settled.parentState === 'unknown') && deps.readCatalogVideoFailure) {
          const cause = await deps.readCatalogVideoFailure({
            teamId,
            actorId,
            sourceMaterialId: config.materialId,
            setId: created.videoSetId
          });
          if (cause) {
            await stopForVideoFailure(cause, Boolean(settled && settled.terminal > 0));
            return { id: generationId, state: 'interrupted' };
          }
        }
      }
      await call(deps.service, 'service_wait_launch_catalog_video', authority);
      return { id: generationId, state: 'accepted' };
    }
    const createdVideoPending = await waitForRegisteredVideoDependency();
    if (createdVideoPending)
      return {
        id: generationId,
        state: createdVideoPending === 'failed' ? 'interrupted' : 'accepted'
      };
    await call(deps.service, 'service_attach_launch_catalog', authority);
    await stage('result_committing');
    return await call(deps.service, 'service_publish_launch_generation', {
      p_team: teamId,
      p_generation: generationId,
      p_actor: actorId,
      p_fence: fence
    });
  } catch (error) {
    await call(deps.service, 'service_interrupt_launch_generation', {
      ...authority,
      p_code: launchFailure(error).code
    }).catch(() => undefined);
    throw launchFailure(error);
  }
}
