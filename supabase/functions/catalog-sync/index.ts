import { createClient } from 'npm:@supabase/supabase-js@2';
import { TRANSCRIPT_INDEX_MAX_BYTES } from '../../../packages/shared/dist/team/contract.js';
import { classifyMaterial } from '../../../packages/shared/dist/team/material-category.js';
import { ingestTranscript } from '../../../packages/shared/dist/team/transcript.js';
import { requireDriveOAuthGate, requireNamedWorkerSecret } from '../_shared/auth.ts';
import {
  readDriveCredential,
  refreshGoogleAccessToken,
  type ServiceRpcClient
} from '../_shared/credentials.ts';
import { GoogleDriveClient, proveLiveAncestry, type DriveFileMetadata } from '../_shared/drive.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  catalogRetryDelayMs,
  runCatalogSyncSlice,
  type CatalogSyncDependencies,
  type CatalogSyncJob
} from './engine.ts';

interface RpcFailure {
  code?: string;
  message?: string;
}

interface RpcClient extends ServiceRpcClient {
  rpc: (
    name: string,
    parameters: Record<string, unknown>
  ) => Promise<{ data: unknown; error: RpcFailure | null }>;
}

function serviceClient(): RpcClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) as unknown as RpcClient;
}

async function rpcValue(
  client: RpcClient,
  name: string,
  parameters: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  return data;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function fileExtension(name: string): string | null {
  const index = name.lastIndexOf('.');
  return index > 0 && index < name.length - 1 ? name.slice(index + 1) : null;
}

function catalogRow(file: DriveFileMetadata) {
  const kind = file.shortcutTargetId
    ? ('shortcut' as const)
    : file.mimeType === 'application/vnd.google-apps.folder'
      ? ('folder' as const)
      : ('file' as const);
  const extension = fileExtension(file.name);
  const classification = classifyMaterial({
    kind,
    mimeType: file.mimeType,
    fileExtension: extension,
    sourceVersion: file.version
  });
  return {
    drive_file_id: file.id,
    drive_id: file.driveId,
    resource_key: file.resourceKey,
    parent_folder_id: file.parents[0] ?? null,
    name: file.name,
    mime_type: classification.normalizedMimeType ?? file.mimeType,
    file_extension: classification.normalizedExtension,
    kind,
    shortcut_target_id: file.shortcutTargetId,
    shortcut_target_resource_key: file.shortcutTargetResourceKey,
    category: classification.category,
    classification_version: classification.version,
    classification_source: classification.source,
    size_bytes: file.size,
    modified_at: file.modifiedAt,
    drive_version: file.version,
    checksum: file.checksum
  };
}

async function ingestPendingTranscripts(input: {
  service: RpcClient;
  drive: GoogleDriveClient;
  connectionId: string;
  files: DriveFileMetadata[];
}): Promise<void> {
  if (input.files.length === 0) return;
  await rpcValue(input.service, 'service_requeue_catalog_transcripts', {
    p_connection: input.connectionId,
    p_files: input.files.map(file => ({
      drive_file_id: file.id,
      drive_version: file.version,
      checksum: file.checksum,
      mime_type: file.mimeType,
      file_extension: fileExtension(file.name)
    }))
  });
  const targets = rows(
    await rpcValue(input.service, 'service_list_pending_catalog_transcripts', {
      p_connection: input.connectionId,
      p_file_ids: input.files.map(file => file.id)
    })
  );
  const files = new Map(input.files.map(file => [file.id, file]));
  for (const target of targets) {
    const materialId = requiredString(target, 'material_id');
    const driveFileId = requiredString(target, 'drive_file_id');
    const file = files.get(driveFileId);
    if (!file) continue;
    let state: 'full' | 'truncated' | 'invalid_encoding' | 'unavailable';
    let text: string | null = null;
    let indexedBytes = 0;
    let errorCode: string | null;
    let deferredError: TeamFunctionError | null = null;
    try {
      const body = await input.drive.downloadFileRange({
        fileId: driveFileId,
        resourceKey: optionalString(target.resource_key),
        maximumBytes: TRANSCRIPT_INDEX_MAX_BYTES + 4
      });
      const ingested = ingestTranscript(body.bytes, {
        extension: optionalString(target.file_extension),
        totalBytes: body.totalBytes
      });
      state = ingested.state === 'not_applicable' ? 'unavailable' : ingested.state;
      text = ingested.text;
      indexedBytes = ingested.indexedBytes;
      errorCode = ingested.errorCode;
    } catch (cause) {
      deferredError = mapUnknownError(cause);
      state = 'unavailable';
      errorCode = deferredError.code;
    }
    await rpcValue(input.service, 'service_commit_catalog_transcript', {
      p_material: materialId,
      p_expected_version: optionalString(target.drive_version),
      p_expected_checksum: optionalString(target.checksum),
      p_expected_mime_type: optionalString(target.mime_type),
      p_expected_extension: optionalString(target.file_extension),
      p_state: state,
      p_text: text,
      p_indexed_bytes: indexedBytes,
      p_error_code: errorCode
    });
    if (deferredError?.retryable) throw deferredError;
  }
}

function catalogJob(row: Record<string, unknown>): CatalogSyncJob {
  const cursor = isRecord(row.cursor) ? row.cursor : {};
  const phase = row.phase;
  if (!['initial_scan', 'change_replay', 'incremental', 'reconcile'].includes(String(phase))) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return {
    jobId: requiredString(row, 'job_id'),
    connectionId: requiredString(row, 'connection_id'),
    phase: phase as CatalogSyncJob['phase'],
    rootFolderId: requiredString(row, 'root_folder_id'),
    driveId: optionalString(row.drive_id),
    folderQueue: stringArray(row.folder_queue),
    pageToken: optionalString(cursor.pageToken),
    changeToken: optionalString(cursor.changePageToken),
    attempts: typeof row.attempts === 'number' ? row.attempts : 1,
    discoveredFolderIds: stringArray(cursor.discoveredFolders)
  };
}

async function isHiddenSystemFile(
  drive: GoogleDriveClient,
  file: DriveFileMetadata,
  rootFolderId: string
): Promise<boolean> {
  if (file.name === '.soty') return true;
  let frontier = [...file.parents];
  const visited = new Set<string>();
  for (let depth = 0; depth < 100 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      if (parentId === rootFolderId || visited.has(parentId)) continue;
      visited.add(parentId);
      const parent = await drive.getFile(parentId);
      if (parent.name === '.soty') return true;
      next.push(...parent.parents);
    }
    frontier = next;
  }
  return false;
}

