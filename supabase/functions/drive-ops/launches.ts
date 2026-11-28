import {
  parseCatalogVideoForegroundExecutor,
  type CatalogVideoForegroundExecutor
} from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import { prepareLaunchCatalogVideoAdmission } from './launch-catalog-video.ts';
import { assertSpaceLaunchCatalog } from './launch-space-source.ts';
import { launchFailure } from '../_shared/launch-failures.ts';
import {
  parseLaunchConfig,
  parseLaunchSources,
  launchPreview,
  type LaunchConfig,
  type LaunchSourceSnapshot
} from '../../../packages/shared/dist/team/launches.js';
import { isRecord } from '../../../packages/shared/dist/team/contract.js';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode
} from '../../../packages/shared/dist/team/transport.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

export interface LaunchGenerationDeps {
  /** Must prove the hosted executor is configured before accepting catalog work. */
  catalogReady?: () => Promise<void>;
  prepareForeground?: (input: {
    teamId: string;
    actorId: string;
    sourceMaterialId: string;
    requestKey: string;
    expectedVersion: string;
    receipt: CatalogVideoForegroundExecutor;
    retireUnused?: boolean;
  }) => Promise<void>;
  caller: ServiceRpcClient;
  service: ServiceRpcClient;
  /**
   * 057 T104/T115: the Launch is an R2 space's. What its catalog cannot make there yet is refused
   * before anything is accepted (launch-space-source.ts), and its admission reads no Drive
   * video context (re-stitched, it freezes the space's variation sets); a Drive space's Launch
   * never sets it.
   */
  spaceStorage?: boolean;
  proveSource?: (
    teamId: string,
    actor: string,
    config: LaunchConfig,
    source: LaunchSourceSnapshot
  ) => Promise<void>;
}
/**
 * 062: the source snapshot of each creative after the first, so each one is proven against
 * the identity the server resolved for it (the first is the snapshot itself).
 */
