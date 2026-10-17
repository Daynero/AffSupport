import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isLaunchUuid } from '../../../packages/shared/dist/team/launches.js';
import type { GoogleDriveClient } from '../_shared/drive.ts';

/** Service-issued plan, never accepted from a browser or inferred from a filename. */
export interface LaunchCleanupOutput {
  intentId: string;
  fileId: string;
  parentId: string;
  credentialId: string;
}
export type LaunchCleanupAuthority = 'owned_unpublished' | 'retained' | 'unknown';
export interface LaunchCleanupDeps {
  driveFor(
    credentialId: string
  ): Promise<Pick<GoogleDriveClient, 'getFile' | 'updateFileMetadata'>>;
  /** Rechecks the durable fence, exact intent, and all known material/catalog consumers. */
  authorize(output: LaunchCleanupOutput): Promise<LaunchCleanupAuthority>;
  /** Fenced checkpoint after provider confirmation; failure leaves recovery pending. */
  cleaned(output: LaunchCleanupOutput): Promise<void>;
}
export interface LaunchCleanupSummary {
  cleaned: number;
  retained: number;
  pending: number;
}

export interface LaunchPermissionCleanupOutput {
  fileId: string;
  permissionId: string;
  credentialId: string;
}
export interface LaunchPermissionCleanupDeps {
  driveFor(
    credentialId: string
  ): Promise<Pick<GoogleDriveClient, 'listAnyonePermissions' | 'deletePermission'>>;
  /** Rechecks the exact grant, lease and known consumers before the delete. */
  authorize(output: LaunchPermissionCleanupOutput): Promise<LaunchCleanupAuthority>;
  cleaned(output: LaunchPermissionCleanupOutput): Promise<void>;
  retained(output: LaunchPermissionCleanupOutput): Promise<void>;
}

/** Lost DELETE replies are reconciled by re-reading the exact permission ID. */
export async function cleanupLaunchPermissions(
  deps: LaunchPermissionCleanupDeps,
  outputs: readonly LaunchPermissionCleanupOutput[],
  limit = 10
): Promise<LaunchCleanupSummary> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_INPUT');
  const summary: LaunchCleanupSummary = { cleaned: 0, retained: 0, pending: 0 };
  for (const output of outputs.slice(0, limit)) {
    try {
      const authority = await deps.authorize(output);
      if (authority === 'retained') {
        await deps.retained(output);
        summary.retained++;
        continue;
      }
      if (authority !== 'owned_unpublished') {
        summary.pending++;
        continue;
      }
      const drive = await deps.driveFor(output.credentialId);
      const before = await drive.listAnyonePermissions(output.fileId);
      const exact = before.find(permission => permission.id === output.permissionId);
      if (exact && exact.role !== 'reader') {
        summary.pending++;
        continue;
      }
      const latest = await deps.authorize(output);
      if (latest === 'retained') {
        await deps.retained(output);
        summary.retained++;
        continue;
      }
      if (latest !== 'owned_unpublished') {
        summary.pending++;
        continue;
      }
      if (exact) {
        try {
          await drive.deletePermission(output.fileId, output.permissionId);
        } catch {
          // A lost reply is not proof of failure or success. Read the exact ID below.
        }
      }
      const after = await drive.listAnyonePermissions(output.fileId);
      if (after.some(permission => permission.id === output.permissionId)) {
        summary.pending++;
        continue;
      }
      await deps.cleaned(output);
      summary.cleaned++;
    } catch {
      summary.pending++;
    }
  }
  summary.pending += Math.max(0, outputs.length - limit);
  return summary;
}

