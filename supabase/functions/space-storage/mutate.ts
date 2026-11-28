/**
 * `/materials/mutate` and `/trash/empty` (057 T025, contracts/storage-api.md).
 *
 * Every change is one database transaction (`service_mutate_space_materials`,
 * `service_empty_space_trash`, 20261226160000). A rename or a move is a row: no bytes and no
 * address change, so nothing here touches the bucket. A stale revision changes nothing and is
 * answered as REVISION_CONFLICT with the current revision (FR-040).
 */
// @deno-types="../../../packages/shared/dist/team/space-storage.d.ts"
import {
  isSpaceMutationAction,
  isSpaceUuid,
  parseByteCount,
  parseSpaceMaterialSnapshot,
  parseSpaceMutationResult,
  parseSpaceTrashEmptied,
  SPACE_MUTATION_BATCH,
  type SpaceMaterialSnapshot,
  type SpaceMutationAction,
  type SpaceMutationResult,
  type SpaceTrashEmptied
} from '../../../packages/shared/dist/team/space-storage.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceStorageJournalEntry } from '../_shared/space-storage-journal.ts';
import { isRecord } from '../_shared/validation.ts';
import { requireSpaceRequest, spaceRpcError, type Rpc, type SpacePermission } from './handler.ts';
import { normalizeSpaceName } from './uploads.ts';

export interface MutateDeps {
  actorId: string;
  rpc: Rpc;
  journal: (entry: SpaceStorageJournalEntry) => Promise<unknown>;
  operationId: string;
  client: SpaceStorageJournalEntry['client'];
}

const refuse = (code: ConstructorParameters<typeof TeamFunctionError>[0]): never => {
  throw new TeamFunctionError(code, { retryable: false });
};

export interface MutateCommand {
  teamId: string;
  action: SpaceMutationAction;
  materialIds: string[];
  expectedRevisions: Record<string, string>;
  name?: string;
  targetFolderId?: string | null;
  parentMaterialId?: string | null;
  ensure?: boolean;
}

/** The role each action needs (the same mapping as the Drive routes of drive-ops). */
export const SPACE_MUTATION_PERMISSION: Readonly<Record<SpaceMutationAction, SpacePermission>> = {
  rename: 'edit',
  move: 'edit',
  copy: 'upload',
  create_folder: 'upload',
  trash: 'delete',
  restore: 'delete'
};

export function parseMutateCommand(body: unknown): MutateCommand {
  if (!isRecord(body) || !isSpaceUuid(body.teamId) || !isSpaceMutationAction(body.action))
    return refuse('INVALID_INPUT');
  const action = body.action;
  const ids = body.materialIds ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > SPACE_MUTATION_BATCH ||
    !ids.every(isSpaceUuid) ||
    new Set(ids).size !== ids.length ||
    (action === 'create_folder' ? ids.length !== 0 : ids.length < 1) ||
    (action === 'rename' && ids.length !== 1)
  )
    return refuse('INVALID_INPUT');
  const expectedRevisions: Record<string, string> = {};
  if (body.expectedRevision !== undefined && body.expectedRevision !== null) {
    if (ids.length !== 1 || parseByteCount(body.expectedRevision) === null)
      return refuse('INVALID_INPUT');
    expectedRevisions[ids[0] as string] = body.expectedRevision as string;
  }
  if (body.expectedRevisions !== undefined) {
    if (!isRecord(body.expectedRevisions)) return refuse('INVALID_INPUT');
    for (const [id, revision] of Object.entries(body.expectedRevisions)) {
      if (!ids.includes(id) || parseByteCount(revision) === null) return refuse('INVALID_INPUT');
      expectedRevisions[id] = revision as string;
    }
  }
  const command: MutateCommand = {
    teamId: body.teamId,
    action,
    materialIds: ids as string[],
    expectedRevisions
  };
  if (action === 'rename' || action === 'create_folder') {
    const name = normalizeSpaceName(body.name);
    if (!name) return refuse('INVALID_INPUT');
    command.name = name;
  }
  if (action === 'move' || action === 'copy') {
    // Null: the root of the space.
    if (body.targetFolderId !== null && !isSpaceUuid(body.targetFolderId))
      return refuse('INVALID_INPUT');
    command.targetFolderId = body.targetFolderId as string | null;
  }
  if (action === 'create_folder') {
    if (
      body.parentMaterialId !== undefined &&
      body.parentMaterialId !== null &&
      !isSpaceUuid(body.parentMaterialId)
    )
      return refuse('INVALID_INPUT');
    if (body.ensure !== undefined && typeof body.ensure !== 'boolean')
      return refuse('INVALID_INPUT');
    command.parentMaterialId = (body.parentMaterialId as string | null | undefined) ?? null;
    command.ensure = body.ensure === true;
  }
  return command;
}

export function parseTrashEmptyCommand(body: unknown): {
  teamId: string;
  materialIds: string[] | null;
} {
  if (!isRecord(body) || !isSpaceUuid(body.teamId)) return refuse('INVALID_INPUT');
  if (body.materialIds === undefined || body.materialIds === null)
    return { teamId: body.teamId, materialIds: null };
  if (
    !Array.isArray(body.materialIds) ||
    body.materialIds.length < 1 ||
    body.materialIds.length > 1000 ||
    !body.materialIds.every(isSpaceUuid)
  )
    return refuse('INVALID_INPUT');
  return { teamId: body.teamId, materialIds: [...new Set(body.materialIds as string[])] };
}