function dependencies(input: {
  service: RpcClient;
  drive: GoogleDriveClient;
  worker: string;
  job: CatalogSyncJob;
}): CatalogSyncDependencies {
  const { service, drive, worker, job } = input;
  return {
    listChildren: request => drive.listChildren(request),
    listChanges: request => drive.listChanges(request),
    getFile: fileId => drive.getFile(fileId),
    isWithinRoot: async file => {
      try {
        await proveLiveAncestry({
          client: drive,
          fileId: file.id,
          rootFolderId: job.rootFolderId,
          resourceKey: file.resourceKey
        });
        return true;
      } catch (cause) {
        const error = mapUnknownError(cause);
        if (
          ['ROOT_ESCAPE', 'NOT_FOUND', 'PERMISSION_DENIED', 'INVALID_RESPONSE'].includes(error.code)
        ) {
          return false;
        }
        throw error;
      }
    },
    isHiddenSystemFile: async (file, rootFolderId) => {
      try {
        return await isHiddenSystemFile(drive, file, rootFolderId);
      } catch (cause) {
        const error = mapUnknownError(cause);
        // An incomplete ancestor response is not sufficient to prove an asset
        // belongs in the visible catalog.  Mark it unavailable for this slice;
        // a later valid change can restore it.
        if (error.code === 'INVALID_RESPONSE') return true;
        throw error;
      }
    },
    invalidateLandingRenders: async request => {
      if (request.fileIds.length === 0) return;
      const invalidated = rows(
        await rpcValue(service, 'service_invalidate_landing_renders', {
          p_connection: request.connectionId,
          p_drive_file_ids: request.fileIds
        })
      );
      const artifactRoots = [
        ...new Set(
          invalidated
            .map(row => optionalString(row.artifact_root))
            .filter((root): root is string => root !== null)
        )
      ];
      for (const artifactRoot of artifactRoots) {
        await drive.updateFileMetadata({ fileId: artifactRoot, trashed: true });
      }
    },
    upsertFiles: request =>
      rpcValue(service, 'service_upsert_catalog_page', {
        p_connection: request.connectionId,
        p_parent_folder_id: request.parentId,
        p_files: request.files.map(catalogRow)
      }),
    tombstoneFiles: request =>
      rpcValue(service, 'service_tombstone_catalog_files', {
        p_connection: request.connectionId,
        p_items: request.items.map(item => ({
          file_id: item.fileId,
          lifecycle: item.lifecycle
        }))
      }),
    requeueTranscripts: request =>
      ingestPendingTranscripts({
        service,
        drive,
        connectionId: request.connectionId,
        files: request.files
      }),
    checkpoint: request =>
      rpcValue(service, 'service_checkpoint_catalog_sync_job', {
        p_job: request.jobId,
        p_worker: worker,
        p_phase: request.phase,
        p_page_token: request.pageToken,
        p_change_token: request.changeToken,
        p_folder_queue: request.folderQueue,
        p_discovered_folders: request.discoveredFolderIds
      }),
    complete: request =>
      rpcValue(service, 'service_complete_catalog_sync_job', {
        p_job: request.jobId,
        p_worker: worker,
        p_change_token: request.changeToken,
        p_next_phase: request.nextPhase
      }),
    reconcile: request =>
      rpcValue(service, 'service_enqueue_catalog_reconciliation', {
        p_connection: request.connectionId
      })
  };
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(new TeamFunctionError('INVALID_INPUT', { retryable: false }));
  }
  try {
    await requireNamedWorkerSecret(request);
    requireDriveOAuthGate(
      { siteUrl: Deno.env.get('WISHLY_SITE_URL') },
      Deno.env.get('DRIVE_OAUTH_MODE')
    );
    const service = serviceClient();
    const worker = `catalog-${crypto.randomUUID()}`;
    const claimed = rows(
      await rpcValue(service, 'service_claim_catalog_sync_jobs', {
        p_worker: worker,
        // One bounded Drive page can require several provider reads.  Keep a
        // scheduler invocation to one job so its lease can finish inside the
        // worker request budget instead of leaving a batch half-leased.
        p_limit: 1,
        p_lease_seconds: 60
      })
    );
    let completed = 0;
    let processed = 0;
    let failed = 0;

    for (const row of claimed) {
      const job = catalogJob(row);
      try {
        const credentialId = requiredString(row, 'credential_id');
        const credential = await readDriveCredential(service, credentialId);
        const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
        const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
        if (!clientId || !clientSecret) {
          throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
        }
        const token = await refreshGoogleAccessToken({
          credential,
          clientId,
          clientSecret,
          oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
          productionSignals: { siteUrl: Deno.env.get('WISHLY_SITE_URL') }
        });
        const drive = new GoogleDriveClient(token.accessToken);
        const result = await runCatalogSyncSlice(
          job,
          dependencies({ service, drive, worker, job })
        );
        completed += 1;
        processed += result.processed;
      } catch (cause) {
        failed += 1;
        const error = mapUnknownError(cause);
        if (error.code === 'NEEDS_REAUTH') {
          await rpcValue(service, 'service_mark_drive_needs_reauth', {
            p_credential: requiredString(row, 'credential_id')
          });
        }
        await rpcValue(service, 'service_retry_catalog_sync_job', {
          p_job: job.jobId,
          p_worker: worker,
          p_error_code: error.code,
          p_next_attempt_at: new Date(Date.now() + catalogRetryDelayMs(job.attempts)).toISOString(),
          p_permanent: !error.retryable
        });
      }
    }

    return successResponse({ claimed: claimed.length, completed, processed, failed });
  } catch (error) {
    return errorResponse(mapUnknownError(error));
  }
});