/** A separate lease for an unregistered native video; catalog cleanup never owns it. */
export async function runLaunchVideoCleanupTick(
  service: ServiceRpcClient,
  driveFor: (
    credentialId: string
  ) => Promise<
    Pick<GoogleDriveClient, 'findLaunchRestitchFiles' | 'getFile' | 'updateFileMetadata'>
  >
): Promise<{ completed: number; pending: number }> {
  const owner = crypto.randomUUID();
  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await service.rpc(name, args);
    if (error) throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN', { retryable: true });
    return data;
  };
  const plans = await rpc('service_claim_launch_video_cleanup', { p_owner: owner, p_limit: 3 });
  if (!Array.isArray(plans) || plans.length > 3) throw new TeamFunctionError('INVALID_RESPONSE');
  const summary = { completed: 0, pending: 0 };
  for (const plan of plans) {
    if (
      !isRecord(plan) ||
      !isLaunchUuid(plan.teamId) ||
      !isLaunchUuid(plan.generationId) ||
      !isLaunchUuid(plan.operationId) ||
      !isLaunchUuid(plan.credentialId) ||
      typeof plan.parentId !== 'string' ||
      plan.parentId.length < 1 ||
      plan.parentId.length > 200 ||
      /\p{Cc}/u.test(plan.parentId) ||
      typeof plan.fence !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(plan.fence)
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const authority = {
      p_team: plan.teamId,
      p_generation: plan.generationId,
      p_operation: plan.operationId,
      p_owner: owner,
      p_fence: plan.fence
    };
    let cleaned = false;
    try {
      const drive = await driveFor(plan.credentialId);
      const files = await drive.findLaunchRestitchFiles({
        operationId: plan.operationId,
        parentId: plan.parentId
      });
      if (files.length === 1) {
        const file = files[0];
        if (
          file.id.length > 0 &&
          file.id.length <= 200 &&
          file.mimeType.startsWith('video/') &&
          file.parents.includes(plan.parentId) &&
          file.appProperties['soty.launch.restitch.operation'] === plan.operationId &&
          (file.trashed || file.capabilities.canTrash) &&
          (file.driveId !== null || file.ownedByMe === true)
        ) {
          if (file.driveId !== null) {
            const parent = await drive.getFile(plan.parentId);
            if (
              parent.id !== plan.parentId ||
              parent.driveId !== file.driveId ||
              parent.trashed ||
              parent.mimeType !== 'application/vnd.google-apps.folder'
            )
              throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
          }
          const allowed = await rpc('service_authorize_launch_video_cleanup', {
            ...authority,
            p_file: file.id
          });
          if (allowed === 'owned_unpublished') {
            if (!file.trashed) {
              // A second authority read narrows the window between provider proof and effect.
              const latest = await rpc('service_authorize_launch_video_cleanup', {
                ...authority,
                p_file: file.id
              });
              if (latest !== 'owned_unpublished')
                throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
              const result = await drive.updateFileMetadata({ fileId: file.id, trashed: true });
              if (
                result.id !== file.id ||
                !result.trashed ||
                result.appProperties['soty.launch.restitch.operation'] !== plan.operationId
              )
                throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
            }
            const outcome = await rpc('service_finish_launch_video_cleanup', {
              ...authority,
              p_cleaned_file: file.id
            });
            cleaned = outcome === 'cleaned';
          }
        }
      }
    } catch {
      // Lost Drive replies and incomplete searches keep the durable lease pending.
    }
    if (!cleaned) {
      try {
        await rpc('service_finish_launch_video_cleanup', {
          ...authority,
          p_cleaned_file: null
        });
      } catch {
        // The claim expires; the next tick retries with the same marked operation.
      }
    }
    if (cleaned) summary.completed++;
    else summary.pending++;
  }
  return summary;
}

/**
 * Only trashes proven owned, unpublished output. It neither deletes historical
 * materials nor guesses whether a failed provider lookup means a file is gone.
 * Permissions and registered materials require their own service-issued plan.
 */
