import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  AGENT_INTAKE_MAX_BYTES,
  TRANSCRIPT_INGEST_STATES,
  type TranscriptIngestState
} from '../../../packages/shared/dist/team/contract.js';
import {
  MATERIAL_CATEGORIES,
  type MaterialCategory
} from '../../../packages/shared/dist/team/material-category.js';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode,
  type TeamTransferGrant
} from '../../../packages/shared/dist/team/transport.js';
import { authorizeCaller, type OAuthProductionSignals } from '../_shared/auth.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import {
  readDriveCredential,
  refreshGoogleAccessToken,
  type ServiceRpcClient
} from '../_shared/credentials.ts';
import { GoogleDriveClient, proveLiveAncestry, requireDriveCapability } from '../_shared/drive.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { isRecord, parseEnum, parseJsonBody, parseUuid } from '../_shared/validation.ts';
import {
  MAX_PREVIEW_RANGE_BYTES,
  authorizePreviewRange,
  boundedResponseBody,
  buildDownloadGrantResult,
  buildPreviewResult,
  forwardedRangeHeaders,
  validateUpstreamRangeResponse,
  type PreviewGrantContext,
  type PreviewMaterialRecord,
  type PreviewMode
} from './handler.ts';

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

interface TransferContext {
  teamId: string;
  materialId: string;
  actorId: string;
  credentialId: string;
  rootFolderId: string;
  rootResourceKey: string | null;
  driveFileId: string;
  resourceKey: string | null;
  name: string;
  category: MaterialCategory | null;
  mimeType: string | null;
  sizeBytes: number | null;
  driveVersion: string | null;
  checksum: string | null;
}

