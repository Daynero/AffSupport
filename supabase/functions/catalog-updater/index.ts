import { drawCatalogImagePool } from '../_shared/catalog-image-draw.ts';
import { runProcessOutputCleanupTick } from '../drive-ops/process-output-recovery.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { requireDriveOAuthGate, requireNamedWorkerSecret } from '../_shared/auth.ts';
import {
  readDriveCredential,
  refreshGoogleAccessToken,
  type ServiceRpcClient
} from '../_shared/credentials.ts';
import { GoogleDriveClient } from '../_shared/drive.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { classifyCatalogReadback, runCatalogUpdaterTick } from './worker.ts';
import { runTaskCleanupTick } from '../drive-ops/task-cleanup.ts';
import { runLaunchCleanupTick, runLaunchVideoCleanupTick } from '../drive-ops/launch-recovery.ts';

/**
 * The catalog updater's scheduled worker (feature 023).
 *
 * Called every ten seconds by `private.invoke_catalog_updater_worker` when an updater is due or a
 * retry is waiting. It authenticates with the catalog-sync worker secret — function secrets are
 * project-wide, and a second secret would need a manual step in production.
 */

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

const BUDGET_MS = 8_000;

function serviceClient(): RpcClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) as unknown as RpcClient;
}

async function rpcValue(client: RpcClient, name: string, parameters: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  return data;
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(new TeamFunctionError('INVALID_INPUT', { retryable: false }));
  }
  try {
    await requireNamedWorkerSecret(request);
    const service = serviceClient();
    const workerId = `catalog-updater:${crypto.randomUUID()}`;
    // Recover already completed Launch children and provider-free cancellations even
    // when there are no updater rounds and no browser is connected. Unknown provider
    // outcomes remain unsettled for the ownership-aware recovery path.
    await rpcValue(service, 'service_settle_launch_restitch_cancellations', { p_limit: 3 });
    await rpcValue(service, 'service_settle_launch_restitch_batch', { p_limit: 3 });
    const launches = await rpcValue(service, 'service_settle_launch_batch', { p_limit: 3 });

    const signals = { siteUrl: Deno.env.get('WISHLY_SITE_URL') };
    const oauthMode = Deno.env.get('DRIVE_OAUTH_MODE');
    requireDriveOAuthGate(signals, oauthMode);
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
    }

    // One access token per credential for the whole tick.
    const drives = new Map<string, Promise<GoogleDriveClient>>();
    const driveFor = (credentialId: string): Promise<GoogleDriveClient> => {
      let drive = drives.get(credentialId);
      if (!drive) {
        drive = readDriveCredential(service, credentialId)
          .then(credential =>
            refreshGoogleAccessToken({
              credential,
              clientId,
              clientSecret,
              oauthMode,
              productionSignals: signals
            })
          )
          .then(token => new GoogleDriveClient(token.accessToken));
        // A failed token is not cached: the next sheet on this credential tries again.
        drive.catch(() => drives.delete(credentialId));
        drives.set(credentialId, drive);
      }
      return drive;
    };
    // Start the bounded one-file cleanup independently of catalog work. Always
    // join it below, including catalog failure, so it survives a quiet catalog
    // without becoming unobserved work after the request has returned.
    const processCleanup = runProcessOutputCleanupTick(service, driveFor).catch(() => ({
      completed: 0,
      pending: 1,
      retained: 0,
      unavailable: true
    }));
    try {
      const pending = await rpcValue(service, 'service_claim_catalog_reconciliations', {
        p_limit: 3
      });
      for (const row of Array.isArray(pending) ? pending : []) {
        if (!row || typeof row !== 'object') continue;
        const item = row as Record<string, unknown>;
        if (
          typeof item.catalog_material_id !== 'string' ||
          typeof item.marker !== 'string' ||
          typeof item.drive_file_id !== 'string' ||
          typeof item.credential_id !== 'string'
        )
          continue;
        try {
          const drive = await driveFor(item.credential_id);
          const file = await drive.getFile(
            item.drive_file_id,
            typeof item.resource_key === 'string' ? item.resource_key : null
          );
          const outcome = classifyCatalogReadback(file, {
            fileId: item.drive_file_id,
            marker: item.marker,
            baselineVersion:
              typeof item.baseline_version === 'string' ? item.baseline_version : null
          });
          if (outcome !== 'inconclusive') {
            await rpcValue(service, 'service_resolve_catalog_reconciliation', {
              p_item: item.catalog_material_id,
              p_marker: item.marker,
              p_outcome: outcome,
              p_worker: workerId
            });
          }
        } catch (error) {
          console.error(
            '[catalog-updater] reconciliation readback pending',
            item.catalog_material_id,
            mapUnknownError(error).code
          );
        }
      }
      // Cleanup failures retain their durable leases and must not starve regular
      // catalog rounds or the other Launch cleanup lane.
      await runTaskCleanupTick(service, driveFor).catch(() => ({ completed: 0, pending: 1 }));
      const launchCleanup = await runLaunchCleanupTick(service, driveFor).catch(() => ({
        completed: 0,
        pending: 1,
        unavailable: true
      }));
      const launchVideoCleanup = await runLaunchVideoCleanupTick(service, driveFor).catch(() => ({
        completed: 0,
        pending: 1,
        unavailable: true
      }));
      const summary = await runCatalogUpdaterTick(
        {
          workerId,
          drawImages: async (teamId, count, options) =>
            drawCatalogImagePool(
              (name, params) => rpcValue(service, name, params),
              teamId,
              count,
              options
            ),
          finalizeImageUses: async (teamId, attemptId, delivered) => {
            await rpcValue(service, 'service_catalog_image_finalize_uses_v2', {
              p_team: teamId,
              p_attempt: attemptId,
              p_delivered: delivered
            });
          },
          validateImageUses: async (teamId, attemptId) => {
            await rpcValue(service, 'service_catalog_image_validate_uses_v2', {
              p_team: teamId,
              p_attempt: attemptId
            });
          },
          validateImageRows: async (teamId, images) => {
            await rpcValue(service, 'service_catalog_image_validate_rows_v2', {
              p_team: teamId,
              p_images: images
            });
          },
          drawTexts: async (teamId, count) => {
            const rows = await rpcValue(service, 'service_draw_product_catalog_texts', {
              p_team: teamId,
              p_count: count
            });
            return (Array.isArray(rows) ? rows : []).flatMap(row => {
              const record =
                row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
              return record &&
                typeof record.title === 'string' &&
                typeof record.description === 'string'
                ? [{ title: record.title, description: record.description }]
                : [];
            });
          },
          openRounds: async () =>
            Number(await rpcValue(service, 'service_open_catalog_updater_rounds', {})) || 0,
          claim: async (limit, leaseSeconds) => {
            const rows = await rpcValue(service, 'service_claim_catalog_updater_items', {
              p_worker: workerId,
              p_limit: limit,
              p_lease_seconds: leaseSeconds
            });
            if (!Array.isArray(rows)) return [];
            return Promise.all(
              rows.map(async row => {
                if (
                  !row ||
                  typeof row !== 'object' ||
                  !('team_id' in row) ||
                  typeof row.team_id !== 'string' ||
                  !('catalog_material_id' in row) ||
                  typeof row.catalog_material_id !== 'string'
                )
                  return row;
                const mode = await rpcValue(service, 'service_catalog_image_mode_v2', {
                  p_team: row.team_id
                });
                if (mode !== 'v2') return row;
                const imageAttempt = await rpcValue(
                  service,
                  'service_catalog_image_update_attempt_v2',
                  { p_catalog: row.catalog_material_id, p_worker: workerId }
                );
                if (typeof imageAttempt !== 'string')
                  throw new TeamFunctionError('INVALID_RESPONSE');
                return { ...row, image_attempt_id: imageAttempt };
              })
            );
          },
          driveFor,
          progress: async (catalogId, stage) =>
            (await rpcValue(service, 'service_set_catalog_update_progress', {
              p_item: catalogId,
              p_worker: workerId,
              p_stage: stage
            })) === true,
          beginWrite: async (catalogId, input) =>
            (await rpcValue(service, 'service_begin_catalog_update_write', {
              p_item: catalogId,
              p_worker: workerId,
              p_marker: input.marker,
              p_baseline_version: input.baselineVersion,
              p_expected_count: input.expectedCount,
              p_swapped_copy: input.swappedCopy,
              p_product_count: input.became.productCount,
              p_settings_snapshot: input.became.snapshot
            })) === true,
          finishWrite: async catalogId =>
            (await rpcValue(service, 'service_finish_catalog_update_write', {
              p_item: catalogId
            })) === true,
          recordChanges: async (catalogId, changes) =>
            (await rpcValue(service, 'service_record_catalog_update_changes', {
              p_item: catalogId,
              p_worker: workerId,
              p_changes: changes
            })) === true,
          complete: async (catalogId, updateCount, swappedCopy, became) =>
            (await rpcValue(service, 'service_complete_catalog_update', {
              p_item: catalogId,
              p_worker: workerId,
              p_update_count: updateCount,
              p_swapped_copy: swappedCopy,
              ...(became
                ? { p_product_count: became.productCount, p_settings_snapshot: became.snapshot }
                : {})
            })) === true,
          claimOrphans: async (limit, leaseSeconds) => {
            const rows = await rpcValue(service, 'service_claim_orphan_cleanups', {
              p_worker: workerId,
              p_limit: limit,
              p_lease_seconds: leaseSeconds
            });
            return Array.isArray(rows) ? rows : [];
          },
          clearOrphan: async (materialId, trashed) =>
            (await rpcValue(service, 'service_complete_orphan_cleanup', {
              p_material: materialId,
              p_worker: workerId,
              p_trashed: trashed
            })) === true,
          retry: async (catalogId, errorCode, nextAttemptAt) =>
            (await rpcValue(service, 'service_retry_catalog_update', {
              p_item: catalogId,
              p_worker: workerId,
              p_error: errorCode,
              p_next_attempt_at: nextAttemptAt.toISOString()
            })) === true,
          unknown: async (catalogId, errorCode) =>
            (await rpcValue(service, 'service_mark_catalog_update_unknown', {
              p_item: catalogId,
              p_worker: workerId,
              p_error: errorCode
            })) === true,
          markNeedsReauth: async credentialId => {
            await rpcValue(service, 'service_mark_drive_needs_reauth', {
              p_credential: credentialId
            });
          },
          claimRetired: async limit => {
            const rows = await rpcValue(service, 'service_claim_retired_restitch_copies', {
              p_limit: limit
            });
            return Array.isArray(rows) ? rows : [];
          },
          authorizeCleanup: async (materialId, kind) =>
            (await rpcValue(service, 'service_authorize_catalog_cleanup', {
              p_material: materialId,
              p_kind: kind,
              p_worker: workerId
            })) === true,
          forgetCopy: async (materialId, deleted) =>
            (await rpcValue(service, 'service_forget_restitch_copy', {
              p_material: materialId,
              p_deleted: deleted
            })) === true,
          now: () => Date.now(),
          log: (message, detail) => console.error(message, detail)
        },
        { budgetMs: BUDGET_MS }
      );
      return successResponse({
        ...summary,
        launches,
        launchCleanup,
        launchVideoCleanup,
        processOutputCleanup: await processCleanup
      });
    } catch (cause) {
      await processCleanup;
      throw cause;
    }
  } catch (error) {
    return errorResponse(mapUnknownError(error));
  }
});