export async function cleanupLaunchOutputs(
  deps: LaunchCleanupDeps,
  outputs: readonly LaunchCleanupOutput[],
  limit = 3
): Promise<LaunchCleanupSummary> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_INPUT');
  const summary: LaunchCleanupSummary = { cleaned: 0, retained: 0, pending: 0 };
  for (const output of outputs.slice(0, limit)) {
    try {
      const authority = await deps.authorize(output);
      if (authority === 'retained') {
        summary.retained++;
        continue;
      }
      if (authority !== 'owned_unpublished') {
        summary.pending++;
        continue;
      }
      const drive = await deps.driveFor(output.credentialId);
      const file = await drive.getFile(output.fileId);
      if (
        file.id !== output.fileId ||
        file.mimeType !== 'application/vnd.google-apps.spreadsheet' ||
        file.appProperties['soty.catalog.intent'] !== output.intentId ||
        !file.parents.includes(output.parentId)
      ) {
        summary.pending++;
        continue;
      }
      if (file.driveId === null) {
        if (file.ownedByMe !== true) {
          summary.pending++;
          continue;
        }
      } else {
        const parent = await drive.getFile(output.parentId);
        if (
          parent.id !== output.parentId ||
          parent.driveId !== file.driveId ||
          parent.trashed ||
          parent.mimeType !== 'application/vnd.google-apps.folder' ||
          (!file.trashed && !file.capabilities.canTrash)
        ) {
          summary.pending++;
          continue;
        }
      }
      // Cancellation and publication can race provider reads. Verify authority again
      // immediately before the effect; service fences must prevent future publication.
      const current = await deps.authorize(output);
      if (current === 'retained') {
        summary.retained++;
        continue;
      }
      if (current !== 'owned_unpublished') {
        summary.pending++;
        continue;
      }
      if (!file.trashed) {
        if (!file.capabilities.canTrash) {
          summary.pending++;
          continue;
        }
        const result = await drive.updateFileMetadata({ fileId: output.fileId, trashed: true });
        if (
          result.id !== output.fileId ||
          !result.trashed ||
          result.appProperties['soty.catalog.intent'] !== output.intentId
        ) {
          summary.pending++;
          continue;
        }
      }
      await deps.cleaned(output);
      summary.cleaned++;
    } catch {
      // Provider bodies, URLs, and credentials never become diagnostics/logs.
      // This includes lost replies: retry only through the same durable plan.
      summary.pending++;
    }
  }
  summary.pending += Math.max(0, outputs.length - limit);
  return summary;
}

