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
  try {
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
    if (config.catalog.restitchEnabled) {
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
      `launch:${generationId}:catalog`
    );
    const resourcePlanner = store.resources;
    const guarded: CatalogIntentStore = {
      ...store,
      begin: async (payload, childOwner) => {
        await stage('catalog_planning');
        return store.begin(payload, childOwner);
      },
      checkpoint: async (intent, childOwner, state, patch, operationId, result) => {
        await stage(
          state === 'interrupted' || state === 'cleanup_pending'
            ? currentStage
            : state === 'create_started'
              ? 'catalog_creating'
              : state === 'created'
                ? 'catalog_sharing'
                : state === 'finalized' || state === 'registered'
                  ? 'catalog_registering'
                  : 'catalog_planning'
        );
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
    await createDurableProductCatalog(
      {
        ...catalog,
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
      {
        teamId,
        videoMaterialId: config.materialId,
        ...(claimed.catalogImageContractVersion === 2 ? { catalogImageContractVersion: 2 } : {}),
        sourceLink: claimed.advertisingUrl,
        productCount: config.catalog.productCount,
        replacesMaterialId: null,
        restitchOperationId,
        idempotencyKey: `launch:${generationId}:catalog`,
        randomLinkVariation: true
      },
      actorId
    );
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
