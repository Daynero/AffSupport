/**
 * `/catalog-variants/run` (057 T094, research.md R15): hands one re-stitched variation of a
 * catalog in an R2 space to the member's own agent.
 *
 * A variation is an ordinary tool run of the space (process.ts): the source is read through
 * `/agent/source`, the output is an R2 upload finalized by `/process/output/finalize`, which
 * registers it as the variation's output in the same transaction (20261226250000). What this
 * route adds is the catalog's authority over the run:
 *
 * - the run is opened here, never by `/process/start` (which refuses the `space-variant:` keys),
 *   under `space-variant:<request>:<attempt>`, in the space's «Restitched» folder, at most three
 *   times per variation; a run already open is handed out again with fresh tickets (the page was
 *   reloaded; the agent refuses a run it is already doing);
 * - the settings are the set's, frozen when the creation admitted it, and the duration is drawn
 *   from the variation's own identity (`sampleCatalogVideoDuration`), so a second hand-out of
 *   the same variation draws the same length — never the browser's choice.
 */
// @deno-types="../../../packages/shared/dist/team/restitch.d.ts"
import {
  parseTeamRestitchDefaults,
  type TeamRestitchDefaults
} from '../../../packages/shared/dist/team/restitch.js';
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import { isSpaceUuid } from '../../../packages/shared/dist/team/space-storage.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { sampleCatalogVideoDuration } from '../drive-ops/catalog-video-duration.ts';
import { displayDriveName } from '../drive-ops/handler.ts';
import { spaceRpcError } from './handler.ts';
import {
  issueSpaceProcessGrants,
  openSpaceProcess,
  SPACE_PROCESS_AGENT_CONTRACT,
  type IssuedGrant,
  type OpenedSpaceProcess,
  type ProcessDeps
} from './process.ts';

/** Where every variation of a space lands (the Drive space's folder has the same name). */
export const SPACE_RESTITCHED_FOLDER_NAME = 'Restitched';

export interface CatalogVariantRunCommand {
  teamId: string;
  setId: string;
  index: number;
  toolContractVersion: number;
}

const refuse = (code: ConstructorParameters<typeof TeamFunctionError>[0]): never => {
  throw new TeamFunctionError(code, { retryable: false });
};

export function parseCatalogVariantRunCommand(body: unknown): CatalogVariantRunCommand {
  if (
    !isRecord(body) ||
    !isSpaceUuid(body.teamId) ||
    !isSpaceUuid(body.setId) ||
    !Number.isSafeInteger(body.index) ||
    (body.index as number) < 0 ||
    (body.index as number) > 399 ||
    !Number.isSafeInteger(body.toolContractVersion) ||
    (body.toolContractVersion as number) < 1
  )
    return refuse('INVALID_INPUT');
  return {
    teamId: body.teamId,
    setId: body.setId,
    index: body.index as number,
    toolContractVersion: body.toolContractVersion as number
  };
}

export type CatalogVariantRunAnswer =
  | { state: 'registered'; index: number; outputMaterialId: string }
  | { state: 'failed' | 'canceled'; index: number }
  | {
      state: 'run';
      index: number;
      operationId: string;
      agentContractVersion: number;
      sourceGrant: IssuedGrant;
      finalizeGrant: IssuedGrant;
      defaults: TeamRestitchDefaults;
    };

async function call(deps: ProcessDeps, name: string, args: Record<string, unknown>) {
  try {
    return await deps.rpc(name, args);
  } catch (cause) {
    if (cause instanceof TeamFunctionError) throw cause;
    throw spaceRpcError(cause as { message?: unknown; code?: unknown });
  }
}

interface Claim {
  state: 'registered' | 'failed' | 'canceled' | 'open' | 'running';
  index: number;
  outputMaterialId: string | null;
  requestId: string;
  attempt: number;
  operationId: string | null;
  destinationFolderId: string | null;
  sourceMaterialId: string;
  sourceName: string;
  settings: TeamRestitchDefaults;
  settingsDigest: string;
}