/** Hosted worker only. Claims contain opaque resource IDs, never config or URLs. */
export async function runLaunchCleanupTick(
  service: ServiceRpcClient,
  driveFor: LaunchCleanupDeps['driveFor'] & LaunchPermissionCleanupDeps['driveFor']
): Promise<{ completed: number; pending: number }> {
  const owner = crypto.randomUUID();
  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await service.rpc(name, args);
    if (error) throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN', { retryable: true });
    return data;
  };
  const plans = await rpc('service_claim_launch_cleanup', { p_owner: owner, p_limit: 1 });
  if (!Array.isArray(plans) || plans.length > 1) throw new TeamFunctionError('INVALID_RESPONSE');
  const summary = { completed: 0, pending: 0 };
  for (const plan of plans) {
    if (
      !isRecord(plan) ||
      !isLaunchUuid(plan.teamId) ||
      !isLaunchUuid(plan.generationId) ||
      typeof plan.fence !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(plan.fence) ||
      typeof plan.intentFence !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(plan.intentFence) ||
      !Array.isArray(plan.outputs) ||
      plan.outputs.length > 1
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const outputs: LaunchCleanupOutput[] = [];
    for (const item of plan.outputs) {
      if (
        !isRecord(item) ||
        !isLaunchUuid(item.intentId) ||
        typeof item.fileId !== 'string' ||
        typeof item.parentId !== 'string' ||
        !isLaunchUuid(item.credentialId) ||
        (typeof item.fileId === 'string' &&
          (item.fileId.length < 1 || item.fileId.length > 200 || /\p{Cc}/u.test(item.fileId))) ||
        (typeof item.parentId === 'string' &&
          (item.parentId.length < 1 || item.parentId.length > 200 || /\p{Cc}/u.test(item.parentId)))
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      outputs.push({
        intentId: item.intentId,
        fileId: item.fileId,
        parentId: item.parentId,
        credentialId: item.credentialId
      });
    }
    const authority = {
      p_team: plan.teamId,
      p_generation: plan.generationId,
      p_owner: owner,
      p_fence: plan.fence,
      p_intent_fence: plan.intentFence
    };
    let outcome: string | null = null;
    const finish = async (fileId: string | null) => {
      const state = await rpc('service_finish_launch_cleanup', {
        ...authority,
        p_cleaned_file: fileId
      });
      if (state !== 'canceled' && state !== 'canceled_with_cleanup_pending')
        throw new TeamFunctionError('INVALID_RESPONSE');
      outcome = state;
    };
    try {
      if (outputs.length === 0) {
        const rawPermissions = await rpc('service_list_launch_cleanup_permissions', authority);
        if (!Array.isArray(rawPermissions) || rawPermissions.length > 1)
          throw new TeamFunctionError('INVALID_RESPONSE');
        const permissions: LaunchPermissionCleanupOutput[] = rawPermissions.map(item => {
          if (
            !isRecord(item) ||
            typeof item.fileId !== 'string' ||
            item.fileId.length < 1 ||
            item.fileId.length > 200 ||
            /\p{Cc}/u.test(item.fileId) ||
            typeof item.permissionId !== 'string' ||
            item.permissionId.length < 1 ||
            item.permissionId.length > 200 ||
            /\p{Cc}/u.test(item.permissionId) ||
            !isLaunchUuid(item.credentialId)
          )
            throw new TeamFunctionError('INVALID_RESPONSE');
          return {
            fileId: item.fileId,
            permissionId: item.permissionId,
            credentialId: item.credentialId
          };
        });
        await cleanupLaunchPermissions(
          {
            driveFor,
            authorize: async permission => {
              const state = await rpc('service_authorize_launch_permission_cleanup', {
                ...authority,
                p_file: permission.fileId,
                p_credential: permission.credentialId,
                p_permission: permission.permissionId
              });
              return state === 'owned_unpublished' || state === 'retained' ? state : 'unknown';
            },
            cleaned: async permission => {
              await rpc('service_mark_launch_permission_cleaned', {
                ...authority,
                p_file: permission.fileId,
                p_credential: permission.credentialId,
                p_permission: permission.permissionId
              });
            },
            retained: async permission => {
              await rpc('service_mark_launch_permission_retained', {
                ...authority,
                p_file: permission.fileId,
                p_credential: permission.credentialId,
                p_permission: permission.permissionId
              });
            }
          },
          permissions
        );
      }
      await cleanupLaunchOutputs(
        {
          driveFor,
          authorize: async output => {
            const state = await rpc('service_authorize_launch_cleanup', {
              ...authority,
              p_file: output.fileId
            });
            return state === 'owned_unpublished' || state === 'retained' ? state : 'unknown';
          },
          cleaned: output => finish(output.fileId)
        },
        outputs,
        1
      );
      if (outcome === null) await finish(null);
      if (outcome === 'canceled') summary.completed++;
      else summary.pending++;
    } catch {
      // The durable claim expires; later ticks retry the exact cleanup plan.
      summary.pending++;
    }
  }
  return summary;
}

export async function runLaunchCatalogRecovery(
  service: ServiceRpcClient,
  execute: (teamId: string, generationId: string, actorId: string) => Promise<unknown>
): Promise<{ completed: number; pending: number }> {
  const authority = await service.rpc('service_settle_launch_authority_losses', { p_limit: 3 });
  if (
    authority.error ||
    typeof authority.data !== 'number' ||
    !Number.isInteger(authority.data) ||
    authority.data < 0 ||
    authority.data > 3
  )
    throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN', { retryable: true });
  const { data, error } = await service.rpc('service_list_launch_catalog_recovery', { p_limit: 3 });
  if (error) throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN', { retryable: true });
  if (!Array.isArray(data) || data.length > 3) throw new TeamFunctionError('INVALID_RESPONSE');
  const result = { completed: 0, pending: 0 };
  for (const item of data) {
    if (
      !isRecord(item) ||
      !isLaunchUuid(item.teamId) ||
      !isLaunchUuid(item.generationId) ||
      !isLaunchUuid(item.actorId)
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    try {
      const outcome = await execute(item.teamId, item.generationId, item.actorId);
      if (isRecord(outcome) && outcome.state === 'succeeded') result.completed++;
      else result.pending++;
    } catch {
      result.pending++;
    }
  }
  return result;
}
