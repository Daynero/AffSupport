import type {
  LibraryPlacementMutationRequest,
  LibraryJobFinalizeRequest,
  LibraryShareCopyRequest,
  UploadBatchItemInput,
  UploadBatchRequest
} from '../../../packages/shared/dist/team/creative-library.js';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';

export type UploadBatchTerminalState = 'partial' | 'succeeded' | 'failed' | 'canceled';

export interface UploadBatchItemSuccess extends UploadBatchItemInput {
  materialId: string;
}

export interface UploadBatchItemFailure extends UploadBatchItemInput {
  errorCode: string;
}

export interface UploadBatchRunResult {
  state: UploadBatchTerminalState;
  succeeded: UploadBatchItemSuccess[];
  failed: UploadBatchItemFailure[];
  canceled: UploadBatchItemInput[];
  readyMaterialIds: string[];
}

export interface UploadBatchSnapshot extends UploadBatchRunResult {
  completed: number;
  total: number;
}

export function deriveUploadBatchState(counts: {
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
}): UploadBatchTerminalState {
  if (counts.succeeded === counts.total && counts.total > 0) return 'succeeded';
  if (counts.canceled === counts.total && counts.total > 0) return 'canceled';
  if (counts.succeeded > 0) return 'partial';
  return counts.failed > 0 ? 'failed' : 'canceled';
}

/** Stable opaque transport identity. It contains no filename, path or material content. */
export function uploadBatchItemKey(batchId: string, clientItemKey: string): string {
  const source = `${batchId}\u0000${clientItemKey}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `library-item-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createBatchUploadCoordinator(options: {
  concurrency: number;
  upload: (item: UploadBatchItemInput) => Promise<{ materialId: string }>;
}) {
  const concurrency = Math.min(12, Math.max(1, Math.trunc(options.concurrency)));

  async function execute(
    pending: UploadBatchItemInput[],
    initial: Pick<UploadBatchRunResult, 'succeeded' | 'failed' | 'canceled'>,
    onSnapshot?: (snapshot: UploadBatchSnapshot) => void
  ): Promise<UploadBatchRunResult> {
    const succeeded = [...initial.succeeded];
    const failed: UploadBatchItemFailure[] = [];
    const canceled = [...initial.canceled];
    let cursor = 0;
    const total = succeeded.length + canceled.length + pending.length;
    const notify = () => {
      const readyMaterialIds = succeeded.map(item => item.materialId);
      onSnapshot?.({
        state: deriveUploadBatchState({
          total,
          succeeded: succeeded.length,
          failed: failed.length,
          canceled: canceled.length
        }),
        succeeded: [...succeeded],
        failed: [...failed],
        canceled: [...canceled],
        readyMaterialIds,
        completed: succeeded.length + failed.length + canceled.length,
        total
      });
    };
    async function worker() {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        try {
          const result = await options.upload(item);
          if (!result || typeof result.materialId !== 'string' || result.materialId.length < 1) {
            throw new Error('INVALID_RESPONSE');
          }
          succeeded.push({ ...item, materialId: result.materialId });
        } catch (error) {
          failed.push({ ...item, errorCode: safeBatchErrorCode(error) });
        }
        notify();
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, () => worker())
    );
    const readyMaterialIds = succeeded.map(item => item.materialId);
    return {
      state: deriveUploadBatchState({
        total,
        succeeded: succeeded.length,
        failed: failed.length,
        canceled: canceled.length
      }),
      succeeded,
      failed,
      canceled,
      readyMaterialIds
    };
  }

  return {
    run(
      items: UploadBatchItemInput[],
      onSnapshot?: (snapshot: UploadBatchSnapshot) => void
    ): Promise<UploadBatchRunResult> {
      if (items.length < 1 || items.length > 500) {
        return Promise.reject(new TeamFunctionError('INVALID_INPUT'));
      }
      const seen = new Set<string>();
      if (items.some(item => seen.has(item.clientItemKey) || !seen.add(item.clientItemKey))) {
        return Promise.reject(new TeamFunctionError('INVALID_INPUT'));
      }
      return execute(items, { succeeded: [], failed: [], canceled: [] }, onSnapshot);
    },
    retryFailed(
      previous: UploadBatchRunResult,
      onSnapshot?: (snapshot: UploadBatchSnapshot) => void
    ): Promise<UploadBatchRunResult> {
      return execute(
        previous.failed.map(({ errorCode: _errorCode, ...item }) => item),
        { succeeded: previous.succeeded, failed: [], canceled: previous.canceled },
        onSnapshot
      );
    }
  };
}

function safeBatchErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const candidate = message.match(/[A-Z][A-Z0-9_]{2,63}/u)?.[0];
  return candidate ?? 'DRIVE_UNAVAILABLE';
}

