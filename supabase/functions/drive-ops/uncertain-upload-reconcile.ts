import type { ServiceRpcClient } from '../_shared/credentials.ts';
import {
  proveLiveAncestry,
  type DriveFileMetadata,
  type GoogleDriveClient
} from '../_shared/drive.ts';
import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import { classifyMaterial } from '../../../packages/shared/dist/team/material-category.js';
import { verifyOwnedProcessUploadResult } from './process-output-upload.ts';
import { recordRestitchOutput } from './updater-restitch.ts';

/**
 * A catalog variant whose output upload ended without a confirmed result (beta
 * 2026-11-11: the gateway went away mid-upload). The ownership row holds the
 * Drive id generated before the provider call, so the outcome is a lookup, not
 * a guess:
 *  - the file is there and is exactly the bound output → finalize it as the
 *    variant's output (the same SQL the agent's finalize commits through);
 *  - the destination is readable and the generated id does not exist → the
 *    upload never landed: failed with 'not_created', variant requeued;
 *  - something else sits under that id (wrong size, checksum, place, nonce or
 *    trashed) → failed with 'attention', the file left untouched, requeued;
 *  - Drive cannot tell yet → asked again later (SQL backs off and gives up as
 *    'attention' after eight checks).
 * Only the SQL claim decides eligibility (2 minutes of executor silence, or the
 * agent's own word that its uploader quiesced), revokes the agent's finalize
 * grant and holds a fenced lease, so this never races the executor's writes.
 */
export type ReconcileDrive = Pick<
  GoogleDriveClient,
  'getFile' | 'probeProcessOutput' | 'listAnyonePermissions' | 'createAnyoneReaderPermission'
>;
interface Plan {
  operationId: string;
  actorId: string;
  credentialId: string;
  rootId: string;
  parentId: string;
  fileId: string;
  fence: string;
  binding: Record<string, unknown>;
}
const SAFE_CODES = new Set([
  'PROCESS_RESULT_UNCERTAIN',
  'SOURCE_CHANGED',
  'NEEDS_REAUTH',
  'PERMISSION_DENIED',
  'DRIVE_UNAVAILABLE',
  'RATE_LIMITED',
  'INVALID_RESPONSE'
]);

function parsePlan(value: unknown): Plan {
  if (
    !isRecord(value) ||
    !['operationId', 'actorId', 'credentialId', 'rootId', 'parentId', 'fileId'].every(
      key => typeof value[key] === 'string' && String(value[key]).length > 0
    ) ||
    value.state !== 'started' ||
    typeof value.fence !== 'string' ||
    !/^[1-9]\d{0,18}$/u.test(value.fence)
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    operationId: value.operationId as string,
    actorId: value.actorId as string,
    credentialId: value.credentialId as string,
    rootId: value.rootId as string,
    parentId: value.parentId as string,
    fileId: value.fileId as string,
    fence: value.fence,
    binding: value
  };
}

function extensionOf(name: string): string | null {
  const leaf = name.split('/').at(-1) ?? name;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1).toLocaleLowerCase('en-US') : null;
}
/** The same Drive facts the agent's finalize records for an uploaded output. */
export function reconciledDriveResult(metadata: DriveFileMetadata) {
  const classification = classifyMaterial({
    kind: 'file',
    mimeType: metadata.mimeType,
    fileExtension: extensionOf(metadata.name),
    sourceVersion: metadata.version
  });
  return {
    driveFileId: metadata.id,
    driveId: metadata.driveId,
    resourceKey: metadata.resourceKey,
    parentFolderId: metadata.parents[0] ?? null,
    name: metadata.name,
    mimeType: metadata.mimeType,
    fileExtension: classification.normalizedExtension,
    kind: 'file',
    category: classification.category,
    classificationSource: classification.source,
    sizeBytes: metadata.size,
    modifiedAt: metadata.modifiedAt,
    driveVersion: metadata.version,
    checksum: metadata.checksum
  };
}

export type ReconcileOutcome = 'registered' | 'not_created' | 'attention' | 'waiting';