async function call(rpc: Rpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await rpc(name, args);
  } catch (cause) {
    if (cause instanceof TeamFunctionError) throw cause;
    throw spaceRpcError(cause as { message?: unknown; code?: unknown });
  }
}

async function journaled<T>(
  deps: MutateDeps,
  stage: 'mutate' | 'trash_empty',
  teamId: string,
  work: () => Promise<T>
): Promise<T> {
  const record = (outcome: SpaceStorageJournalEntry['outcome'], code: string | null) =>
    deps
      .journal({
        operationId: deps.operationId,
        attempt: 1,
        stage,
        outcome,
        code,
        bytes: null,
        teamId,
        ingress: null,
        client: deps.client
      })
      .catch(() => undefined);
  try {
    const value = await work();
    await record('ok', null);
    return value;
  } catch (cause) {
    const error =
      cause instanceof TeamFunctionError ? cause : new TeamFunctionError('STORAGE_UNAVAILABLE');
    await record(error.retryable ? 'failed' : 'rejected', error.code);
    throw error;
  }
}

export async function mutateMaterials(
  command: MutateCommand,
  deps: MutateDeps
): Promise<SpaceMutationResult> {
  return journaled(deps, 'mutate', command.teamId, async () => {
    await requireSpaceRequest(deps.rpc, {
      teamId: command.teamId,
      actorId: deps.actorId,
      permission: SPACE_MUTATION_PERMISSION[command.action]
    });
    const value = await call(deps.rpc, 'service_mutate_space_materials', {
      p_actor: deps.actorId,
      p_team: command.teamId,
      p_input: {
        action: command.action,
        materialIds: command.materialIds,
        expectedRevisions: command.expectedRevisions,
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.targetFolderId === undefined ? {} : { targetFolderId: command.targetFolderId }),
        ...(command.action === 'create_folder'
          ? { parentMaterialId: command.parentMaterialId ?? null, ensure: command.ensure === true }
          : {})
      }
    });
    if (isRecord(value) && value.kind === 'conflict') {
      const current = parseByteCount(value.currentRevision);
      if (current === null || !isSpaceUuid(value.materialId)) return refuse('INVALID_RESPONSE');
      throw new TeamFunctionError('REVISION_CONFLICT', {
        retryable: false,
        details: { currentRevision: current.toString(10) }
      });
    }
    if (!isRecord(value) || value.kind !== 'ok') return refuse('INVALID_RESPONSE');
    const parsed = parseSpaceMutationResult(value);
    if (!parsed.ok) return refuse('INVALID_RESPONSE');
    return parsed.value;
  });
}

export async function emptyTrash(
  command: { teamId: string; materialIds: string[] | null },
  deps: MutateDeps
): Promise<SpaceTrashEmptied> {
  return journaled(deps, 'trash_empty', command.teamId, async () => {
    await requireSpaceRequest(deps.rpc, {
      teamId: command.teamId,
      actorId: deps.actorId,
      permission: 'delete'
    });
    const parsed = parseSpaceTrashEmptied(
      await call(deps.rpc, 'service_empty_space_trash', {
        p_actor: deps.actorId,
        p_team: command.teamId,
        p_ids: command.materialIds
      })
    );
    if (!parsed.ok) return refuse('INVALID_RESPONSE');
    return parsed.value;
  });
}

export function parseReadMaterialsCommand(body: unknown): {
  teamId: string;
  materialIds: string[];
} {
  if (
    !isRecord(body) ||
    !isSpaceUuid(body.teamId) ||
    !Array.isArray(body.materialIds) ||
    body.materialIds.length < 1 ||
    body.materialIds.length > SPACE_MUTATION_BATCH ||
    !body.materialIds.every(isSpaceUuid)
  )
    return refuse('INVALID_INPUT');
  return { teamId: body.teamId, materialIds: [...new Set(body.materialIds as string[])] };
}

/** `/materials/read`: snapshots of materials the client has not listed (a task attachment). */
export async function readMaterials(
  command: { teamId: string; materialIds: string[] },
  deps: Pick<MutateDeps, 'actorId' | 'rpc'>
): Promise<{ materials: SpaceMaterialSnapshot[] }> {
  await requireSpaceRequest(deps.rpc, {
    teamId: command.teamId,
    actorId: deps.actorId,
    permission: 'view'
  });
  const value = await call(deps.rpc, 'service_read_space_materials', {
    p_actor: deps.actorId,
    p_team: command.teamId,
    p_ids: command.materialIds
  });
  if (!Array.isArray(value)) return refuse('INVALID_RESPONSE');
  const materials: SpaceMaterialSnapshot[] = [];
  for (const item of value) {
    const parsed = parseSpaceMaterialSnapshot(item);
    if (!parsed.ok) return refuse('INVALID_RESPONSE');
    materials.push(parsed.value);
  }
  return { materials };
}
