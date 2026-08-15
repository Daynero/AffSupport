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
import {
  authorizeCaller,
  requireDriveOAuthGate,
  type CallerAuthClient,
  type OAuthProductionSignals
} from '../_shared/auth.ts';
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
  MAX_LANDING_RENDER_SEGMENTS,
  MAX_PREVIEW_RANGE_BYTES,
  authorizePreviewRange,
  boundedResponseBody,
  buildDownloadGrantResult,
  buildPreviewResult,
  ensureLandingArtifactFolder,
  forwardedRangeHeaders,
  landingArtifactGrantTool,
  parseBoundedRange,
  parseLandingArtifactGrantTool,
  publicEndpointUrl,
  validateUpstreamRangeResponse,
  type PreviewGrantContext,
  type PreviewMaterialRecord,
  type PreviewMode
} from './handler.ts';

const WEBP_MIME_TYPE = 'image/webp';
const LANDING_RENDER_GRANT_TTL_MS = 20 * 60 * 1000;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const THUMBNAIL_CACHE_BUCKET = 'team-thumbnail-cache';
const THUMBNAIL_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
]);

interface RpcFailure {
  code?: string;
  message?: string;
}

interface RpcClient extends ServiceRpcClient, CallerAuthClient {
  rpc: (
    name: string,
    parameters: Record<string, unknown>
  ) => Promise<{ data: unknown; error: RpcFailure | null }>;
}

interface ThumbnailCacheBucket {
  download(path: string): Promise<{ data: Blob | null; error: unknown | null }>;
  upload(
    path: string,
    body: Blob | Uint8Array,
    options: { cacheControl: string; contentType: string; upsert: boolean }
  ): Promise<{ data: unknown; error: unknown | null }>;
}

interface ThumbnailStorage {
  from(bucket: string): ThumbnailCacheBucket;
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

interface LandingRenderArtifact {
  renderId: string;
  artifactRoot: string;
  segmentCount: number;
  sourceVersion: string;
  fingerprint: string;
  preset: string;
}

interface LandingRenderUpload {
  renderId: string;
  preset: string;
  sourceVersion: string;
  sourceChecksum: string | null;
  renderedBy: string;
}

function clients(request: Request): {
  caller: RpcClient;
  service: RpcClient;
  thumbnailStorage: ThumbnailStorage;
} {
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
    service: service as unknown as RpcClient,
    thumbnailStorage: service.storage as unknown as ThumbnailStorage
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

function landingRenderArtifact(value: unknown): LandingRenderArtifact | null {
  const row = firstRecord(value);
  if (!row) return null;
  const renderId = stringValue(row, 'render_id');
  const artifactRoot = stringValue(row, 'artifact_root');
  const sourceVersion = stringValue(row, 'source_version');
  const fingerprint = stringValue(row, 'fingerprint');
  const preset = stringValue(row, 'preset');
  const segmentCount = safeInteger(row.segment_count);
  if (
    !renderId ||
    !parseUuid(renderId).ok ||
    !artifactRoot ||
    !sourceVersion ||
    !fingerprint ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    !preset ||
    segmentCount === null ||
    segmentCount < 1 ||
    segmentCount > MAX_LANDING_RENDER_SEGMENTS
  ) {
    return null;
  }
  return { renderId, artifactRoot, segmentCount, sourceVersion, fingerprint, preset };
}

function landingRenderUpload(value: unknown): LandingRenderUpload | null {
  const row = firstRecord(value);
  if (!row) return null;
  const renderId = stringValue(row, 'render_id');
  const preset = stringValue(row, 'preset');
  const sourceVersion = stringValue(row, 'source_version');
  const renderedBy = stringValue(row, 'rendered_by');
  if (!renderId || !preset || !sourceVersion || !renderedBy) return null;
  return {
    renderId,
    preset,
    sourceVersion,
    sourceChecksum: stringValue(row, 'source_checksum'),
    renderedBy
  };
}

function parseLandingPreset(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_-]{1,64}$/iu.test(value) ? value : null;
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
  const url = publicEndpointUrl(new URL(request.url));
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/range')) url.pathname = `${url.pathname.replace(/\/$/u, '')}/range`;
  return url.toString();
}

function driveTransferEndpoint(request: Request): URL {
  const url = publicEndpointUrl(new URL(request.url));
  const marker = '/drive-transfer';
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 0) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  url.pathname = url.pathname.slice(0, markerIndex + marker.length);
  url.search = '';
  url.hash = '';
  return url;
}

