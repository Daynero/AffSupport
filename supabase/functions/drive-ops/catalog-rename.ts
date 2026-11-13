import {
  parseCatalogRenameContext,
  parseCatalogRenameReceipt,
  parseCatalogRenameRequest,
  type CatalogRenameReceipt
} from '../../../packages/shared/dist/team/catalog-rename.js';
import { isLaunchUuid } from '../../../packages/shared/dist/team/launches.js';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode
} from '../../../packages/shared/dist/team/transport.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { CatalogRenameFile, DriveFileMetadata, GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';

interface RenameScope {
  teamId: string;
  materialId: string;
  actorId: string;
  requestKey: string;
}
export interface CatalogRenameDeps {
  service: ServiceRpcClient;
  /** Fresh actor permission, credential, native Google metadata and full ancestry proof. */
  prove(
    scope: { teamId: string; materialId: string; actorId: string },
    signal: AbortSignal
  ): Promise<{
    drive: Pick<GoogleDriveClient, 'getCatalogRenameFile' | 'renameCatalogConditionally'>;
    live: DriveFileMetadata;
  }>;
}
interface RenamePlan {
  operationId: string;
  oldName: string;
  newName: string;
  fileId: string;
  parentId: string;
  driveVersion: string | null;
  etag: string | null;
  dispatched: boolean;
}
async function rpc(service: ServiceRpcClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await service.rpc(name, args);
  if (error)
    throw new TeamFunctionError(
      TEAM_ERROR_CODES.find(code => code === error.message) ?? 'DRIVE_UNAVAILABLE'
    );
  return data;
}
function identity(raw: unknown, actorId: string, requireKey = true): RenameScope {
  if (
    !isRecord(raw) ||
    !isLaunchUuid(raw.teamId) ||
    !isLaunchUuid(raw.materialId) ||
    raw.expectedActorId !== actorId ||
    !isLaunchUuid(actorId) ||
    (requireKey && !isLaunchUuid(raw.requestKey))
  )
    throw new TeamFunctionError('PERMISSION_DENIED');
  return {
    teamId: raw.teamId,
    materialId: raw.materialId,
    actorId,
    requestKey: requireKey ? (raw.requestKey as string) : actorId
  };
}
function args(scope: RenameScope) {
  return {
    p_team: scope.teamId,
    p_material: scope.materialId,
    p_actor: scope.actorId,
    p_key: scope.requestKey
  };
}
function receipt(value: unknown, scope: RenameScope): CatalogRenameReceipt | null {
  if (value === null) return null;
  const result = parseCatalogRenameReceipt(value);
  if (
    !result ||
    result.teamId !== scope.teamId ||
    result.materialId !== scope.materialId ||
    result.requestKey !== scope.requestKey
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return result;
}
function plan(value: unknown, scope: RenameScope): RenamePlan | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isLaunchUuid(value.operationId) ||
    value.teamId !== scope.teamId ||
    value.materialId !== scope.materialId ||
    value.actorId !== scope.actorId ||
    value.requestKey !== scope.requestKey ||
    !['oldName', 'newName', 'fileId', 'parentId'].every(
      key => typeof value[key] === 'string' && String(value[key]).length > 0
    ) ||
    (value.etag !== null &&
      (typeof value.etag !== 'string' || !/^"[\x21\x23-\x7e]{1,510}"$/u.test(value.etag))) ||
    (value.driveVersion !== null && typeof value.driveVersion !== 'string') ||
    typeof value.dispatched !== 'boolean'
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return value as unknown as RenamePlan;
}
function sameTarget(file: CatalogRenameFile | DriveFileMetadata, expected: RenamePlan) {
  return (
    file.id === expected.fileId &&
    !file.trashed &&
    file.parents.length === 1 &&
    file.parents[0] === expected.parentId
  );
}
function mutationResult(file: DriveFileMetadata) {
  return {
    driveFileId: file.id,
    name: file.name,
    parentFolderId: file.parents[0] ?? null,
    driveVersion: file.version,
    checksum: file.checksum,
    sizeBytes: file.size,
    trashed: file.trashed
  };
}

