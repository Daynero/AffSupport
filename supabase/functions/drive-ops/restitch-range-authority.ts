import { SCREEN_SELECTION_BOUNDS } from '../../../packages/shared/dist/team/restitch-selection.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  RestitchSelectionSlotStore,
  restitchSelectionRpcFailure,
  type RestitchSelectionSlotScope
} from './restitch-selection-store.ts';
import { readRestitchSelectionRange } from './restitch-range-reader.ts';
import {
  createRestitchRangeOpener,
  type FrozenRestitchRangeSource,
  type RestitchRangeSourceCredentials
} from './restitch-range-source.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uncertain = () =>
  new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', { retryable: true });
interface RestitchRangeContext {
  credentialId: string;
  source: FrozenRestitchRangeSource;
}
/** Service-side only. The browser/native request names opaque IDs, never a provider target. */
export async function readRestitchSelectionSource(
  service: ServiceRpcClient,
  scope: RestitchSelectionSlotScope,
  versionId: string,
  acquisition: number
): Promise<RestitchRangeContext> {
  scope = { ...scope, ...(scope.executor ? { executor: { ...scope.executor } } : {}) };
  // Validate and capture ownership before resolving credentials or provider context.
  new RestitchSelectionSlotStore(service, scope);
  if (
    ![scope.rootOperationId, scope.teamId, scope.actorId, versionId].every(
      value => typeof value === 'string' && UUID.test(value)
    ) ||
    !['start', 'end'].includes(scope.slot) ||
    !Number.isSafeInteger(acquisition) ||
    acquisition < 0 ||
    acquisition > 2
  )
    throw new TeamFunctionError('INVALID_INPUT');
  let reply: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    reply = await service.rpc(
      scope.executor
        ? 'service_read_restitch_selection_source_owned'
        : 'service_read_restitch_selection_source',
      {
        ...(scope.executor ? { p_executor: scope.executor.id, p_epoch: scope.executor.epoch } : {}),
        p_root_operation: scope.rootOperationId,
        p_team: scope.teamId,
        p_actor: scope.actorId,
        p_slot: scope.slot,
        p_version: versionId,
        p_acquisition: acquisition
      }
    );
  } catch {
    throw uncertain();
  }
  if (reply.error) restitchSelectionRpcFailure(reply.error);
  const row = reply.data;
  if (
    !isRecord(row) ||
    row.rootOperationId !== scope.rootOperationId.toLowerCase() ||
    row.teamId !== scope.teamId.toLowerCase() ||
    row.actorId !== scope.actorId.toLowerCase() ||
    row.slot !== scope.slot ||
    row.versionId !== versionId.toLowerCase() ||
    row.acquisition !== acquisition ||
    (scope.executor !== undefined &&
      (row.executorId !== scope.executor.id.toLowerCase() || row.epoch !== scope.executor.epoch)) ||
    typeof row.credentialId !== 'string' ||
    !UUID.test(row.credentialId) ||
    !isRecord(row.source)
  )
    throw uncertain();
  const source = row.source;
  if (
    typeof source.fileId !== 'string' ||
    !source.fileId ||
    source.fileId.length > 1024 ||
    (source.resourceKey !== null &&
      (typeof source.resourceKey !== 'string' ||
        !source.resourceKey ||
        source.resourceKey.length > 4096)) ||
    typeof source.parentFolderId !== 'string' ||
    !source.parentFolderId ||
    source.parentFolderId.length > 1024 ||
    typeof source.rootFolderId !== 'string' ||
    !source.rootFolderId ||
    source.rootFolderId.length > 1024 ||
    typeof source.sizeBytes !== 'number' ||
    !Number.isSafeInteger(source.sizeBytes) ||
    source.sizeBytes < 1 ||
    source.sizeBytes > SCREEN_SELECTION_BOUNDS.screenBytes ||
    typeof source.mimeType !== 'string' ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType) ||
    typeof source.checksum !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(source.checksum)
  )
    throw uncertain();
  return {
    credentialId: row.credentialId,
    source: {
      fileId: source.fileId,
      resourceKey: source.resourceKey as string | null,
      parentFolderId: source.parentFolderId,
      rootFolderId: source.rootFolderId,
      sizeBytes: source.sizeBytes,
      mimeType: source.mimeType as FrozenRestitchRangeSource['mimeType'],
      checksum: source.checksum
    }
  };
}

export async function readAuthoritativeRestitchSelectionRange(
  input: {
    service: ServiceRpcClient;
    scope: RestitchSelectionSlotScope;
    versionId: string;
    acquisition: number;
    requestId: string;
    offset: number;
    signal?: AbortSignal;
  },
  deps: {
    fetch: typeof fetch;
    readCredentials: (credentialId: string) => Promise<RestitchRangeSourceCredentials>;
    now?: () => number;
  }
): Promise<Response> {
  // Capture the request before any await; a retained mutable object cannot
  // combine one root's provider context with another root's reservation.
  input = {
    ...input,
    scope: {
      ...input.scope,
      ...(input.scope.executor ? { executor: { ...input.scope.executor } } : {})
    }
  };
  if (input.signal?.aborted) throw new TeamFunctionError('PROCESS_CANCELED');
  const context = await readRestitchSelectionSource(
    input.service,
    input.scope,
    input.versionId,
    input.acquisition
  );
  const credentials = await deps.readCredentials(context.credentialId);
  return readRestitchSelectionRange(
    {
      store: new RestitchSelectionSlotStore(input.service, input.scope),
      versionId: input.versionId,
      acquisition: input.acquisition,
      requestId: input.requestId,
      offset: input.offset,
      sourceFileId: context.source.fileId,
      sourceBytes: context.source.sizeBytes,
      mimeType: context.source.mimeType,
      signal: input.signal
    },
    {
      fetch: deps.fetch,
      now: deps.now,
      open: createRestitchRangeOpener(context.source, credentials)
    }
  );
}