export function launchOtherMaterialSnapshots(source: LaunchSourceSnapshot): LaunchSourceSnapshot[] {
  return (source.materials ?? []).slice(1).map(material => ({
    ...source,
    materialId: material.materialId,
    materialType: material.type,
    materialVersion: material.version,
    ...(material.checksum !== undefined ? { materialChecksum: material.checksum } : {}),
    ...(material.driveFileId !== undefined ? { materialDriveFileId: material.driveFileId } : {})
  }));
}
async function rpc(
  client: ServiceRpcClient,
  name: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await client.rpc(name, params);
  if (error) {
    const code: TeamErrorCode =
      TEAM_ERROR_CODES.find(c => c === error.message) ?? 'INVALID_RESPONSE';
    throw new TeamFunctionError(code);
  }
  return data;
}
async function generateLaunchUnchecked(
  deps: LaunchGenerationDeps,
  input: unknown,
  actor: string
): Promise<unknown> {
  if (
    !isRecord(input) ||
    typeof input.teamId !== 'string' ||
    typeof input.launchId !== 'string' ||
    typeof input.expectedVersion !== 'string' ||
    typeof input.requestKey !== 'string' ||
    (input.expectedExecutorId !== undefined &&
      (typeof input.expectedExecutorId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
          input.expectedExecutorId
        ))) ||
    (input.spaceForeground !== undefined && input.spaceForeground !== true)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  // 057 T119: only an R2 space's page hands its variations to the member's open Soty itself.
  if (input.spaceForeground === true && !deps.spaceStorage)
    throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
  const foregroundExecutor =
    input.foregroundExecutor === undefined
      ? undefined
      : parseCatalogVideoForegroundExecutor(input.foregroundExecutor);
  if (
    input.foregroundExecutor !== undefined &&
    (!foregroundExecutor || input.expectedExecutorId !== undefined)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  // 057 T115: an R2 space's variations run on the member's own agent, never in a paired Drive
  // foreground session (whose enrollment is a Drive one); T119: the page hands them over itself.
  if (deps.spaceStorage && foregroundExecutor)
    throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
  const params = { p_team: input.teamId, p_launch: input.launchId };
  // Lookup before live source resolution, including after an authoritative commit whose reply was lost.
  const previous = await rpc(deps.caller, 'find_launch_generation', {
    p_team: input.teamId,
    p_key: input.requestKey
  });
  if (previous !== null) {
    if (
      !isRecord(previous) ||
      previous.launchId !== input.launchId ||
      previous.expectedVersion !== input.expectedVersion
    )
      throw new TeamFunctionError('LAUNCH_VERSION_CONFLICT');
    if (foregroundExecutor && previous.method === 'catalog') {
      if (!deps.prepareForeground || typeof previous.id !== 'string')
        throw new TeamFunctionError('AUTH_REQUIRED');
      const scope = await rpc(deps.service, 'service_launch_catalog_foreground_source', {
        p_team: input.teamId,
        p_actor: actor,
        p_generation: previous.id,
        p_key: input.requestKey,
        p_version: input.expectedVersion
      });
      if (!isRecord(scope) || typeof scope.sourceMaterialId !== 'string')
        throw new TeamFunctionError('INVALID_RESPONSE');
      await deps.prepareForeground({
        teamId: input.teamId,
        actorId: actor,
        sourceMaterialId: scope.sourceMaterialId,
        requestKey: input.requestKey,
        expectedVersion: input.expectedVersion,
        receipt: foregroundExecutor,
        retireUnused: true
      });
    }
    if (
      previous.method === 'other' &&
      (previous.state === 'accepted' || previous.state === 'running')
    ) {
      if (typeof previous.id !== 'string' || typeof previous.fence !== 'string')
        throw new TeamFunctionError('INVALID_RESPONSE');
      return rpc(deps.service, 'service_publish_launch_generation', {
        p_team: input.teamId,
        p_generation: previous.id,
        p_actor: actor,
        p_fence: previous.fence
      });
    }
    return previous;
  }
  const detail = await rpc(deps.caller, 'get_launch', { ...params, p_revision: null });
  if (!isRecord(detail) || detail.version !== input.expectedVersion)
    throw new TeamFunctionError('LAUNCH_VERSION_CONFLICT');
  const parsed = parseLaunchConfig(detail.draft);
  if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT');
  if (deps.spaceStorage) assertSpaceLaunchCatalog(parsed.value);
  // Both methods use the hosted catalog coordinator after any Launch-owned local child.
  if (parsed.value.method === 'catalog') {
    if (!deps.catalogReady) throw new TeamFunctionError('NO_WORK');
    await deps.catalogReady();
  }
  const source = parseLaunchSources(
    await rpc(deps.service, 'service_launch_sources', { ...params, p_actor: actor })
  );
  if (!source) throw new TeamFunctionError('SOURCE_CHANGED');
  await deps.proveSource?.(input.teamId, actor, parsed.value, source);
  const preview = launchPreview(parsed.value, source);
  if (!preview.ok) throw new TeamFunctionError('INVALID_INPUT');
  if (foregroundExecutor) {
    if (
      !deps.prepareForeground ||
      parsed.value.method !== 'catalog' ||
      !parsed.value.catalog.restitchEnabled
    )
      throw new TeamFunctionError('AUTH_REQUIRED');
    await deps.prepareForeground({
      teamId: input.teamId,
      actorId: actor,
      sourceMaterialId: parsed.value.materialId,
      requestKey: input.requestKey,
      expectedVersion: input.expectedVersion,
      receipt: foregroundExecutor
    });
  }
  const videoAdmission =
    parsed.value.method === 'catalog' && parsed.value.catalog.catalogVideoProtocolVersion === 1
      ? await prepareLaunchCatalogVideoAdmission(deps.service, {
          teamId: input.teamId,
          actorId: actor,
          launchId: input.launchId,
          config: parsed.value,
          ...(deps.spaceStorage ? { spaceStorage: true } : {}),
          ...(deps.spaceStorage && input.spaceForeground === true ? { spaceForeground: true } : {}),
          ...(foregroundExecutor ? { foregroundExecutor } : {}),
          // An R2 space names no executor (its acceptance requires the member's delegation).
          ...(typeof input.expectedExecutorId === 'string' && !deps.spaceStorage
            ? { expectedExecutorId: input.expectedExecutorId }
            : {})
        })
      : null;
  const digestBytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({
        actor,
        team: input.teamId,
        launch: input.launchId,
        version: input.expectedVersion,
        config: parsed.value,
        sources: source,
        ...(videoAdmission ? { catalogExecutorId: videoAdmission.executorId } : {})
      })
    )
  );
  const digest = Array.from(new Uint8Array(digestBytes), b => b.toString(16).padStart(2, '0')).join(
    ''
  );
  const accepted = await rpc(
    deps.service,
    videoAdmission
      ? 'service_accept_launch_catalog_video_generation'
      : 'service_accept_launch_generation',
    {
      ...params,
      p_actor: actor,
      p_expected_version: input.expectedVersion,
      p_key: input.requestKey,
      p_digest: digest,
      p_config: parsed.value,
      p_sources: source,
      p_preview: preview.value,
      ...(videoAdmission ? { p_video: videoAdmission } : {})
    }
  );
  if (!isRecord(accepted) || typeof accepted.id !== 'string' || typeof accepted.fence !== 'string')
    throw new TeamFunctionError('INVALID_RESPONSE');
  if (parsed.value.method === 'catalog') return { ...accepted, state: 'accepted' };
  return rpc(deps.service, 'service_publish_launch_generation', {
    p_team: input.teamId,
    p_generation: accepted.id,
    p_actor: actor,
    p_fence: accepted.fence
  });
}

export async function generateLaunch(
  deps: LaunchGenerationDeps,
  input: unknown,
  actor: string
): Promise<unknown> {
  try {
    return await generateLaunchUnchecked(deps, input, actor);
  } catch (error) {
    throw launchFailure(error);
  }
}