function artifactUploadEndpoint(request: Request): string {
  const url = driveTransferEndpoint(request);
  url.pathname += '/landing-artifacts';
  return url.toString();
}

async function issueLandingArtifactGrant(
  service: RpcClient,
  input: {
    teamId: string;
    materialId: string;
    actorId: string;
    toolId: string;
    maxUses: number;
  }
): Promise<TeamTransferGrant> {
  const ticket = randomTicket();
  const expiresAt = new Date(Date.now() + LANDING_RENDER_GRANT_TTL_MS).toISOString();
  await rpcValue(service, 'issue_team_transfer_grant', {
    p_token_hash: byteaHex(await sha256(ticket)),
    p_operation: null,
    p_team: input.teamId,
    p_actor: input.actorId,
    p_purpose: 'preview_range',
    p_material: input.materialId,
    p_destination: null,
    p_tool: input.toolId,
    p_max_range_bytes: MAX_PREVIEW_RANGE_BYTES,
    p_expires_at: expiresAt,
    p_max_uses: input.maxUses
  });
  return {
    ticket,
    purpose: 'preview_range',
    expiresAt,
    maxRangeBytes: MAX_PREVIEW_RANGE_BYTES,
    maxUses: input.maxUses
  };
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

/**
 * Proxies only the provider-generated still image used in a collection card.
 * It repeats the grant, live-ancestry and Drive-capability checks from the
 * range relay, so the thumbnail never turns into a durable public Drive URL.
 */
function validThumbnail(mimeType: string, contentLength: number): boolean {
  return (
    THUMBNAIL_MIME_TYPES.has(mimeType) &&
    Number.isSafeInteger(contentLength) &&
    contentLength >= 1 &&
    contentLength <= MAX_THUMBNAIL_BYTES
  );
}

async function thumbnailCachePath(
  context: TransferContext,
  sourceVersion: string | null,
  sourceChecksum: string | null
): Promise<string | null> {
  const sourceIdentity =
    sourceVersion ?? sourceChecksum ?? context.driveVersion ?? context.checksum;
  if (!sourceIdentity) return null;
  const digest = byteaHex(
    await sha256(
      `${context.teamId}\u0000${context.materialId}\u0000${sourceIdentity}\u0000${context.mimeType ?? ''}`
    )
  ).slice(2);
  return `${digest.slice(0, 2)}/${digest}.thumbnail`;
}

function thumbnailHeaders(
  mimeType: string,
  contentLength: number,
  cors: Record<string, string>,
  cache: 'hit' | 'miss' | 'bypass'
): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-disposition': 'inline',
    'content-length': String(contentLength),
    'content-type': mimeType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-wishly-thumbnail-cache': cache
  });
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return headers;
}

async function readCachedThumbnail(storage: ThumbnailStorage, path: string) {
  const { data, error } = await storage.from(THUMBNAIL_CACHE_BUCKET).download(path);
  if (error || !data) return null;
  const mimeType = data.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!validThumbnail(mimeType, data.size)) return null;
  return { body: data, mimeType, contentLength: data.size };
}