function parseClaim(
  value: unknown,
  index: number
): Claim | { state: Claim['state']; index: number; outputMaterialId: string | null } {
  if (!isRecord(value) || value.index !== index) return refuse('INVALID_RESPONSE');
  const state = value.state;
  if (state === 'registered') {
    if (!isSpaceUuid(value.outputMaterialId)) return refuse('INVALID_RESPONSE');
    return { state, index, outputMaterialId: value.outputMaterialId };
  }
  if (state === 'failed' || state === 'canceled') return { state, index, outputMaterialId: null };
  if (state !== 'open' && state !== 'running') return refuse('INVALID_RESPONSE');
  const settings = parseTeamRestitchDefaults(value.settings);
  if (
    !isSpaceUuid(value.requestId) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.attempt as number) > 3 ||
    !isSpaceUuid(value.sourceMaterialId) ||
    typeof value.sourceName !== 'string' ||
    typeof value.settingsDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.settingsDigest) ||
    (state === 'running' &&
      (!isSpaceUuid(value.operationId) || !isSpaceUuid(value.destinationFolderId)))
  )
    return refuse('INVALID_RESPONSE');
  if (!settings.ok || !settings.value.configured) return refuse('RESTITCH_INVALID');
  return {
    state,
    index,
    outputMaterialId: null,
    requestId: value.requestId,
    attempt: value.attempt as number,
    operationId: state === 'running' ? (value.operationId as string) : null,
    destinationFolderId: state === 'running' ? (value.destinationFolderId as string) : null,
    sourceMaterialId: value.sourceMaterialId,
    sourceName: value.sourceName,
    settings: settings.value,
    settingsDigest: value.settingsDigest
  };
}

/** `clip.mp4` → `clip restitched 3.mp4`: the variation's own name in «Restitched». */
export function catalogVariantOutputName(sourceName: string, index: number): string {
  const name = displayDriveName(sourceName);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return displayDriveName(`${stem} restitched ${index + 1}.mp4`);
}

export async function runCatalogVariant(
  command: CatalogVariantRunCommand,
  deps: ProcessDeps
): Promise<CatalogVariantRunAnswer> {
  const actorId = deps.actorId ?? refuse('PERMISSION_DENIED');
  const claim = parseClaim(
    await call(deps, 'service_space_catalog_variant_run', {
      p_team: command.teamId,
      p_actor: actorId,
      p_set: command.setId,
      p_index: command.index
    }),
    command.index
  );
  if (claim.state === 'registered')
    return { state: 'registered', index: claim.index, outputMaterialId: claim.outputMaterialId! };
  if (claim.state === 'failed' || claim.state === 'canceled')
    return { state: claim.state, index: claim.index };
  const run = claim as Claim;
  let opened: Pick<
    OpenedSpaceProcess,
    'operationId' | 'teamId' | 'actorId' | 'materialId' | 'destinationFolderId' | 'toolId'
  >;
  if (run.state === 'running') {
    opened = {
      operationId: run.operationId!,
      teamId: command.teamId,
      actorId,
      materialId: run.sourceMaterialId,
      destinationFolderId: run.destinationFolderId!,
      toolId: 'restitch'
    };
  } else {
    const folder = await call(deps, 'service_mutate_space_materials', {
      p_actor: actorId,
      p_team: command.teamId,
      p_input: { action: 'create_folder', name: SPACE_RESTITCHED_FOLDER_NAME, ensure: true }
    });
    const folderId =
      isRecord(folder) && Array.isArray(folder.materials) && isRecord(folder.materials[0])
        ? folder.materials[0].id
        : null;
    if (!isSpaceUuid(folderId)) return refuse('INVALID_RESPONSE');
    const started = await openSpaceProcess(
      {
        teamId: command.teamId,
        materialId: run.sourceMaterialId,
        destinationFolderId: folderId,
        idempotencyKey: `space-variant:${run.requestId}:${run.attempt}`,
        toolId: 'restitch',
        outputName: catalogVariantOutputName(run.sourceName, command.index),
        conflictMode: 'keep_both',
        agentContractVersion: SPACE_PROCESS_AGENT_CONTRACT,
        toolContractVersion: command.toolContractVersion
      },
      deps
    );
    try {
      await call(deps, 'service_bind_space_catalog_variant_run', {
        p_team: command.teamId,
        p_actor: actorId,
        p_set: command.setId,
        p_index: command.index,
        p_attempt: run.attempt,
        p_operation: started.operationId
      });
    } catch (cause) {
      // Another page bound a run first: this one never reaches an agent.
      if (!started.reused)
        await call(deps, 'service_transition_team_operation', {
          p_operation: started.operationId,
          p_state: 'canceled',
          p_stage: 'canceled',
          p_progress: 0,
          p_result_material: null,
          p_error_code: null,
          p_retryable: false
        }).catch(() => undefined);
      throw cause;
    }
    opened = started;
  }
  const grants = await issueSpaceProcessGrants(opened, deps);
  const defaults = await sampleCatalogVideoDuration(run.settings, {
    setId: command.setId,
    requestId: run.requestId,
    settingsDigest: run.settingsDigest
  });
  return {
    state: 'run',
    index: command.index,
    operationId: grants.operationId,
    agentContractVersion: grants.agentContractVersion,
    sourceGrant: grants.sourceGrant,
    finalizeGrant: grants.finalizeGrant,
    defaults
  };
}