/** Reconciles up to `limit` due uploads (or exactly `operationId`). */
export async function reconcileUncertainProcessUploads(
  service: ServiceRpcClient,
  driveFor: (credentialId: string) => Promise<ReconcileDrive>,
  options: { owner?: string; operationId?: string; limit?: number; signal?: AbortSignal } = {}
): Promise<ReconcileOutcome[]> {
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    signal.throwIfAborted();
    const { data, error } = await service.rpc(name, args);
    if (error) {
      const code = typeof error.message === 'string' ? error.message : '';
      throw new TeamFunctionError(
        ['WRONG_STATE', 'INVALID_INPUT', 'NOT_FOUND'].includes(code)
          ? (code as 'WRONG_STATE')
          : 'DRIVE_UNAVAILABLE',
        { retryable: true }
      );
    }
    return data;
  };
  const owner = options.owner ?? crypto.randomUUID();
  const plans = await rpc('service_claim_uncertain_process_uploads', {
    p_owner: owner,
    p_limit: Math.min(3, Math.max(1, options.limit ?? 1)),
    p_operation: options.operationId ?? null
  });
  if (!Array.isArray(plans)) throw new TeamFunctionError('INVALID_RESPONSE');
  const outcomes: ReconcileOutcome[] = [];
  for (const raw of plans) {
    const plan = parsePlan(raw);
    const settle = async (result: string, code: string | null = null) =>
      (await rpc('service_settle_uncertain_process_upload', {
        p_operation: plan.operationId,
        p_owner: owner,
        p_fence: plan.fence,
        p_result: result,
        p_code: code !== null && SAFE_CODES.has(code) ? code : null
      })) as ReconcileOutcome;
    try {
      const drive = await driveFor(plan.credentialId);
      // Absence is believed only while the destination itself is visible:
      // Drive also answers 404 for a file the account cannot see.
      await proveLiveAncestry({ client: drive, fileId: plan.parentId, rootFolderId: plan.rootId });
      if ((await drive.probeProcessOutput(plan.fileId, signal)) === 'absent') {
        outcomes.push(await settle('absent'));
        continue;
      }
      let file: DriveFileMetadata;
      try {
        file = await proveLiveAncestry({
          client: drive,
          fileId: plan.fileId,
          rootFolderId: plan.rootId,
          allowTrashedTarget: true
        });
      } catch (cause) {
        // The id exists but no longer lies under the space root.
        if (['NOT_FOUND', 'SOURCE_CHANGED'].includes(mapUnknownError(cause).code)) {
          outcomes.push(await settle('mismatch', 'SOURCE_CHANGED'));
          continue;
        }
        throw cause;
      }
      // A file still being processed by Drive has no size or checksum yet.
      if (file.size === null || file.checksum === null) {
        outcomes.push(await settle('unknown', 'PROCESS_RESULT_UNCERTAIN'));
        continue;
      }
      try {
        verifyOwnedProcessUploadResult(plan.binding, file, plan.operationId);
      } catch {
        outcomes.push(await settle('mismatch', 'SOURCE_CHANGED'));
        continue;
      }
      const committed = await rpc('service_finalize_uploaded_material', {
        p_operation: plan.operationId,
        p_actor: plan.actorId,
        p_drive: reconciledDriveResult(file)
      });
      if (!isRecord(committed) || typeof committed.materialId !== 'string')
        throw new TeamFunctionError('INVALID_RESPONSE');
      // As the agent's finalize does: share the copy and record it. Best effort;
      // the output is committed either way and an unrecorded copy is prepared again.
      await recordRestitchOutput(
        {
          drive,
          rpc: (name, parameters) => rpc(name, parameters),
          log: (message, detail) => console.error(message, detail)
        },
        { operationId: plan.operationId, materialId: committed.materialId, driveFileId: file.id }
      ).catch(error => {
        console.error('[reconcile] restitch copy not recorded', mapUnknownError(error).code);
      });
      outcomes.push(await settle('registered'));
    } catch (cause) {
      const code = mapUnknownError(cause).code;
      outcomes.push(
        await settle('unknown', SAFE_CODES.has(code) ? code : 'PROCESS_RESULT_UNCERTAIN').catch(
          () => 'waiting' as const
        )
      );
    }
  }
  return outcomes;
}