async function handleThumbnail(
  request: Request,
  service: RpcClient,
  thumbnailStorage: ThumbnailStorage,
  cors: Record<string, string>
) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get('grant') ?? '';
  const grant = await consumeGrant(service, ticket, 'preview_range');
  if (!grant) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  const context = transferContext(
    await rpcValue(service, 'service_get_material_transfer_context', {
      p_team: grant.teamId,
      p_material: grant.materialId,
      p_actor: grant.actorId
    })
  );
  if (!context) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  const drive = await driveClient(service, context.credentialId, request);
  const live = await proveLiveAncestry({
    client: drive,
    fileId: context.driveFileId,
    rootFolderId: context.rootFolderId,
    resourceKey: context.resourceKey
  });
  requireDriveCapability(live, 'canDownload');
  if (
    (!live.mimeType.startsWith('video/') && !live.mimeType.startsWith('image/')) ||
    !live.thumbnailLink
  ) {
    throw new TeamFunctionError('UNSUPPORTED_MEDIA', { retryable: false });
  }
  const cachePath = await thumbnailCachePath(context, live.version, live.checksum);
  if (cachePath) {
    const cached = await readCachedThumbnail(thumbnailStorage, cachePath);
    if (cached) {
      return new Response(cached.body.stream(), {
        status: 200,
        headers: thumbnailHeaders(cached.mimeType, cached.contentLength, cors, 'hit')
      });
    }
  }
  const upstream = await drive.fetchThumbnail({
    thumbnailLink: live.thumbnailLink,
    signal: request.signal
  });
  const mimeType =
    upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  const rawLength = upstream.headers.get('content-length');
  const contentLength = rawLength && /^\d+$/u.test(rawLength) ? Number(rawLength) : Number.NaN;
  if (!validThumbnail(mimeType, contentLength)) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new TeamFunctionError(
      Number.isSafeInteger(contentLength) && contentLength > MAX_THUMBNAIL_BYTES
        ? 'TOO_LARGE'
        : 'INVALID_RESPONSE',
      { retryable: false }
    );
  }
  const body = new Uint8Array(await upstream.arrayBuffer());
  if (body.byteLength !== contentLength) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  if (cachePath) {
    await thumbnailStorage
      .from(THUMBNAIL_CACHE_BUCKET)
      .upload(cachePath, body, {
        cacheControl: '31536000',
        contentType: mimeType,
        upsert: false
      })
      .catch(() => undefined);
  }
  return new Response(body, {
    status: 200,
    headers: thumbnailHeaders(mimeType, contentLength, cors, cachePath ? 'miss' : 'bypass')
  });
}

async function landingUploadContext(
  service: RpcClient,
  grant: PreviewGrantContext,
  renderId: string
): Promise<LandingRenderUpload> {
  const upload = landingRenderUpload(
    await rpcValue(service, 'service_get_landing_render_upload', {
      p_render: renderId,
      p_team: grant.teamId,
      p_material: grant.materialId
    })
  );
  if (!upload || upload.renderedBy !== grant.actorId) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  return upload;
}

async function landingDriveContext(
  request: Request,
  service: RpcClient,
  grant: PreviewGrantContext
): Promise<{ context: TransferContext; drive: GoogleDriveClient }> {
  const context = transferContext(
    await rpcValue(service, 'service_get_material_transfer_context', {
      p_team: grant.teamId,
      p_material: grant.materialId,
      p_actor: grant.actorId
    })
  );
  if (!context) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  const drive = await driveClient(service, context.credentialId, request);
  return { context, drive };
}

async function landingArtifactFolder(input: {
  request: Request;
  service: RpcClient;
  grant: PreviewGrantContext;
  upload: LandingRenderUpload;
  fingerprint: string;
}) {
  const { context, drive } = await landingDriveContext(input.request, input.service, input.grant);
  const root = await drive.getFile(context.rootFolderId, context.rootResourceKey);
  requireDriveCapability(root, 'canListChildren');
  requireDriveCapability(root, 'canAddChildren');
  const folderId = await ensureLandingArtifactFolder(drive, {
    rootFolderId: context.rootFolderId,
    materialId: input.grant.materialId,
    sourceVersion: input.upload.sourceVersion,
    fingerprint: input.fingerprint,
    preset: input.upload.preset
  });
  return { drive, folderId };
}

function landingArtifactRoute(
  pathname: string
):
  | { operationId: string; action: 'upload'; segment: number }
  | { operationId: string; action: 'commit' | 'fail' }
  | null {
  const marker = '/landing-artifacts/';
  const index = pathname.indexOf(marker);
  if (index < 0) return null;
  const parts = pathname.slice(index + marker.length).split('/');
  if (parts.length !== 2 || !parseUuid(parts[0]).ok) return null;
  if (parts[1] === 'commit' || parts[1] === 'fail') {
    return { operationId: parts[0], action: parts[1] };
  }
  if (!/^\d{1,2}$/u.test(parts[1])) return null;
  const segment = Number(parts[1]);
  return segment >= 0 && segment < MAX_LANDING_RENDER_SEGMENTS
    ? { operationId: parts[0], action: 'upload', segment }
    : null;
}

