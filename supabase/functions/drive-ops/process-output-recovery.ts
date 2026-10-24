import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { GoogleDriveClient, ProcessOutputRecoveryFile } from '../_shared/drive.ts';
import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';

export const PROCESS_OUTPUT_NONCE_KEY = 'soty.process.output';
type RecoveryDrive = Pick<
  GoogleDriveClient,
  'getProcessOutputRecoveryFile' | 'trashProcessOutputConditionally'
>;
interface CleanupPlan {
  operationId: string;
  credentialId: string;
  fileId: string;
  parentId: string;
  rootId: string;
  nonce: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  fence: string;
}

function parsePlan(value: unknown): CleanupPlan {
  if (
    !isRecord(value) ||
    ![
      'operationId',
      'credentialId',
      'fileId',
      'parentId',
      'rootId',
      'nonce',
      'name',
      'mimeType'
    ].every(
      key =>
        typeof value[key] === 'string' &&
        String(value[key]).length > 0 &&
        String(value[key]).length <= 1024
    ) ||
    value.state !== 'started' ||
    typeof value.fence !== 'string' ||
    !/^[1-9]\d{0,18}$/u.test(value.fence) ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(value.checksum)
  ) {
    throw new TeamFunctionError('INVALID_RESPONSE');
  }
  return value as unknown as CleanupPlan;
}

function matchesOwnedOutput(file: ProcessOutputRecoveryFile, plan: CleanupPlan): boolean {
  return (
    file.id === plan.fileId &&
    file.parents.length === 1 &&
    file.parents[0] === plan.parentId &&
    file.name === plan.name &&
    file.mimeType === plan.mimeType &&
    file.appProperties[PROCESS_OUTPUT_NONCE_KEY] === plan.nonce &&
    file.size === plan.sizeBytes &&
    file.checksum === plan.checksum &&
    (file.ownedByMe || file.driveId !== null)
  );
}

/** One claim per tick, finite SQL retries, no browser and no business-finalize authority. */
export async function runProcessOutputCleanupTick(
  service: ServiceRpcClient,
  driveFor: (credentialId: string) => Promise<RecoveryDrive>,
  options: { budgetMs?: number; owner?: string } = {}
): Promise<{ completed: number; pending: number; retained: number }> {
  const budgetMs = Math.min(7000, Math.max(1, options.budgetMs ?? 7000));
  const controller = new AbortController();
  const signal = controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true }));
    }, budgetMs);
  });
  // Late claim/settle RPCs can at most change durable lease state. A late provider
  // request has the same captured ID and ETag; future ticks reconcile readback.
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, timeout]);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    signal.throwIfAborted();
    const { data, error } = await bounded(service.rpc(name, args));
    if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    return data;
  };
  const owner = options.owner ?? crypto.randomUUID();
  const summary = { completed: 0, pending: 0, retained: 0 };
  let plan: CleanupPlan | undefined;
  const settle = (result: string, code: string | null) =>
    rpc('service_settle_process_output_cleanup', {
      p_operation: plan!.operationId,
      p_owner: owner,
      p_fence: plan!.fence,
      p_result: result,
      p_code: code
    });
  const authorize = () =>
    rpc('service_authorize_process_output_cleanup', {
      p_operation: plan!.operationId,
      p_owner: owner,
      p_fence: plan!.fence
    });
  try {
    const plans = await rpc('service_claim_process_output_cleanup', { p_owner: owner, p_limit: 1 });
    if (!Array.isArray(plans) || plans.length > 1) throw new TeamFunctionError('INVALID_RESPONSE');
    if (plans.length === 0) return summary;
    plan = parsePlan(plans[0]);
    if ((await authorize()) !== true) {
      await settle('retained', 'SOURCE_CHANGED');
      summary.retained++;
      return summary;
    }
    const drive = await bounded(driveFor(plan.credentialId));
    const file = await bounded(drive.getProcessOutputRecoveryFile(plan.fileId, signal));
    // A still-unfinished upload can have no size/checksum; absence is not cleanup.
    if (file.size === null || file.checksum === null) {
      await settle('pending', 'PROCESS_RESULT_UNCERTAIN');
      summary.pending++;
      return summary;
    }
    if (!matchesOwnedOutput(file, plan)) {
      await settle('retained', 'SOURCE_CHANGED');
      summary.retained++;
      return summary;
    }
    if (!file.trashed) {
      if (!file.canTrash) throw new TeamFunctionError('PERMISSION_DENIED');
      // Follow only the captured parent chain. Never list siblings or infer
      // ownership by names; a moved/trashed ancestor defeats the scope proof.
      let parent = plan.parentId;
      const visited = new Set<string>();
      for (let depth = 0; parent !== plan.rootId && depth < 32; depth++) {
        if (visited.has(parent)) throw new TeamFunctionError('SOURCE_CHANGED');
        visited.add(parent);
        const folder = await bounded(drive.getProcessOutputRecoveryFile(parent, signal));
        if (
          folder.trashed ||
          folder.mimeType !== 'application/vnd.google-apps.folder' ||
          folder.parents.length !== 1
        ) {
          throw new TeamFunctionError('SOURCE_CHANGED');
        }
        parent = folder.parents[0]!;
      }
      if (parent !== plan.rootId) throw new TeamFunctionError('SOURCE_CHANGED');
      if ((await authorize()) !== true) throw new TeamFunctionError('SOURCE_CHANGED');
      // The reservation survives expired leases and uncertain provider replies;
      // material INSERT/identity-rebind shares this durable database fence.
      if (
        (await rpc('service_begin_process_output_trash', {
          p_operation: plan.operationId,
          p_owner: owner,
          p_fence: plan.fence
        })) !== true
      )
        throw new TeamFunctionError('SOURCE_CHANGED');
      try {
        await bounded(drive.trashProcessOutputConditionally(plan.fileId, file.etag, signal));
      } catch (cause) {
        // 412 is a proven concurrent change; never retry without its condition.
        if (mapUnknownError(cause).code === 'SOURCE_CHANGED') throw cause;
        // Other lost replies are reconciled, never counted as successful alone.
      }
    }
    const confirmed = await bounded(drive.getProcessOutputRecoveryFile(plan.fileId, signal));
    if (!confirmed.trashed || !matchesOwnedOutput(confirmed, plan)) {
      await settle('pending', 'PROCESS_RESULT_UNCERTAIN');
      summary.pending++;
      return summary;
    }
    const settled = await settle('trashed', null);
    if (settled !== 'trashed') throw new TeamFunctionError('INVALID_RESPONSE');
    summary.completed++;
    return summary;
  } catch (cause) {
    const code = mapUnknownError(cause).code;
    const retained = code === 'SOURCE_CHANGED';
    if (plan && !signal.aborted) {
      const safeCode = [
        'SOURCE_CHANGED',
        'NEEDS_REAUTH',
        'PERMISSION_DENIED',
        'DRIVE_UNAVAILABLE',
        'RATE_LIMITED',
        'INVALID_RESPONSE'
      ].includes(code)
        ? code
        : 'PROCESS_RESULT_UNCERTAIN';
      await settle(retained ? 'retained' : 'pending', safeCode).catch(() => undefined);
    }
    if (retained) summary.retained++;
    else summary.pending++;
    return summary;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
