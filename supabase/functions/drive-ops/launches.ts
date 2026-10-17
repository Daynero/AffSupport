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
  caller: ServiceRpcClient;
  service: ServiceRpcClient;
  proveSource?: (
    teamId: string,
    actor: string,
    config: LaunchConfig,
    source: LaunchSourceSnapshot
  ) => Promise<void>;
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
    typeof input.requestKey !== 'string'
  )
    throw new TeamFunctionError('INVALID_INPUT');
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
  const digestBytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({
        actor,
        team: input.teamId,
        launch: input.launchId,
        version: input.expectedVersion,
        config: parsed.value,
        sources: source
      })
    )
  );
  const digest = Array.from(new Uint8Array(digestBytes), b => b.toString(16).padStart(2, '0')).join(
    ''
  );
  const accepted = await rpc(deps.service, 'service_accept_launch_generation', {
    ...params,
    p_actor: actor,
    p_expected_version: input.expectedVersion,
    p_key: input.requestKey,
    p_digest: digest,
    p_config: parsed.value,
    p_sources: source,
    p_preview: preview.value
  });
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