async function authorizeLandingUpload(
  request: Request,
  service: RpcClient,
  route: NonNullable<ReturnType<typeof landingArtifactRoute>>
) {
  const ticket = request.headers.get('x-wishly-transfer-grant') ?? '';
  const grant = await consumeGrant(service, ticket, 'preview_range');
  const binding = parseLandingArtifactGrantTool(grant?.toolId);
  if (
    !grant ||
    !binding ||
    binding.mode !== 'upload' ||
    binding.operationId !== route.operationId
  ) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  const upload = await landingUploadContext(service, grant, binding.renderId);
  return { grant, binding, upload };
}

async function handleLandingArtifactRoute(
  request: Request,
  service: RpcClient,
  route: NonNullable<ReturnType<typeof landingArtifactRoute>>
) {
  const authorized = await authorizeLandingUpload(request, service, route);
  if (route.action === 'fail') {
    const parsed = await parseJsonBody(request);
    const reason = parsed.ok
      ? parseEnum(parsed.value.reason, [
          'unsupported',
          'corrupt',
          'protected',
          'too_large',
          'render_error'
        ] as const)
      : { ok: false as const };
    if (!reason.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    await rpcValue(service, 'service_fail_landing_render', {
      p_render: authorized.binding.renderId,
      p_reason: reason.value
    });
    return successResponse({ failed: true, reason: reason.value });
  }

  if (route.action === 'upload') {
    const fingerprint = request.headers.get('x-wishly-landing-fingerprint');
    const rawLength = request.headers.get('content-length');
    const contentLength = rawLength && /^\d+$/u.test(rawLength) ? Number(rawLength) : Number.NaN;
    if (
      !fingerprint ||
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      request.headers.get('content-type')?.split(';', 1)[0].trim() !== WEBP_MIME_TYPE ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 32 ||
      contentLength > authorized.grant.maxRangeBytes
    ) {
      throw new TeamFunctionError(
        contentLength > authorized.grant.maxRangeBytes ? 'TOO_LARGE' : 'INVALID_INPUT',
        { retryable: false }
      );
    }
    const artifact = await landingArtifactFolder({
      request,
      service,
      grant: authorized.grant,
      upload: authorized.upload,
      fingerprint
    });
    const name = `${route.segment}.webp`;
    const children = await artifact.drive.listChildren({ parentId: artifact.folderId });
    const existing = children.files.find(file => !file.trashed && file.name === name);
    const session = await artifact.drive.startResumableUpload({
      name,
      mimeType: WEBP_MIME_TYPE,
      sizeBytes: contentLength,
      parentId: artifact.folderId,
      existingFileId: existing?.id ?? null
    });
    const upstream = await artifact.drive.relayResumableChunk({
      sessionUri: session.sessionUri,
      contentRange: `bytes 0-${contentLength - 1}/${contentLength}`,
      contentLength,
      body: boundedResponseBody(request.body, contentLength),
      signal: request.signal
    });
    const accepted = upstream.status === 200 || upstream.status === 201;
    await upstream.body?.cancel().catch(() => undefined);
    if (!accepted) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    return successResponse({ uploaded: true, segment: route.segment });
  }

  const parsed = await parseJsonBody(request);
  const fingerprint = parsed.ok ? parsed.value.fingerprint : null;
  const segmentCount = parsed.ok ? safeInteger(parsed.value.segmentCount) : null;
  if (
    typeof fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    segmentCount === null ||
    segmentCount < 1 ||
    segmentCount > MAX_LANDING_RENDER_SEGMENTS
  ) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const artifact = await landingArtifactFolder({
    request,
    service,
    grant: authorized.grant,
    upload: authorized.upload,
    fingerprint
  });
  const children = await artifact.drive.listChildren({ parentId: artifact.folderId });
  const segments = new Map(
    children.files
      .filter(file => !file.trashed && file.mimeType === WEBP_MIME_TYPE)
      .map(file => [file.name, file] as const)
  );
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const file = segments.get(`${segment}.webp`);
    if (!file || file.size === null || file.size < 32 || file.size > MAX_PREVIEW_RANGE_BYTES) {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
  }
  await rpcValue(service, 'service_commit_landing_preview_validation', {
    p_team: authorized.grant.teamId,
    p_material: authorized.grant.materialId,
    p_actor: authorized.grant.actorId,
    p_expected_version: authorized.upload.sourceVersion,
    p_expected_checksum: authorized.upload.sourceChecksum,
    p_fingerprint: fingerprint
  });
  const state = await rpcValue(service, 'service_commit_landing_render', {
    p_render: authorized.binding.renderId,
    p_artifact_root: artifact.folderId,
    p_segment_count: segmentCount,
    p_fingerprint: fingerprint
  });
  if (state !== 'ready') throw new TeamFunctionError('SOURCE_CHANGED', { retryable: true });
  return successResponse({
    renderId: authorized.binding.renderId,
    state: 'ready',
    segmentCount,
    fingerprint
  });
}

async function handleLandingRenderRange(
  request: Request,
  service: RpcClient,
  cors: Record<string, string>
) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get('grant') ?? '';
  const requestedSegment = safeInteger(url.searchParams.get('segment'));
  const grant = await consumeGrant(service, ticket, 'preview_range');
  const binding = parseLandingArtifactGrantTool(grant?.toolId);
  if (
    !grant ||
    !binding ||
    binding.mode !== 'view' ||
    requestedSegment === null ||
    binding.segment !== requestedSegment
  ) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  const artifact = landingRenderArtifact(
    await rpcValue(service, 'service_get_landing_render_artifact_by_id', {
      p_render: binding.renderId,
      p_team: grant.teamId,
      p_material: grant.materialId
    })
  );
  if (!artifact || requestedSegment >= artifact.segmentCount) {
    throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  }
  const { drive } = await landingDriveContext(request, service, grant);
  const children = await drive.listChildren({ parentId: artifact.artifactRoot });
  const file = children.files.find(
    item =>
      !item.trashed &&
      item.name === `${requestedSegment}.webp` &&
      item.mimeType === WEBP_MIME_TYPE &&
      item.parents.includes(artifact.artifactRoot)
  );
  if (!file || file.size === null || file.size < 32 || file.size > MAX_PREVIEW_RANGE_BYTES) {
    throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  }
  requireDriveCapability(file, 'canDownload');
  const range = parseBoundedRange(request.headers.get('range'), file.size, grant.maxRangeBytes);
  const upstream = await drive.fetchFileRange({
    fileId: file.id,
    resourceKey: file.resourceKey,
    start: range.start,
    end: range.end,
    signal: request.signal
  });
  let contentLength: number;
  try {
    contentLength = validateUpstreamRangeResponse(
      upstream.status,
      upstream.headers,
      range,
      file.size
    );
  } catch (error) {
    await upstream.body?.cancel().catch(() => undefined);
    throw error;
  }
  const headers = forwardedRangeHeaders(upstream.headers, WEBP_MIME_TYPE, 'inline');
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(boundedResponseBody(upstream.body, contentLength), {
    status: upstream.status === 206 ? 206 : 200,
    headers
  });
}

