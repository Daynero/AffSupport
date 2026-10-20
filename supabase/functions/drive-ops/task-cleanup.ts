import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { GoogleDriveClient } from '../_shared/drive.ts';
import { proveLiveAncestry } from '../_shared/drive.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';

/** No browser or filename can authorize cleanup. The database owns provenance and the reference fence. */
export async function runTaskCleanupTick(
  service: ServiceRpcClient,
  driveFor: (
    credentialId: string
  ) => Promise<Pick<GoogleDriveClient, 'getFile' | 'updateFileMetadata'>>
): Promise<{ completed: number; pending: number }> {
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await service.rpc(name, args);
    if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    return data;
  };
  const plans = await rpc('service_claim_task_cleanup', { p_limit: 3 });
  if (!Array.isArray(plans) || plans.length > 3) throw new TeamFunctionError('INVALID_RESPONSE');
  const summary = { completed: 0, pending: 0 };
  for (const plan of plans) {
    if (
      !isRecord(plan) ||
      !['id', 'operationId', 'fileId', 'parentId', 'credentialId', 'rootId'].every(
        key =>
          typeof plan[key] === 'string' &&
          String(plan[key]).length > 0 &&
          String(plan[key]).length <= 1024
      )
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const id = String(plan.id);
    try {
      const drive = await driveFor(String(plan.credentialId));
      const file = await drive.getFile(String(plan.fileId));
      if (!file.trashed) {
        // A user move or changed provider topology defeats the original ownership proof.
        if (!file.parents?.includes(String(plan.parentId))) {
          await rpc('service_settle_task_cleanup', { p_id: id, p_result: 'retained' });
          continue;
        }
        await proveLiveAncestry({
          client: drive,
          fileId: file.id,
          rootFolderId: String(plan.rootId)
        });
        if ((await rpc('service_authorize_task_cleanup', { p_id: id })) !== true) {
          await rpc('service_settle_task_cleanup', { p_id: id, p_result: 'retained' });
          continue;
        }
        try {
          await drive.updateFileMetadata({ fileId: file.id, trashed: true });
        } catch {
          /* Reconcile a lost provider response below. */
        }
      }
      if (!(await drive.getFile(String(plan.fileId))).trashed) {
        await rpc('service_settle_task_cleanup', { p_id: id, p_result: 'unknown' });
        summary.pending++;
        continue;
      }
      await rpc('service_settle_task_cleanup', { p_id: id, p_result: 'trashed' });
      summary.completed++;
    } catch (cause) {
      const code = mapUnknownError(cause).code;
      const result =
        code === 'PERMISSION_DENIED'
          ? 'permission_denied'
          : code === 'DRIVE_UNAVAILABLE'
            ? 'unavailable'
            : 'unknown';
      await rpc('service_settle_task_cleanup', { p_id: id, p_result: result }).catch(
        () => undefined
      );
      summary.pending++;
    }
  }
  return summary;
}