export type LibraryOpsCommand =
  | { action: 'batch_start'; request: UploadBatchRequest }
  | { action: 'batch_get'; teamId: string; batchId: string }
  | { action: 'placement_move'; request: LibraryPlacementMutationRequest }
  | { action: 'job_finalize'; request: LibraryJobFinalizeRequest }
  | { action: 'share_copy'; request: LibraryShareCopyRequest }
  | {
      action: 'batch_item_finalize';
      teamId: string;
      batchId: string;
      clientItemKey: string;
      materialId: string;
    }
  | {
      action: 'batch_item_fail';
      teamId: string;
      batchId: string;
      clientItemKey: string;
      errorCode: string;
    };

export interface LibraryOpsRpc {
  (name: string, parameters: Record<string, unknown>): Promise<unknown>;
}

export interface LibraryOpsDependencies {
  actorId: string;
  callerRpc: LibraryOpsRpc;
  serviceRpc: LibraryOpsRpc;
  ensurePlacement?: (request: UploadBatchRequest) => Promise<{ destinationFolderId: string }>;
  startItem?: (input: {
    batchId: string;
    destinationFolderId: string | null;
    item: UploadBatchItemInput;
  }) => Promise<unknown>;
  movePlacement?: (request: LibraryPlacementMutationRequest) => Promise<unknown>;
  shareMaterial?: (request: LibraryShareCopyRequest) => Promise<unknown>;
}

export async function executeLibraryOpsCommand(
  command: LibraryOpsCommand,
  deps: LibraryOpsDependencies
): Promise<unknown> {
  if (command.action === 'placement_move') {
    if (!deps.movePlacement) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
    return deps.movePlacement(command.request);
  }
  if (command.action === 'share_copy') {
    if (!deps.shareMaterial) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
    return deps.shareMaterial(command.request);
  }
  if (command.action === 'job_finalize') {
    return deps.serviceRpc('service_accept_library_result', {
      p_team: command.request.teamId,
      p_attempt: command.request.attemptId,
      p_actor: deps.actorId,
      p_agent_instance: command.request.agentInstanceId,
      p_lease_token: command.request.leaseToken,
      p_result_material: command.request.resultMaterialId,
      p_source_version: command.request.sourceVersion
    });
  }
  if (command.action === 'batch_get') {
    return deps.callerRpc('get_upload_batch', {
      p_team: command.teamId,
      p_batch: command.batchId
    });
  }
  if (command.action === 'batch_item_finalize') {
    const result = await deps.serviceRpc('service_finalize_upload_batch_item', {
      p_team: command.teamId,
      p_actor: deps.actorId,
      p_batch: command.batchId,
      p_client_item_key: command.clientItemKey,
      p_material: command.materialId
    });
    const finalized = isRecord(result) ? result : null;
    const sourceVersion = finalized?.sourceVersion;
    if (typeof sourceVersion !== 'string' || sourceVersion.length < 1) {
      throw new TeamFunctionError('INVALID_RESPONSE');
    }
    await deps.serviceRpc('service_enqueue_material_enrichments', {
      p_team: command.teamId,
      p_material: command.materialId,
      p_source_version: sourceVersion
    });
    return result;
  }
  if (command.action === 'batch_item_fail') {
    return deps.serviceRpc('service_fail_upload_batch_item', {
      p_team: command.teamId,
      p_actor: deps.actorId,
      p_batch: command.batchId,
      p_client_item_key: command.clientItemKey,
      p_error_code: command.errorCode
    });
  }

  const placement = deps.ensurePlacement ? await deps.ensurePlacement(command.request) : null;
  const batch = await deps.callerRpc('create_upload_batch', {
    p_team: command.request.teamId,
    p_stage: command.request.stage,
    p_offer: command.request.offer,
    p_geo: command.request.geo,
    p_language_mode: command.request.languageMode,
    p_language: command.request.language,
    p_type_hint: command.request.typeHint ?? null,
    p_items: command.request.items
  });
  const batchId = batchIdFromRpc(batch);
  if (!deps.startItem) {
    const row = Array.isArray(batch) ? batch[0] : batch;
    return {
      ...(isRecord(row) ? row : { batchId }),
      batchId,
      destinationFolderId: placement?.destinationFolderId ?? null
    };
  }
  const coordinator = createBatchUploadCoordinator({
    concurrency: 4,
    upload: async item => {
      const session = await deps.startItem({
        batchId,
        destinationFolderId: placement?.destinationFolderId ?? null,
        item
      });
      const row = isRecord(session) ? session : null;
      const materialId = typeof row?.materialId === 'string' ? row.materialId : null;
      if (!materialId) throw new TeamFunctionError('INVALID_RESPONSE');
      return { materialId };
    }
  });
  const started = await coordinator.run(command.request.items);
  return { batchId, ...started };
}

function batchIdFromRpc(value: unknown): string {
  const row = Array.isArray(value) ? value[0] : value;
  if (!isRecord(row)) throw new TeamFunctionError('INVALID_RESPONSE');
  const batchId = row.batch_id ?? row.batchId ?? row.id;
  if (typeof batchId !== 'string') throw new TeamFunctionError('INVALID_RESPONSE');
  return batchId;
}