async function handleLandingRenderStart(
  request: Request,
  caller: RpcClient,
  service: RpcClient,
  input: Record<string, unknown>,
  cors: Record<string, string>
) {
  const teamId = parseUuid(input.teamId);
  const materialId = parseUuid(input.materialId);
  const preset = parseLandingPreset(input.preset);
  if (!teamId.ok || !materialId.ok || !preset) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const { userId } = await authorizeCaller(request, service);
  requireDriveOAuthGate(productionSignals(request), Deno.env.get('DRIVE_OAUTH_MODE'));
  const material = previewMaterial(
    await rpcValue(caller, 'get_material_preview', {
      p_team: teamId.value,
      p_material: materialId.value
    })
  );
  if (
    !material ||
    (material.category !== 'landing' && material.category !== 'archive') ||
    !material.driveVersion
  ) {
    throw new TeamFunctionError(material ? 'UNSUPPORTED_MEDIA' : 'NOT_FOUND', {
      retryable: false
    });
  }
  const rawRenderId = await rpcValue(service, 'service_start_landing_render', {
    p_team: teamId.value,
    p_material: materialId.value,
    p_actor: userId,
    p_preset: preset,
    p_source_version: material.driveVersion,
    p_source_checksum: material.checksum
  });
  const renderId =
    typeof rawRenderId === 'string' ? parseUuid(rawRenderId) : { ok: false as const };
  if (!renderId.ok) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  const operationId = crypto.randomUUID();
  const [sourceGrant, artifactGrant] = await Promise.all([
    issueGrant(service, material, userId, { mode: 'landing', operationId }),
    issueLandingArtifactGrant(service, {
      teamId: teamId.value,
      materialId: materialId.value,
      actorId: userId,
      toolId: landingArtifactGrantTool({
        mode: 'upload',
        renderId: renderId.value,
        operationId
      }),
      maxUses: MAX_LANDING_RENDER_SEGMENTS + 2
    })
  ]);
  return successResponse(
    {
      operationId,
      renderId: renderId.value,
      teamId: teamId.value,
      materialId: materialId.value,
      preset,
      transferUrl: rangeEndpoint(request),
      artifactUploadUrl: artifactUploadEndpoint(request),
      sourceGrant,
      artifactGrant
    },
    cors
  );
}

