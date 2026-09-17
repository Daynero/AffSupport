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
import { runCatalogUpdaterTick } from './worker.ts';

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
    const signals = { siteUrl: Deno.env.get('WISHLY_SITE_URL') };
    const oauthMode = Deno.env.get('DRIVE_OAUTH_MODE');
    requireDriveOAuthGate(signals, oauthMode);
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
    }
    const service = serviceClient();
    const workerId = `catalog-updater:${crypto.randomUUID()}`;

    // One access token per credential for the whole tick.
    const drives = new Map<string, Promise<GoogleDriveClient>>();
    const summary = await runCatalogUpdaterTick(
      {
        workerId,
        drawImages: async (teamId, count) => {
          const rows = await rpcValue(service, 'service_draw_product_catalog_images', {
            p_team: teamId,
            p_count: count
          });
          return (Array.isArray(rows) ? rows : []).flatMap(row =>
            row &&
            typeof row === 'object' &&
            typeof (row as Record<string, unknown>).drive_file_id === 'string'
              ? [
                  {
                    driveFileId: (row as Record<string, unknown>).drive_file_id as string,
                    resourceKey:
                      typeof (row as Record<string, unknown>).resource_key === 'string'
                        ? ((row as Record<string, unknown>).resource_key as string)
                        : null
                  }
                ]
              : []
          );
        },
        drawTexts: async (teamId, count) => {
          const rows = await rpcValue(service, 'service_draw_product_catalog_texts', {
            p_team: teamId,
            p_count: count
          });
          return (Array.isArray(rows) ? rows : []).flatMap(row => {
            const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
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
          return Array.isArray(rows) ? rows : [];
        },
        driveFor: credentialId => {
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
        },
        complete: async (catalogId, updateCount, swappedCopy) =>
          (await rpcValue(service, 'service_complete_catalog_update', {
            p_item: catalogId,
            p_worker: workerId,
            p_update_count: updateCount,
            p_swapped_copy: swappedCopy
          })) === true,
        retry: async (catalogId, errorCode, nextAttemptAt) =>
          (await rpcValue(service, 'service_retry_catalog_update', {
            p_item: catalogId,
            p_worker: workerId,
            p_error: errorCode,
            p_next_attempt_at: nextAttemptAt.toISOString()
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
    return successResponse(summary);
  } catch (error) {
    return errorResponse(mapUnknownError(error));
  }
});
