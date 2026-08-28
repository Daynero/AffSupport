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
import { runPreviewWarmSlice, type PreviewWarmRow } from '../_shared/preview-warm.ts';
import { THUMBNAIL_CACHE_BUCKET } from '../_shared/thumbnails.ts';
import { isRecord } from '../_shared/validation.ts';

/**
 * Prepares provider thumbnails ahead of use (011, FR-014/FR-015): claims
 * pending materials in indexed folders, fetches each provider thumbnail into
 * the private cache bucket, and records the outcome against the version it was
 * fetched for. Nothing here needs a member's local app.
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
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        body: Uint8Array,
        options: { cacheControl: string; contentType: string; upsert: boolean }
      ) => Promise<{ error: { message: string } | null }>;
    };
  };
}

const CLAIM_LIMIT = 50;

function serviceClient(): RpcClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) as unknown as RpcClient;
}

async function rpcValue(
  client: RpcClient,
  name: string,
  parameters: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  return data;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function warmRow(row: Record<string, unknown>): PreviewWarmRow | null {
  const materialId = text(row, 'material_id');
  const teamId = text(row, 'team_id');
  const connectionId = text(row, 'connection_id');
  const credentialId = text(row, 'credential_id');
  const driveFileId = text(row, 'drive_file_id');
  if (!materialId || !teamId || !connectionId || !credentialId || !driveFileId) return null;
  return {
    materialId,
    teamId,
    connectionId,
    credentialId,
    driveFileId,
    resourceKey: text(row, 'resource_key'),
    driveVersion: text(row, 'drive_version'),
    mimeType: text(row, 'mime_type')
  };
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return errorResponse(new TeamFunctionError('INVALID_INPUT', { retryable: false }));
  }
  try {
    await requireNamedWorkerSecret(
      request,
      Deno.env.get('PREVIEW_WARM_SECRET'),
      'x-preview-warm-secret'
    );
    const signals = { siteUrl: Deno.env.get('WISHLY_SITE_URL') };
    requireDriveOAuthGate(signals, Deno.env.get('DRIVE_OAUTH_MODE'));
    const service = serviceClient();
    const claimed = rows(
      await rpcValue(service, 'service_claim_preview_warm', { p_limit: CLAIM_LIMIT })
    )
      .map(warmRow)
      .filter((row): row is PreviewWarmRow => row !== null);

    // One access token per credential, minted once for the whole pass.
    const drives = new Map<string, GoogleDriveClient>();
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret)
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
    const driveFor = async (credentialId: string): Promise<GoogleDriveClient> => {
      const existing = drives.get(credentialId);
      if (existing) return existing;
      const credential = await readDriveCredential(service, credentialId);
      const token = await refreshGoogleAccessToken({
        credential,
        clientId,
        clientSecret,
        oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
        productionSignals: signals
      });
      const drive = new GoogleDriveClient(token.accessToken);
      drives.set(credentialId, drive);
      return drive;
    };

    const summary = await runPreviewWarmSlice(claimed, {
      getFile: async row => {
        const drive = await driveFor(row.credentialId);
        const live = await drive.getFile(row.driveFileId, row.resourceKey);
        return {
          trashed: live.trashed,
          mimeType: live.mimeType,
          version: live.version,
          checksum: live.checksum,
          thumbnailLink: live.thumbnailLink ?? null
        };
      },
      fetchThumbnail: async (row, thumbnailLink) => {
        const drive = await driveFor(row.credentialId);
        const upstream = await drive.fetchThumbnail({ thumbnailLink });
        const mimeType =
          upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        return { status: upstream.status, mimeType, bytes };
      },
      store: async (path, bytes, mimeType) => {
        const { error } = await service.storage.from(THUMBNAIL_CACHE_BUCKET).upload(path, bytes, {
          cacheControl: '31536000',
          contentType: mimeType,
          upsert: true
        });
        if (error) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
      },
      commit: async (row, outcome) => {
        await rpcValue(service, 'service_commit_thumbnail', {
          p_material: row.materialId,
          p_state: outcome.state,
          p_reason: outcome.state === 'unavailable' ? outcome.reason : null,
          p_version: outcome.state === 'ready' ? outcome.version : null
        });
      }
    });
    return successResponse({ claimed: claimed.length, ...summary });
  } catch (error) {
    return errorResponse(mapUnknownError(error));
  }
});