async function handleLandingRenderTokens(
  request: Request,
  caller: RpcClient,
  service: RpcClient,
  input: Record<string, unknown>,
  cors: Record<string, string>
) {
  const teamId = parseUuid(input.teamId);
  const preset = parseLandingPreset(input.preset);
  const rawMaterialIds = input.materialIds;
  if (
    !teamId.ok ||
    !preset ||
    !Array.isArray(rawMaterialIds) ||
    rawMaterialIds.length < 1 ||
    rawMaterialIds.length > 50
  ) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const materialIds = [...new Set(rawMaterialIds)].map(value => parseUuid(value));
  if (materialIds.some(value => !value.ok)) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const ids = materialIds.map(value => (value.ok ? value.value : ''));
  const allSegments = input.allSegments === true;
  if (allSegments && ids.length !== 1) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const { userId } = await authorizeCaller(request, service);
  requireDriveOAuthGate(productionSignals(request), Deno.env.get('DRIVE_OAUTH_MODE'));
  const listed = await rpcValue(caller, 'list_landing_renders', {
    p_team: teamId.value,
    p_material_ids: ids,
    p_preset: preset
  });
  const visible = Array.isArray(listed)
    ? listed.filter(
        row =>
          isRecord(row) &&
          row.valid === true &&
          row.render_state === 'ready' &&
          typeof row.material_id === 'string'
      )
    : [];
  const artifacts = await Promise.all(
    visible.map(async row => {
      const materialId = row.material_id as string;
      const artifact = landingRenderArtifact(
        await rpcValue(service, 'service_get_landing_render_artifact', {
          p_team: teamId.value,
          p_material: materialId,
          p_preset: preset
        })
      );
      if (!artifact) return null;
      const tokenCount = allSegments ? artifact.segmentCount : 1;
      const grants = await Promise.all(
        Array.from({ length: tokenCount }, (_, segment) =>
          issueLandingArtifactGrant(service, {
            teamId: teamId.value,
            materialId,
            actorId: userId,
            toolId: landingArtifactGrantTool({
              mode: 'view',
              renderId: artifact.renderId,
              segment
            }),
            maxUses: 8
          })
        )
      );
      return {
        materialId,
        sourceVersion: artifact.sourceVersion,
        fingerprint: artifact.fingerprint,
        preset: artifact.preset,
        segmentCount: artifact.segmentCount,
        artifactToken: grants[0].ticket,
        ...(allSegments ? { segmentTokens: grants.map(grant => grant.ticket) } : {})
      };
    })
  );
  return successResponse(
    {
      artifacts: artifacts.filter(
        (artifact): artifact is NonNullable<typeof artifact> => !!artifact
      )
    },
    cors
  );
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
    if (request.method === 'GET' && url.pathname.endsWith('/render-range')) {
      return await handleLandingRenderRange(request, configured.service, cors);
    }
    if (request.method === 'GET' && url.pathname.endsWith('/thumbnail')) {
      return await handleThumbnail(request, configured.service, configured.thumbnailStorage, cors);
    }
    if (request.method === 'GET' && url.pathname.endsWith('/range')) {
      return await handleRange(request, configured.service, cors);
    }
    if (request.method !== 'POST') {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const artifactRoute = landingArtifactRoute(url.pathname);
    if (artifactRoute) {
      return await handleLandingArtifactRoute(request, configured.service, artifactRoute);
    }
    const parsed = await parseJsonBody(request);
    if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    if (parsed.value.action === 'landing_render_start') {
      return await handleLandingRenderStart(
        request,
        configured.caller,
        configured.service,
        parsed.value,
        cors
      );
    }
    if (parsed.value.action === 'landing_render_tokens') {
      return await handleLandingRenderTokens(
        request,
        configured.caller,
        configured.service,
        parsed.value,
        cors
      );
    }
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
