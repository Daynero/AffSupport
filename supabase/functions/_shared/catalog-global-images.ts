// @deno-types="../../../packages/shared/dist/team/catalog-global-images.d.ts"
import {
  GLOBAL_CATALOG_IMAGE_LIMITS,
  isGlobalCatalogImage,
  isGlobalImageId,
  isGlobalImageReadiness,
  type GlobalCatalogImage,
  type GlobalImageReadiness
} from '../../../packages/shared/dist/team/catalog-global-images.js';
import { isRecord } from './validation.ts';
import { TeamFunctionError } from './errors.ts';
import { catalogImageRpc, type CatalogImageRpc } from './catalog-images.ts';

export interface GlobalImageAllocation {
  actorId: string;
  teamId: string;
  catalogId: string;
  intentId: string;
  count: number;
  policyEpoch: number;
  scope?: 'create' | 'refresh' | 'growth';
  pairs?: readonly ({ garment: string | null; color: string | null } | null)[];
}
export interface GlobalImageRecipe {
  recipeId: string;
  catalogId: string;
  policyEpoch: number;
  images: GlobalCatalogImage[];
  reused: boolean;
}

export async function readGlobalImageReadiness(
  service: CatalogImageRpc,
  actorId: string,
  teamId?: string
): Promise<GlobalImageReadiness> {
  const result = await catalogImageRpc(service, 'service_catalog_global_readiness', {
    p_actor: actorId,
    p_team: teamId ?? null
  });
  if (!isGlobalImageReadiness(result)) throw new TeamFunctionError('INVALID_RESPONSE');
  return result;
}

/** A timeout is an unknown durable allocation, never permission for a new intent. */
export async function allocateGlobalImageRecipe(
  service: CatalogImageRpc,
  request: GlobalImageAllocation
): Promise<GlobalImageRecipe> {
  if (
    ![request.actorId, request.teamId, request.catalogId, request.intentId].every(
      isGlobalImageId
    ) ||
    !Number.isSafeInteger(request.count) ||
    request.count < 1 ||
    request.count > GLOBAL_CATALOG_IMAGE_LIMITS.batchRows ||
    !Number.isSafeInteger(request.policyEpoch) ||
    request.policyEpoch < 1 ||
    (request.pairs && request.pairs.length > request.count)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result: unknown = await Promise.race([
      catalogImageRpc(service, 'service_catalog_global_allocate', {
        p_actor: request.actorId,
        p_team: request.teamId,
        p_catalog: request.catalogId,
        p_intent: request.intentId,
        p_count: request.count,
        p_epoch: request.policyEpoch,
        p_scope: request.scope ?? 'create',
        p_pairs: request.pairs ?? []
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new TeamFunctionError('GLOBAL_IMAGE_ALLOCATION_UNKNOWN', { retryable: true })),
          GLOBAL_CATALOG_IMAGE_LIMITS.allocationDeadlineMs
        );
      })
    ]);
    if (
      !isRecord(result) ||
      !isGlobalImageId(result.recipeId) ||
      !isGlobalImageId(result.catalogId) ||
      result.policyEpoch !== request.policyEpoch ||
      !Array.isArray(result.images) ||
      result.images.length !== request.count ||
      !result.images.every(isGlobalCatalogImage) ||
      result.images.some(image => image.policyEpoch !== request.policyEpoch) ||
      typeof result.reused !== 'boolean'
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    return {
      recipeId: result.recipeId,
      catalogId: result.catalogId,
      policyEpoch: request.policyEpoch,
      images: result.images,
      reused: result.reused
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function confirmGlobalImageUses(
  service: CatalogImageRpc,
  teamId: string,
  intentId: string,
  completionId: string
): Promise<number> {
  if (![teamId, intentId, completionId].every(isGlobalImageId))
    throw new TeamFunctionError('INVALID_INPUT');
  const result = await catalogImageRpc(service, 'service_catalog_global_confirm', {
    p_team: teamId,
    p_intent: intentId,
    p_completion: completionId
  });
  if (
    !isRecord(result) ||
    typeof result.confirmed !== 'number' ||
    !Number.isSafeInteger(result.confirmed) ||
    result.confirmed < 0 ||
    result.confirmed > 400
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return result.confirmed;
}