function clients(request: Request): { caller: RpcClient; service: RpcClient } {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  const authorization = request.headers.get('authorization') ?? '';
  const caller = createClient(url, anonKey, {
    global: { headers: { authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return {
    caller: caller as unknown as RpcClient,
    service: service as unknown as RpcClient
  };
}

function mappedRpcError(error: RpcFailure): TeamFunctionError {
  const candidates = [error.message, error.code]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.match(/[A-Z][A-Z0-9_]+/g) ?? []);
  const code = candidates.find(value => (TEAM_ERROR_CODES as readonly string[]).includes(value)) as
    TeamErrorCode | undefined;
  return new TeamFunctionError(code ?? 'INVALID_RESPONSE', {
    retryable: code === 'DRIVE_UNAVAILABLE' || code === 'RATE_LIMITED'
  });
}

async function rpcValue(
  client: RpcClient,
  name: string,
  parameters: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw mappedRpcError(error);
  return data;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return isRecord(row) ? row : null;
}

function stringValue(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] : null;
}

function safeInteger(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function previewMaterial(value: unknown): PreviewMaterialRecord | null {
  const row = firstRecord(value);
  if (!row) return null;
  const teamId = stringValue(row, 'team_id');
  const materialId = stringValue(row, 'material_id');
  const driveFileId = stringValue(row, 'drive_file_id');
  const name = stringValue(row, 'name');
  const category = row.category;
  const transcriptState = row.transcript_ingest_state;
  if (
    !teamId ||
    !materialId ||
    !driveFileId ||
    !name ||
    (category !== null &&
      (typeof category !== 'string' ||
        !(MATERIAL_CATEGORIES as readonly string[]).includes(category))) ||
    typeof transcriptState !== 'string' ||
    !(TRANSCRIPT_INGEST_STATES as readonly string[]).includes(transcriptState) ||
    typeof row.transcript_truncated !== 'boolean' ||
    typeof row.can_download !== 'boolean' ||
    typeof row.can_edit !== 'boolean'
  ) {
    return null;
  }
  const indexedBytes = safeInteger(row.transcript_indexed_bytes);
  if (indexedBytes === null || indexedBytes > 1024 * 1024) return null;
  return {
    teamId,
    materialId,
    driveFileId,
    resourceKey: stringValue(row, 'resource_key'),
    name,
    category: category as MaterialCategory | null,
    mimeType: stringValue(row, 'mime_type'),
    fileExtension: stringValue(row, 'file_extension'),
    sizeBytes: safeInteger(row.size_bytes),
    driveVersion: stringValue(row, 'drive_version'),
    checksum: stringValue(row, 'checksum'),
    previewState: stringValue(row, 'preview_state') ?? 'unavailable',
    previewErrorCode: stringValue(row, 'preview_error_code'),
    transcriptText: stringValue(row, 'transcript_text'),
    transcriptIngestState: transcriptState as TranscriptIngestState,
    transcriptTruncated: row.transcript_truncated,
    transcriptIndexedBytes: indexedBytes,
    transcriptSourceVersion: stringValue(row, 'transcript_source_version'),
    canDownload: row.can_download,
    canEdit: row.can_edit
  };
}

function transferContext(value: unknown): TransferContext | null {
  const row = firstRecord(value);
  if (!row) return null;
  const teamId = stringValue(row, 'team_id');
  const materialId = stringValue(row, 'material_id');
  const actorId = stringValue(row, 'actor_id');
  const credentialId = stringValue(row, 'credential_id');
  const rootFolderId = stringValue(row, 'root_folder_id');
  const driveFileId = stringValue(row, 'drive_file_id');
  const name = stringValue(row, 'name');
  const category = row.category;
  if (
    !teamId ||
    !materialId ||
    !actorId ||
    !credentialId ||
    !rootFolderId ||
    !driveFileId ||
    !name ||
    (category !== null &&
      (typeof category !== 'string' ||
        !(MATERIAL_CATEGORIES as readonly string[]).includes(category)))
  ) {
    return null;
  }
  return {
    teamId,
    materialId,
    actorId,
    credentialId,
    rootFolderId,
    rootResourceKey: stringValue(row, 'root_resource_key'),
    driveFileId,
    resourceKey: stringValue(row, 'resource_key'),
    name,
    category: category as MaterialCategory | null,
    mimeType: stringValue(row, 'mime_type'),
    sizeBytes: safeInteger(row.size_bytes),
    driveVersion: stringValue(row, 'drive_version'),
    checksum: stringValue(row, 'checksum')
  };
}

function randomTicket(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function byteaHex(value: Uint8Array): string {
  return `\\x${[...value].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function rangeEndpoint(request: Request) {
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/range')) url.pathname = `${url.pathname.replace(/\/$/u, '')}/range`;
  return url.toString();
}

async function issueGrant(
  service: RpcClient,
  material: PreviewMaterialRecord,
  actorId: string,
  binding: { mode: PreviewMode; operationId: string | null }
): Promise<TeamTransferGrant> {
  const ticket = randomTicket();
  const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  await rpcValue(service, 'issue_team_transfer_grant', {
    p_token_hash: byteaHex(await sha256(ticket)),
    p_operation: null,
    p_team: material.teamId,
    p_actor: actorId,
    p_purpose: 'preview_range',
    p_material: material.materialId,
    p_destination: null,
    p_tool: binding.operationId
      ? `preview:${binding.mode}:${binding.operationId}`
      : `preview:${binding.mode}`,
    p_max_range_bytes: MAX_PREVIEW_RANGE_BYTES,
    p_expires_at: expiresAt,
    p_max_uses: 512
  });
  return {
    ticket,
    purpose: 'preview_range',
    expiresAt,
    maxRangeBytes: MAX_PREVIEW_RANGE_BYTES,
    maxUses: 512
  };
}

async function issueDownloadGrant(
  service: RpcClient,
  material: PreviewMaterialRecord,
  actorId: string,
  consumer: 'browser' | 'agent'
): Promise<TeamTransferGrant> {
  const ticket = randomTicket();
  const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const size = material.sizeBytes;
  if (size === null || size < 0 || size > AGENT_INTAKE_MAX_BYTES) {
    throw new TeamFunctionError(
      size !== null && size > AGENT_INTAKE_MAX_BYTES ? 'TOO_LARGE' : 'INVALID_RESPONSE',
      {
        retryable: false
      }
    );
  }
  const maxUses = Math.min(
    Math.max(Math.ceil(size / MAX_PREVIEW_RANGE_BYTES) + 4, 1),
    consumer === 'browser' ? 8 : 10_000
  );
  await rpcValue(service, 'issue_team_transfer_grant', {
    p_token_hash: byteaHex(await sha256(ticket)),
    p_operation: null,
    p_team: material.teamId,
    p_actor: actorId,
    p_purpose: 'download_range',
    p_material: material.materialId,
    p_destination: null,
    p_tool: `download:${consumer}`,
    p_max_range_bytes: MAX_PREVIEW_RANGE_BYTES,
    p_expires_at: expiresAt,
    p_max_uses: maxUses
  });
  return {
    ticket,
    purpose: 'download_range',
    expiresAt,
    maxRangeBytes: MAX_PREVIEW_RANGE_BYTES,
    maxUses
  };
}

function productionSignals(request: Request): OAuthProductionSignals {
  return {
    siteUrl: Deno.env.get('WISHLY_SITE_URL'),
    requestOrigin: request.headers.get('origin')
  };
}

async function driveClient(service: RpcClient, credentialId: string, request: Request) {
  const credential = await readDriveCredential(service, credentialId);
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
  }
  try {
    const token = await refreshGoogleAccessToken({
      credential,
      clientId,
      clientSecret,
      oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
      productionSignals: productionSignals(request)
    });
    return new GoogleDriveClient(token.accessToken);
  } catch (error) {
    if (error instanceof TeamFunctionError && error.code === 'NEEDS_REAUTH') {
      await rpcValue(service, 'service_mark_drive_needs_reauth', {
        p_credential: credentialId
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function consumeGrant(
  service: RpcClient,
  ticket: string,
  purpose: 'preview_range' | 'download_range' | 'process_input'
): Promise<PreviewGrantContext | null> {
  const row = firstRecord(
    await rpcValue(service, 'consume_team_transfer_grant', {
      p_token_hash: byteaHex(await sha256(ticket)),
      p_purpose: purpose
    })
  );
  if (!row) return null;
  const teamId = stringValue(row, 'team_id');
  const actorId = stringValue(row, 'actor_id');
  const materialId = stringValue(row, 'material_id');
  const maxRangeBytes = safeInteger(row.max_range_bytes);
  if (!teamId || !actorId || !materialId || maxRangeBytes === null) return null;
  return {
    teamId,
    actorId,
    materialId,
    maxRangeBytes,
    toolId: stringValue(row, 'tool_id'),
    purpose
  };
}

async function consumeRangeGrant(service: RpcClient, ticket: string) {
  for (const purpose of ['preview_range', 'download_range', 'process_input'] as const) {
    const grant = await consumeGrant(service, ticket, purpose);
    if (grant) return grant;
  }
  return null;
}

function materialFromTransfer(context: TransferContext): PreviewMaterialRecord {
  return {
    teamId: context.teamId,
    materialId: context.materialId,
    driveFileId: context.driveFileId,
    resourceKey: context.resourceKey,
    name: context.name,
    category: context.category,
    mimeType: context.mimeType,
    fileExtension: null,
    sizeBytes: context.sizeBytes,
    driveVersion: context.driveVersion,
    checksum: context.checksum,
    previewState: 'ready',
    previewErrorCode: null,
    transcriptText: null,
    transcriptIngestState: 'not_applicable',
    transcriptTruncated: false,
    transcriptIndexedBytes: 0,
    transcriptSourceVersion: null,
    canDownload: false,
    canEdit: false
  };
}

async function handleRange(request: Request, service: RpcClient, cors: Record<string, string>) {
  const url = new URL(request.url);
  const ticket =
    url.searchParams.get('grant') ?? request.headers.get('x-wishly-transfer-grant') ?? '';
  let liveDrive: GoogleDriveClient | null = null;
  const authorized = await authorizePreviewRange(
    { ticket, rangeHeader: request.headers.get('range') },
    {
      consumeGrant: value => consumeRangeGrant(service, value),
      loadMaterial: async grant => {
        const context = transferContext(
          await rpcValue(service, 'service_get_material_transfer_context', {
            p_team: grant.teamId,
            p_material: grant.materialId,
            p_actor: grant.actorId
          })
        );
        return context ? materialFromTransfer(context) : null;
      },
      proveLiveAccess: async (material, grant) => {
        const context = transferContext(
          await rpcValue(service, 'service_get_material_transfer_context', {
            p_team: grant.teamId,
            p_material: grant.materialId,
            p_actor: grant.actorId
          })
        );
        if (!context) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
        liveDrive = await driveClient(service, context.credentialId, request);
        const live = await proveLiveAncestry({
          client: liveDrive,
          fileId: material.driveFileId,
          rootFolderId: context.rootFolderId,
          resourceKey: material.resourceKey
        });
        requireDriveCapability(live, 'canDownload');
        if (live.mimeType.startsWith('application/vnd.google-apps.')) {
          throw new TeamFunctionError('UNSUPPORTED_MEDIA', { retryable: false });
        }
        if (live.size === null || live.size <= 0) {
          throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
        }
        return {
          fileId: live.id,
          resourceKey: live.resourceKey,
          sizeBytes: live.size,
          mimeType: live.mimeType,
          canDownload: live.capabilities.canDownload,
          sourceVersion: live.version,
          sourceChecksum: live.checksum
        };
      }
    }
  );
  if (!liveDrive) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  const upstream = await liveDrive.fetchFileRange({
    fileId: authorized.source.fileId,
    resourceKey: authorized.source.resourceKey,
    start: authorized.range.start,
    end: authorized.range.end,
    signal: request.signal
  });
  let contentLength: number;
  try {
    contentLength = validateUpstreamRangeResponse(
      upstream.status,
      upstream.headers,
      authorized.range,
      authorized.source.sizeBytes
    );
  } catch (error) {
    await upstream.body?.cancel().catch(() => undefined);
    throw error;
  }
  const headers = forwardedRangeHeaders(
    upstream.headers,
    authorized.source.mimeType,
    authorized.grant.purpose === 'preview_range' ? 'inline' : 'attachment'
  );
  if (authorized.source.sourceVersion) {
    headers.set('x-wishly-source-version', authorized.source.sourceVersion);
  }
  if (authorized.source.sourceChecksum) {
    headers.set('x-wishly-source-checksum', authorized.source.sourceChecksum);
  }
  if (cors['access-control-allow-origin']) {
    headers.set('access-control-expose-headers', 'Accept-Ranges, Content-Length, Content-Range');
  }
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(boundedResponseBody(upstream.body, contentLength), {
    status: upstream.status === 206 ? 206 : 200,
    headers
  });
}

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const browserCors = corsHeadersForRequest(request);
  if (request.headers.has('origin') && !browserCors) return new Response(null, { status: 403 });
  const cors = browserCors ?? {};

  try {
    const url = new URL(request.url);
    const configured = clients(request);
    if (request.method === 'GET' && url.pathname.endsWith('/range')) {
      return await handleRange(request, configured.service, cors);
    }
    if (request.method !== 'POST') {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    const teamId = parseUuid(parsed.value.teamId);
    const materialId = parseUuid(parsed.value.materialId);
    if (!teamId.ok || !materialId.ok) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const { userId } = await authorizeCaller(request, configured.service);
    if (parsed.value.action === 'landing_validation') {
      const operationId = parsed.value.operationId;
      const operation = parseUuid(operationId);
      const ticket = parsed.value.ticket;
      const validation = parsed.value.validation;
      if (
        !operation.ok ||
        typeof ticket !== 'string' ||
        !isRecord(validation) ||
        (validation.sourceVersion !== null && typeof validation.sourceVersion !== 'string') ||
        (validation.sourceChecksum !== null && typeof validation.sourceChecksum !== 'string') ||
        typeof validation.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(validation.fingerprint)
      ) {
        throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
      }
      const grant = await consumeGrant(configured.service, ticket, 'preview_range');
      if (
        !grant ||
        grant.teamId !== teamId.value ||
        grant.materialId !== materialId.value ||
        grant.actorId !== userId ||
        grant.toolId !== `preview:landing:${operation.value}`
      ) {
        throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
      }
      const committed = await rpcValue(
        configured.service,
        'service_commit_landing_preview_validation',
        {
          p_team: teamId.value,
          p_material: materialId.value,
          p_actor: userId,
          p_expected_version: validation.sourceVersion,
          p_expected_checksum: validation.sourceChecksum,
          p_fingerprint: validation.fingerprint
        }
      );
      return successResponse({ validated: committed === true }, cors);
    }
    if (parsed.value.action === 'grant' || parsed.value.purpose === 'download') {
      const consumer = parseEnum(parsed.value.consumer, ['browser', 'agent'] as const);
      if (!consumer.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
      const material = previewMaterial(
        await rpcValue(configured.caller, 'get_material_preview', {
          p_team: teamId.value,
          p_material: materialId.value
        })
      );
      if (!material) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
      const result = await buildDownloadGrantResult(
        material,
        { consumer: consumer.value, rangeEndpoint: rangeEndpoint(request) },
        value => issueDownloadGrant(configured.service, value, userId, consumer.value)
      );
      return successResponse(result, cors);
    }
    const mode = parseEnum(parsed.value.mode, [
      'media',
      'transcript',
      'archive',
      'landing'
    ] as const);
    if (!mode.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    const material = previewMaterial(
      await rpcValue(configured.caller, 'get_material_preview', {
        p_team: teamId.value,
        p_material: materialId.value
      })
    );
    if (!material) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
    const result = await buildPreviewResult(
      material,
      mode.value as PreviewMode,
      (value, binding) => issueGrant(configured.service, value, userId, binding),
      { rangeEndpoint: rangeEndpoint(request) }
    );
    return successResponse(result, cors);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