/** One bounded attempt. Status may confirm a readback but never changes Google. */
export async function runCatalogRenameAttempt(
  deps: CatalogRenameDeps,
  scope: RenameScope,
  allowWrite: boolean,
  budgetMs = 7000
): Promise<CatalogRenameReceipt | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true }));
      },
      Math.max(1, Math.min(budgetMs, 7000))
    );
  });
  const bounded = <T>(value: PromiseLike<T>) => Promise.race([Promise.resolve(value), expired]);
  const owner = allowWrite ? crypto.randomUUID() : null;
  let current: RenamePlan | null = null;
  let issued = false;
  let provenConflict = false;
  const readReceipt = async () =>
    receipt(await rpc(deps.service, 'service_catalog_rename_status', args(scope)), scope);
  const settle = (
    drive: DriveFileMetadata | null,
    code: TeamErrorCode | null,
    terminal = false,
    retryAfterMs = 0
  ) =>
    rpc(deps.service, 'service_settle_catalog_rename', {
      p_operation: current!.operationId,
      p_owner: owner,
      p_drive: drive ? mutationResult(drive) : null,
      p_code: code,
      p_terminal: terminal,
      p_retry_after_ms: retryAfterMs
    });
  try {
    current = plan(
      await bounded(
        rpc(deps.service, 'service_claim_catalog_rename', { ...args(scope), p_owner: owner })
      ),
      scope
    );
    if (!current || (!allowWrite && !current.dispatched)) return await bounded(readReceipt());
    issued = current.dispatched;
    const proven = await bounded(deps.prove(scope, controller.signal));
    if (!sameTarget(proven.live, current)) {
      provenConflict = true;
      throw new TeamFunctionError('SOURCE_CHANGED');
    }
    let live = await bounded(proven.drive.getCatalogRenameFile(current.fileId, controller.signal));
    if (!sameTarget(live, current)) {
      provenConflict = true;
      throw new TeamFunctionError('SOURCE_CHANGED');
    }
    const confirm = async () => {
      const confirmed = await bounded(deps.prove(scope, controller.signal));
      if (!sameTarget(confirmed.live, current!) || confirmed.live.name !== current!.newName) {
        provenConflict = true;
        throw new TeamFunctionError('SOURCE_CHANGED');
      }
      controller.signal.throwIfAborted();
      return receipt(await bounded(settle(confirmed.live, null)), scope);
    };
    if (live.name === current.newName) return await confirm();
    if (live.name !== current.oldName || (current.etag !== null && live.etag !== current.etag)) {
      provenConflict = true;
      throw new TeamFunctionError('SOURCE_CHANGED');
    }
    if (!allowWrite) return await bounded(readReceipt());
    if (!live.canRename) throw new TeamFunctionError('PERMISSION_DENIED');
    const originalEtag = live.etag;
    await bounded(
      rpc(deps.service, 'service_prepare_catalog_rename', {
        p_operation: current.operationId,
        p_owner: owner,
        p_etag: live.etag,
        p_live_name: live.name,
        p_live_version: proven.live.version
      })
    );
    controller.signal.throwIfAborted();
    issued = true;
    // Every retry retains this original ETag. A late prior PATCH invalidates it,
    // so competing attempts cannot overwrite a newer metadata revision.
    let writeFailure: unknown;
    try {
      await bounded(
        proven.drive.renameCatalogConditionally(
          current.fileId,
          live.etag,
          current.newName,
          controller.signal
        )
      );
    } catch (error) {
      writeFailure = error;
    }
    controller.signal.throwIfAborted();
    live = await bounded(proven.drive.getCatalogRenameFile(current.fileId, controller.signal));
    if (!sameTarget(live, current)) {
      provenConflict = true;
      throw new TeamFunctionError('SOURCE_CHANGED');
    }
    if (live.name === current.newName) return await confirm();
    if (live.etag !== originalEtag || live.name !== current.oldName) {
      provenConflict = true;
      throw new TeamFunctionError('SOURCE_CHANGED');
    }
    throw writeFailure ?? new TeamFunctionError('DRIVE_UNAVAILABLE');
  } catch (error) {
    if (current && (allowWrite || provenConflict)) {
      const code = mapUnknownError(error).code;
      const terminal =
        provenConflict ||
        (!issued &&
          [
            'PERMISSION_DENIED',
            'NOT_FOUND',
            'SOURCE_CHANGED',
            'ROOT_ESCAPE',
            'WRONG_STATE',
            'INVALID_INPUT'
          ].includes(code));
      // A late settlement may only record a readback/error under the same lease;
      // it has no provider mutation authority after this attempt's deadline.
      const retryAfterMs =
        error instanceof TeamFunctionError && typeof error.details?.retryAfterMs === 'number'
          ? error.details.retryAfterMs
          : 0;
      try {
        await bounded(settle(null, code, terminal, retryAfterMs));
      } catch {
        /* Durable lease expires; worker resumes. */
      }
    }
    // The accepted intent remains visible even if both provider and bookkeeping
    // replies were lost. No synthetic success and no second request identity.
    const known = await bounded(readReceipt()).catch(() => ({
      teamId: scope.teamId,
      materialId: scope.materialId,
      requestKey: scope.requestKey,
      operationId: current?.operationId ?? null,
      state: 'pending' as const,
      currentName: null,
      errorCode: 'DRIVE_UNAVAILABLE' as const
    }));
    return known?.state === 'pending'
      ? { ...known, errorCode: mapUnknownError(error).code }
      : known;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function handleCatalogRename(
  action: 'context' | 'apply' | 'status',
  raw: unknown,
  actorId: string,
  deps: CatalogRenameDeps
) {
  const scope = identity(raw, actorId, action !== 'context');
  if (action === 'context') {
    const result = parseCatalogRenameContext(
      await rpc(deps.service, 'service_catalog_rename_context', {
        p_team: scope.teamId,
        p_material: scope.materialId,
        p_actor: actorId
      })
    );
    if (!result || result.teamId !== scope.teamId || result.materialId !== scope.materialId)
      throw new TeamFunctionError('INVALID_RESPONSE');
    return result;
  }
  if (action === 'apply') {
    const command = parseCatalogRenameRequest(raw);
    if (!command) throw new TeamFunctionError('INVALID_INPUT');
    const accepted = receipt(
      await rpc(deps.service, 'service_accept_catalog_rename', {
        ...args(scope),
        p_request: command
      }),
      scope
    );
    if (!accepted || accepted.state !== 'pending') return accepted;
    return runCatalogRenameAttempt(deps, scope, true);
  }
  const known = receipt(
    await rpc(deps.service, 'service_catalog_rename_status', args(scope)),
    scope
  );
  return known?.state === 'pending' ? runCatalogRenameAttempt(deps, scope, false) : known;
}

/** Existing hosted worker: browser closure cannot strand an admitted rename. */
export async function recoverCatalogRenames(deps: CatalogRenameDeps, budgetMs = 7000) {
  const budget = Math.max(1, Math.min(7000, budgetMs));
  const deadline = Date.now() + budget;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rows = await Promise.race([
    rpc(deps.service, 'service_due_catalog_renames', { p_limit: 3 }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TeamFunctionError('DRIVE_UNAVAILABLE')), budget);
    })
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (!Array.isArray(rows) || rows.length > 3) throw new TeamFunctionError('INVALID_RESPONSE');
  let completed = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    if (!isRecord(row) || !isLaunchUuid(row.actorId)) continue;
    const scope = identity({ ...row, expectedActorId: row.actorId }, row.actorId);
    try {
      const result = await runCatalogRenameAttempt(deps, scope, true, deadline - Date.now());
      if (result?.state !== 'pending') completed++;
    } catch {
      /* One unavailable catalog cannot block sibling work. */
    }
  }
  return { attempted: rows.length, completed };
}
