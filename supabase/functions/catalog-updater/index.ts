import { createCatalogNonVideoUpdater, CATALOG_NONVIDEO_MARKER } from './nonvideo-writer.ts';
import { createTargetedCatalogPublicationIo } from './publication-io.ts';
import { isRecord } from '../_shared/validation.ts';
import { targetedCatalogWriterEnabled } from '../_shared/restitch-native.ts';
import {
  settleCatalogUpdaterVariantTargets,
  prepareScheduledCatalogVideoSets
} from '../drive-ops/updater-variants.ts';
import { runCatalogPublicationScheduler } from './publication-authority.ts';
import { isPublicationLaneRequest, runCatalogPublicationLane } from './publication-lane.ts';
import { prepareCatalogClaims } from './claim-preparation.ts';
import { runCatalogTextScheduleTickSafely } from './text-schedule.ts';
import { drawCatalogImagePool } from '../_shared/catalog-image-draw.ts';
import { runProcessOutputCleanupTick } from '../drive-ops/process-output-recovery.ts';
import { reconcileUncertainProcessUploads } from '../drive-ops/uncertain-upload-reconcile.ts';
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
    const publicationWorkerId = crypto.randomUUID();
    const workerId = `catalog-updater:${publicationWorkerId}`;
    // The ten-second deferred-publication lane runs the publication scheduler only.
    if (isPublicationLaneRequest(await request.json().catch(() => null))) {
      const publications = await runCatalogPublicationLane(service, publicationWorkerId, name =>
        Deno.env.get(name)
      );
      return successResponse({ publications });
    }
    // Text schedules must run even when no catalog is due or Drive OAuth is unavailable.
    await runCatalogTextScheduleTickSafely((name, parameters) =>
      rpcValue(service, name, parameters)
    );
    // Recover already completed Launch children and provider-free cancellations even
    // when there are no updater rounds and no browser is connected. Unknown provider
    // outcomes remain unsettled for the ownership-aware recovery path. Each
    // settlement isolates its own rows; a call that still fails as a whole must
    // not stop the other settlements or the regular rounds below.
    const settleSafely = (name: string) =>
      rpcValue(service, name, { p_limit: 3 }).catch(error => {
        console.error(
          '[catalog-updater] settlement pending',
          name,
          error instanceof Error ? error.message : 'UNKNOWN'
        );
        return null;
      });
    await settleSafely('service_settle_catalog_video_cancellations');
    await settleSafely('service_settle_launch_restitch_cancellations');
    await settleSafely('service_settle_launch_restitch_batch');
    const launches = await settleSafely('service_settle_launch_batch');
    // Manager rounds that can never finish on their own: a variant child that
    // ended, an attempt no item owns any more, a round nobody claims, a review
    // quarantine with nothing to reconcile. A failure here must not stop the
    // regular rounds below.
    const unstuck = await rpcValue(service, 'service_sweep_catalog_updater_rounds', {
      p_limit: 10
    }).catch(error => {
      console.error(
        '[catalog-updater] stuck-round sweep pending',
        error instanceof Error ? error.message : 'UNKNOWN'
      );
      return null;
    });

    const targetedNativeSheets = targetedCatalogWriterEnabled({
      enabled: Deno.env.get('CATALOG_NATIVE_SHEETS_BETA'),
      variants: Deno.env.get('SOTY_CATALOG_VIDEO_VARIANTS'),
      environment: Deno.env.get('SOTY_ENVIRONMENT'),
      oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
      siteUrl: Deno.env.get('WISHLY_SITE_URL')
    });
    let publications: Awaited<ReturnType<typeof runCatalogPublicationScheduler>> | undefined;
    if (!targetedNativeSheets)
      publications = await runCatalogPublicationScheduler({
        service,
        workerId: publicationWorkerId,
        io: null
      });
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
    if (targetedNativeSheets)
      publications = await runCatalogPublicationScheduler({
        service,
        workerId: publicationWorkerId,
        io: createTargetedCatalogPublicationIo(service, publicationWorkerId, driveFor)
      });
    await settleCatalogUpdaterVariantTargets(service, driveFor);
    // Start the bounded one-file cleanup independently of catalog work. Always
    // join it below, including catalog failure, so it survives a quiet catalog
    // without becoming unobserved work after the request has returned.
    const processCleanup = runProcessOutputCleanupTick(service, driveFor).catch(() => ({
      completed: 0,
      pending: 1,
      retained: 0,
      unavailable: true
    }));
    // A catalog variant whose upload ended uncertain (agent silent for 2 min):
    // looked up by its generated Drive id and settled, instead of 12 hours.
    const uncertainUploads = reconcileUncertainProcessUploads(service, driveFor, {
      limit: 3
    }).catch(() => ['waiting' as const]);
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
          const nativeNonVideo =
            (await rpcValue(service, 'service_read_catalog_nonvideo_reconciliation', {
              p_item: item.catalog_material_id,
              p_marker: item.marker
            })) === true;
          const nativeMarker = nativeNonVideo
            ? (
                await drive.readNativeSpreadsheetMarkers(
                  item.drive_file_id,
                  CATALOG_NONVIDEO_MARKER
                )
              ).includes(item.marker)
            : false;
          const outcome =
            nativeMarker &&
            !file.trashed &&
            file.mimeType === 'application/vnd.google-apps.spreadsheet'
              ? 'delivered'
              : classifyCatalogReadback(file, {
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
      let claimQuarantined = 0;
      let claimStale = 0;
      const summary = await runCatalogUpdaterTick(
        {
          workerId,
          ...(targetedNativeSheets
            ? { prepareNonVideoUpdate: createCatalogNonVideoUpdater(service, workerId, driveFor) }
            : {}),
          authorizeLegacyVideoWrite: async catalogId =>
            (await rpcValue(service, 'service_catalog_publication_allows_legacy_write', {
              p_catalog: catalogId
            })) === true,
          readImageLink: async teamId => {
            const rows = await rpcValue(service, 'service_get_team_product_catalog_settings', {
              p_team: teamId
            });
            const settings = Array.isArray(rows) ? rows[0] : null;
            if (!settings) return null;
            if (
              typeof settings !== 'object' ||
              (settings.image_link !== null && typeof settings.image_link !== 'string')
            )
              throw new TeamFunctionError('INVALID_RESPONSE');
            return typeof settings.image_link === 'string' && settings.image_link.trim()
              ? settings.image_link.trim()
              : null;
          },
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
            await prepareScheduledCatalogVideoSets(service, driveFor);
            const rows = await rpcValue(service, 'service_claim_catalog_updater_items', {
              p_worker: workerId,
              p_limit: limit,
              p_lease_seconds: leaseSeconds
            });
            if (!Array.isArray(rows)) return [];
            const prepared = await prepareCatalogClaims(rows, workerId, (name, parameters) =>
              rpcValue(service, name, parameters)
            );
            claimQuarantined += prepared.quarantined;
            claimStale += prepared.stale;
            return prepared.rows;
          },
          driveFor,
          progress: async (catalogId, stage) =>
            (await rpcValue(service, 'service_set_catalog_update_progress', {
              p_item: catalogId,
              p_worker: workerId,
              p_stage: stage
            })) === true,
          // 050: the legacy writer keeps the catalog's R2 link from the indexed source row.
          resolveVideoLink: async (catalogId, sourceMaterialId) => {
            const value = await rpcValue(service, 'service_catalog_video_r2_resolve_current', {
              p_catalog: catalogId,
              p_source_material: sourceMaterialId
            });
            if (!isRecord(value) || value.enabled !== true) return null;
            if (
              typeof value.url === 'string' &&
              value.state === 'ready' &&
              typeof value.sourceMaterialId === 'string' &&
              typeof value.sourceVersion === 'string'
            )
              return {
                kind: 'r2',
                url: value.url,
                sourceMaterialId: value.sourceMaterialId,
                sourceVersion: value.sourceVersion
              };
            await rpcValue(service, 'service_catalog_video_r2_kick', { p_route: 'claim' }).catch(
              () => undefined
            );
            return { kind: 'drive' };
          },
          confirmVideoLink: async (catalogId, linkKind, uses) => {
            await rpcValue(service, 'service_catalog_video_r2_confirm_use', {
              p_catalog: catalogId,
              p_link_kind: linkKind,
              p_uses: uses,
              p_job: null
            });
          },
          beginWrite: async (catalogId, input) =>
            (await rpcValue(
              service,
              input.nonVideoContextToken
                ? 'service_begin_catalog_nonvideo_update_write'
                : 'service_begin_catalog_update_write',
              {
                p_item: catalogId,
                p_worker: workerId,
                p_marker: input.marker,
                p_baseline_version: input.baselineVersion,
                p_expected_count: input.expectedCount,
                ...(input.nonVideoContextToken
                  ? { p_context_token: input.nonVideoContextToken }
                  : { p_swapped_copy: input.swappedCopy }),
                p_product_count: input.became.productCount,
                p_settings_snapshot: input.became.snapshot
              }
            )) === true,
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
        claimed: summary.claimed + claimQuarantined + claimStale,
        skipped: summary.skipped + claimQuarantined + claimStale,
        claimQuarantined,
        claimStale,
        launches,
        unstuck,
        publications,
        launchCleanup,
        launchVideoCleanup,
        processOutputCleanup: await processCleanup,
        uncertainUploads: await uncertainUploads
      });
    } catch (cause) {
      await processCleanup;
      await uncertainUploads;
      throw cause;
    }
  } catch (error) {
    return errorResponse(mapUnknownError(error));
  }
});
