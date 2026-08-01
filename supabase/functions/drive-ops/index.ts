import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  AGENT_INTAKE_MAX_BYTES,
  MATERIAL_CLASSIFIER_VERSION,
  RANGE_REQUEST_MAX_BYTES,
  TEAM_ERROR_CODES,
  TRANSFER_GRANT_TTL_SECONDS,
  UPLOAD_CHUNK_MULTIPLE_BYTES,
  classifyMaterial,
  type MaterialCategory,
  type TeamErrorCode,
  type TeamTransferGrant
} from '../../../packages/shared/dist/types.js';
import { authorizeCaller, type OAuthProductionSignals } from '../_shared/auth.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import {
  readDriveCredential,
  refreshGoogleAccessToken,
  type ServiceRpcClient
} from '../_shared/credentials.ts';
import {
  GoogleDriveClient,
  proveLiveAncestry,
  requireDriveCapability,
  type DriveFileMetadata
} from '../_shared/drive.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import {
  issueTransferGrant,
  startOperation,
  transitionOperation,
  type OperationAuthority
} from '../_shared/operations.ts';
import {
  isRecord,
  parseBoundedString,
  parseEnum,
  parseIdempotencyKey,
  parseJsonBody,
  parseUuid
} from '../_shared/validation.ts';
import {
  assertExpectedSourceIdentity,
  assertTextEditEligibility,
  buildUploadConflictPlan,
  displayDriveName,
  normalizeReservedName,
  postconditionForMutation,
  validateLiveMutationTarget,
  validateUploadStartRequest,
  type DriveOperationMaterial,
  type LiveDriveTarget,
  type UploadStartRequest
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

interface MaterialOperationContext extends DriveOperationMaterial {
  category: MaterialCategory | null;
  actorId: string;
  connectionId: string;
  credentialId: string;
  rootFolderId: string;
  rootResourceKey: string | null;
  driveId: string | null;
  resourceKey: string | null;
}

interface OperationContext {
  operationId: string;
  teamId: string;
  actorId: string;
  kind: string;
  state: string;
  sourceMaterialId: string | null;
  destinationFolderId: string | null;
  resultMaterialId: string | null;
  expectedName: string | null;
  mimeType: string | null;
  expectedSize: number | null;
  replaceMaterialId: string | null;
  versionOfMaterialId: string | null;
  relation: string | null;
  toolId: string | null;
  toolContractVersion: number | null;
  providerResultId: string | null;
}

interface ConsumedOperationGrant {
  operationId: string;
  teamId: string;
  actorId: string;
  materialId: string | null;
  destinationFolderId: string | null;
  toolId: string | null;
  maxRangeBytes: number;
}

const TOOL_RULES: Readonly<
  Record<
    string,
    { categories: readonly MaterialCategory[]; contractVersion: number; outputMimeType: string }
  >
> = {
  compressor: { categories: ['video'], contractVersion: 3, outputMimeType: 'video/mp4' },
  transcription: { categories: ['video'], contractVersion: 5, outputMimeType: 'text/plain' },
  landingOptimizer: {
    categories: ['archive', 'landing'],
    contractVersion: 2,
    outputMimeType: 'application/zip'
  },
  imageEmbedding: { categories: ['video'], contractVersion: 2, outputMimeType: 'video/mp4' }
};

function clients(request: Request): { caller: RpcClient; service: RpcClient } {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  const authorization = request.headers.get('authorization') ?? '';
  return {
    caller: createClient(url, anonKey, {
      global: { headers: { authorization } },
      auth: { persistSession: false, autoRefreshToken: false }
    }) as unknown as RpcClient,
    service: createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    }) as unknown as RpcClient
  };
}

function mappedRpcError(error: RpcFailure): TeamFunctionError {
  const candidates = [error.message, error.code]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.match(/[A-Z][A-Z0-9_]+/gu) ?? []);
  const code = candidates.find(candidate =>
    (TEAM_ERROR_CODES as readonly string[]).includes(candidate)
  ) as TeamErrorCode | undefined;
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
  const converted = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof converted === 'number' && Number.isSafeInteger(converted) && converted >= 0
    ? converted
    : null;
}

function requireUuid(value: unknown): string {
  const parsed = parseUuid(value);
  if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  return parsed.value;
}

function requireIdempotency(value: unknown): string {
  const parsed = parseIdempotencyKey(value);
  if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  return parsed.value;
}

function materialContext(value: unknown): MaterialOperationContext | null {
  const row = firstRecord(value);
  if (!row) return null;
  const id = stringValue(row, 'material_id');
  const teamId = stringValue(row, 'team_id');
  const actorId = stringValue(row, 'actor_id');
  const connectionId = stringValue(row, 'connection_id');
  const credentialId = stringValue(row, 'credential_id');
  const rootFolderId = stringValue(row, 'root_folder_id');
  const driveFileId = stringValue(row, 'drive_file_id');
  const name = stringValue(row, 'name');
  const kind = stringValue(row, 'kind');
  const lifecycle = stringValue(row, 'lifecycle');
  const transcriptIngestState = stringValue(row, 'transcript_ingest_state');
  if (
    !id ||
    !teamId ||
    !actorId ||
    !connectionId ||
    !credentialId ||
    !rootFolderId ||
    !driveFileId ||
    !name ||
    !['file', 'folder', 'shortcut'].includes(kind ?? '') ||
    !['active', 'trashed', 'missing'].includes(lifecycle ?? '') ||
    !['not_applicable', 'pending', 'full', 'truncated', 'invalid_encoding', 'unavailable'].includes(
      transcriptIngestState ?? ''
    ) ||
    typeof row.transcript_truncated !== 'boolean'
  ) {
    return null;
  }
  return {
    id,
    teamId,
    actorId,
    connectionId,
    credentialId,
    rootFolderId,
    rootResourceKey: stringValue(row, 'root_resource_key'),
    driveId: stringValue(row, 'drive_id'),
    driveFileId,
    resourceKey: stringValue(row, 'resource_key'),
    parentFolderId: stringValue(row, 'parent_folder_id'),
    name,
    kind: kind as DriveOperationMaterial['kind'],
    lifecycle: lifecycle as DriveOperationMaterial['lifecycle'],
    category: stringValue(row, 'category') as MaterialCategory | null,
    mimeType: stringValue(row, 'mime_type'),
    fileExtension: stringValue(row, 'file_extension'),
    sizeBytes: safeInteger(row.size_bytes),
    driveVersion: stringValue(row, 'drive_version'),
    checksum: stringValue(row, 'checksum'),
    transcriptIngestState: transcriptIngestState as DriveOperationMaterial['transcriptIngestState'],
    transcriptTruncated: row.transcript_truncated
  };
}

function operationContext(value: unknown): OperationContext | null {
  const row = firstRecord(value);
  if (!row) return null;
  const operationId = stringValue(row, 'operation_id');
  const teamId = stringValue(row, 'team_id');
  const actorId = stringValue(row, 'actor_id');
  const kind = stringValue(row, 'kind');
  const state = stringValue(row, 'state');
  if (!operationId || !teamId || !actorId || !kind || !state) return null;
  return {
    operationId,
    teamId,
    actorId,
    kind,
    state,
    sourceMaterialId: stringValue(row, 'source_material_id'),
    destinationFolderId: stringValue(row, 'destination_folder_id'),
    resultMaterialId: stringValue(row, 'result_material_id'),
    expectedName: stringValue(row, 'expected_name'),
    mimeType: stringValue(row, 'mime_type'),
    expectedSize: row.expected_size === null ? null : safeInteger(row.expected_size),
    replaceMaterialId: stringValue(row, 'replace_material_id'),
    versionOfMaterialId: stringValue(row, 'version_of_material_id'),
    relation: stringValue(row, 'relation'),
    toolId: stringValue(row, 'tool_id'),
    toolContractVersion:
      row.tool_contract_version === null ? null : safeInteger(row.tool_contract_version),
    providerResultId: stringValue(row, 'provider_result_id')
  };
}

function consumedGrant(value: unknown): ConsumedOperationGrant | null {
  const row = firstRecord(value);
  if (!row) return null;
  const operationId = stringValue(row, 'operation_id');
  const teamId = stringValue(row, 'team_id');
  const actorId = stringValue(row, 'actor_id');
  const maxRangeBytes = safeInteger(row.max_range_bytes);
  if (!operationId || !teamId || !actorId || maxRangeBytes === null) return null;
  return {
    operationId,
    teamId,
    actorId,
    materialId: stringValue(row, 'material_id'),
    destinationFolderId: stringValue(row, 'destination_folder_id'),
    toolId: stringValue(row, 'tool_id'),
    maxRangeBytes
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

async function loadContext(input: {
  service: RpcClient;
  teamId: string;
  materialId: string;
  actorId: string;
  permission: string;
  allowTrashed?: boolean;
}): Promise<MaterialOperationContext> {
  const context = materialContext(
    await rpcValue(input.service, 'service_get_material_operation_context', {
      p_team: input.teamId,
      p_material: input.materialId,
      p_actor: input.actorId,
      p_permission: input.permission,
      p_allow_trashed: input.allowTrashed ?? false
    })
  );
  if (!context) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  return context;
}

function liveTarget(metadata: DriveFileMetadata): LiveDriveTarget {
  return {
    id: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    parents: metadata.parents,
    trashed: metadata.trashed,
    shortcutTargetId: metadata.shortcutTargetId,
    sizeBytes: metadata.size,
    driveVersion: metadata.version,
    checksum: metadata.checksum,
    capabilities: metadata.capabilities
  };
}

async function proveContext(
  context: MaterialOperationContext,
  client: GoogleDriveClient,
  allowTrashedTarget = false
) {
  return proveLiveAncestry({
    client,
    fileId: context.driveFileId,
    rootFolderId: context.rootFolderId,
    resourceKey: context.resourceKey,
    allowTrashedTarget
  });
}

function requestNonce(idempotencyKey: string): string {
  return `request:${idempotencyKey}`;
}

function operationRecord(authority: OperationAuthority) {
  return { operationId: authority.operationId, state: authority.state, reused: authority.reused };
}

function extensionOf(name: string): string | null {
  const leaf = name.split('/').at(-1) ?? name;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1).toLocaleLowerCase('en-US') : null;
}

function driveResult(metadata: DriveFileMetadata) {
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
    classificationVersion: MATERIAL_CLASSIFIER_VERSION,
    sizeBytes: metadata.size,
    modifiedAt: metadata.modifiedAt,
    driveVersion: metadata.version,
    checksum: metadata.checksum
  };
}

async function nameCandidates(
  client: GoogleDriveClient,
  destination: DriveFileMetadata,
  maximumPages = 10
): Promise<Array<{ materialId: string; name: string }>> {
  const output: Array<{ materialId: string; name: string }> = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maximumPages; page += 1) {
    const result = await client.listChildren({
      parentId: destination.id,
      pageToken,
      driveId: destination.driveId
    });
    output.push(...result.files.map(file => ({ materialId: file.id, name: file.name })));
    pageToken = result.nextPageToken;
    if (!pageToken) return output;
  }
  throw new TeamFunctionError('RATE_LIMITED', { retryable: true });
}

async function exactCatalogConflicts(input: {
  service: RpcClient;
  teamId: string;
  destinationFolderId: string;
  actorId: string;
  name: string;
}) {
  const value = await rpcValue(input.service, 'service_find_team_name_conflicts', {
    p_team: input.teamId,
    p_destination_folder: input.destinationFolderId,
    p_actor: input.actorId,
    p_reserved_name_key: normalizeReservedName(input.name)
  });
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    if (!isRecord(row)) return [];
    const materialId = stringValue(row, 'material_id');
    const name = stringValue(row, 'name');
    const driveFileId = stringValue(row, 'drive_file_id');
    return materialId && name && driveFileId ? [{ materialId, name, driveFileId }] : [];
  });
}

async function bindIntent(input: {
  service: RpcClient;
  authority: OperationAuthority;
  actorId: string;
  expectedName: string | null;
  mimeType: string | null;
  expectedSize: number | null;
  replaceMaterialId?: string | null;
  versionOfMaterialId?: string | null;
  toolId?: string | null;
  toolContractVersion?: number | null;
}) {
  await rpcValue(input.service, 'service_set_team_operation_intent', {
    p_operation: input.authority.operationId,
    p_actor: input.actorId,
    p_expected_name: input.expectedName,
    p_mime_type: input.mimeType,
    p_expected_size: input.expectedSize,
    p_replace_material: input.replaceMaterialId ?? null,
    p_version_of_material: input.versionOfMaterialId ?? null,
    p_tool: input.toolId ?? null,
    p_tool_contract_version: input.toolContractVersion ?? null
  });
}

async function bindSource(
  service: RpcClient,
  operationId: string,
  actorId: string,
  source: DriveFileMetadata
) {
  await rpcValue(service, 'service_bind_team_operation_source', {
    p_operation: operationId,
    p_actor: actorId,
    p_drive_file_id: source.id,
    p_drive_version: source.version,
    p_checksum: source.checksum
  });
}

function relayEndpoint(request: Request, operationId: string) {
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/uploads\/start.*$/u, '').replace(/\/$/u, '')}/uploads/${operationId}/relay`;
  return url.toString();
}

function rangeEndpoint(request: Request) {
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/drive-ops(?:\/.*)?$/u, '/drive-transfer/range');
  return url.toString();
}

async function handleUploadStart(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient,
  actorId: string
) {
  const upload = validateUploadStartRequest(body);
  const destination = await loadContext({
    service,
    teamId: upload.teamId,
    materialId: upload.destinationFolderId,
    actorId,
    permission: 'upload'
  });
  const destinationDrive = await driveClient(service, destination.credentialId, request);
  const liveDestination = await proveContext(destination, destinationDrive);
  if (liveDestination.mimeType !== 'application/vnd.google-apps.folder') {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  requireDriveCapability(liveDestination, 'canAddChildren');

  const liveNames = await nameCandidates(destinationDrive, liveDestination);
  const catalogConflicts = await exactCatalogConflicts({
    service,
    teamId: upload.teamId,
    destinationFolderId: upload.destinationFolderId,
    actorId,
    name: upload.name
  });
  const exactByProvider = new Map(catalogConflicts.map(item => [item.driveFileId, item]));
  const conflicts = liveNames.map(item => ({
    materialId: exactByProvider.get(item.materialId)?.materialId ?? item.materialId,
    name: item.name
  }));
  const plan = buildUploadConflictPlan(upload, conflicts);

  let replacement: { context: MaterialOperationContext; live: DriveFileMetadata } | null = null;
  if (plan.replaceMaterialId) {
    const context = await loadContext({
      service,
      teamId: upload.teamId,
      materialId: plan.replaceMaterialId,
      actorId,
      permission: 'edit'
    });
    const client =
      context.credentialId === destination.credentialId
        ? destinationDrive
        : await driveClient(service, context.credentialId, request);
    const live = await proveContext(context, client);
    requireDriveCapability(live, 'canModifyContent');
    if (!live.parents.includes(liveDestination.id)) {
      throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
    }
    replacement = { context, live };
  }

  let versionSource: { context: MaterialOperationContext; live: DriveFileMetadata } | null = null;
  if (upload.versionOfMaterialId) {
    const context = await loadContext({
      service,
      teamId: upload.teamId,
      materialId: upload.versionOfMaterialId,
      actorId,
      permission: 'view'
    });
    const client =
      context.credentialId === destination.credentialId
        ? destinationDrive
        : await driveClient(service, context.credentialId, request);
    const live = await proveContext(context, client);
    if (live.id === replacement?.live.id) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    versionSource = { context, live };
  }

  const kind = upload.versionOfMaterialId ? 'new_version' : 'upload';
  const authority = await startOperation({
    service,
    teamId: upload.teamId,
    actorId,
    kind,
    idempotencyKey: upload.idempotencyKey,
    requestNonce: requestNonce(upload.idempotencyKey),
    sourceMaterialId: upload.versionOfMaterialId,
    destinationFolderId: upload.destinationFolderId,
    reservedNameKey: plan.reservationKey,
    reservationExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    bytesTotal: upload.sizeBytes
  });
  await bindIntent({
    service,
    authority,
    actorId,
    expectedName: plan.name,
    mimeType: upload.mimeType,
    expectedSize: upload.sizeBytes,
    replaceMaterialId: plan.replaceMaterialId,
    versionOfMaterialId: upload.versionOfMaterialId
  });
  if (versionSource) {
    await bindSource(service, authority.operationId, actorId, versionSource.live);
  }
  if (authority.reused) {
    if (!['pending', 'running'].includes(authority.state)) {
      throw new TeamFunctionError('WRONG_STATE', { retryable: false });
    }
    return {
      operationId: authority.operationId,
      state: authority.state,
      sessionUri: null,
      sessionUnavailable: true,
      name: plan.name,
      chunkMultiple: UPLOAD_CHUNK_MULTIPLE_BYTES,
      expiresAt: null,
      relayUrl: relayEndpoint(request, authority.operationId)
    };
  }
  try {
    const session = await destinationDrive.startResumableUpload({
      name: plan.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      parentId: liveDestination.id,
      existingFileId: replacement?.live.id
    });
    await transitionOperation({
      service,
      operationId: authority.operationId,
      state: 'running',
      stage: 'uploading',
      progress: 0
    });
    return {
      operationId: authority.operationId,
      state: 'running',
      sessionUri: session.sessionUri,
      sessionUnavailable: false,
      name: plan.name,
      chunkMultiple: UPLOAD_CHUNK_MULTIPLE_BYTES,
      expiresAt: session.expiresAt,
      relayUrl: relayEndpoint(request, authority.operationId)
    };
  } catch (error) {
    await transitionOperation({
      service,
      operationId: authority.operationId,
      state: 'failed',
      stage: 'upload_start',
      progress: 0,
      errorCode: error instanceof TeamFunctionError ? error.code : 'DRIVE_UNAVAILABLE',
      retryable: error instanceof TeamFunctionError ? error.retryable : true
    }).catch(() => undefined);
    throw error;
  }
}

async function getOperation(service: RpcClient, operationId: string, actorId: string) {
  const operation = operationContext(
    await rpcValue(service, 'service_get_team_operation', {
      p_operation: operationId,
      p_actor: actorId
    })
  );
  if (!operation) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  return operation;
}

async function verifyBoundSource(
  service: RpcClient,
  operation: OperationContext,
  request: Request
) {
  if (!operation.sourceMaterialId) return;
  const binding = firstRecord(
    await rpcValue(service, 'service_get_team_operation_source_binding', {
      p_operation: operation.operationId,
      p_actor: operation.actorId
    })
  );
  if (!binding) return;
  const context = await loadContext({
    service,
    teamId: operation.teamId,
    materialId: operation.sourceMaterialId,
    actorId: operation.actorId,
    permission: operation.kind === 'process' ? 'process' : 'view'
  });
  const client = await driveClient(service, context.credentialId, request);
  const live = await proveContext(context, client);
  assertExpectedSourceIdentity(liveTarget(live), {
    driveFileId: stringValue(binding, 'drive_file_id') ?? context.driveFileId,
    driveVersion: stringValue(binding, 'drive_version') ?? context.driveVersion ?? '',
    checksum: stringValue(binding, 'checksum') ?? undefined
  });
}

async function handleUploadFinalize(
  request: Request,
  operationId: string,
  body: Record<string, unknown>,
  service: RpcClient,
  actorId: string
) {
  requireIdempotency(body.idempotencyKey);
  const driveFileId = parseBoundedString(body.driveFileId, 1, 1024);
  if (!driveFileId.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  const operation = await getOperation(service, operationId, actorId);
  if (!['upload', 'new_version', 'process'].includes(operation.kind)) {
    throw new TeamFunctionError('WRONG_STATE', { retryable: false });
  }
  if (operation.state === 'succeeded') {
    return {
      operationId,
      state: 'succeeded',
      materialId: operation.resultMaterialId,
      reused: true
    };
  }
  if (!operation.destinationFolderId || !operation.expectedName) {
    throw new TeamFunctionError('WRONG_STATE', { retryable: false });
  }
  const destination = await loadContext({
    service,
    teamId: operation.teamId,
    materialId: operation.destinationFolderId,
    actorId,
    permission: operation.kind === 'process' ? 'process' : 'upload'
  });
  const client = await driveClient(service, destination.credentialId, request);
  const liveDestination = await proveContext(destination, client);
  requireDriveCapability(liveDestination, 'canAddChildren');
  const result = await proveLiveAncestry({
    client,
    fileId: driveFileId.value,
    rootFolderId: destination.rootFolderId
  });
  if (
    !result.parents.includes(liveDestination.id) ||
    result.name !== operation.expectedName ||
    result.mimeType !== operation.mimeType ||
    result.size !== operation.expectedSize ||
    (operation.replaceMaterialId && result.id !== driveFileId.value)
  ) {
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  }
  await verifyBoundSource(service, operation, request);
  try {
    const committed = await rpcValue(service, 'service_finalize_uploaded_material', {
      p_operation: operationId,
      p_actor: actorId,
      p_drive: driveResult(result)
    });
    if (!isRecord(committed)) {
      throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
    }
    return committed;
  } catch (error) {
    await transitionOperation({
      service,
      operationId,
      state: 'running',
      stage: 'reconcile_required',
      progress: 95
    }).catch(() => undefined);
    throw error;
  }
}

function parseMutationBody(body: Record<string, unknown>) {
  return {
    teamId: requireUuid(body.teamId),
    materialId: requireUuid(body.materialId),
    idempotencyKey: requireIdempotency(body.idempotencyKey)
  };
}

async function startSimpleOperation(input: {
  service: RpcClient;
  teamId: string;
  actorId: string;
  kind: 'rename' | 'move' | 'trash' | 'restore' | 'content_edit';
  idempotencyKey: string;
  sourceMaterialId: string;
  destinationFolderId?: string | null;
  reservedNameKey?: string | null;
  bytesTotal?: number | null;
}) {
  return startOperation({
    service: input.service,
    teamId: input.teamId,
    actorId: input.actorId,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    requestNonce: requestNonce(input.idempotencyKey),
    sourceMaterialId: input.sourceMaterialId,
    destinationFolderId: input.destinationFolderId,
    reservedNameKey: input.reservedNameKey,
    reservationExpiresAt: input.reservedNameKey
      ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
      : null,
    bytesTotal: input.bytesTotal
  });
}

async function handleRename(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient,
  actorId: string
) {
  const common = parseMutationBody(body);
  const newName = displayDriveName(body.newName);
  const conflictMode = parseEnum(body.conflictMode, ['cancel', 'keep_both'] as const);
  if (!conflictMode.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  const source = await loadContext({
    service,
    teamId: common.teamId,
    materialId: common.materialId,
    actorId,
    permission: 'edit'
  });
  if (!source.parentFolderId) throw new TeamFunctionError('ROOT_ESCAPE', { retryable: false });
  const folder = firstRecord(
    await rpcValue(service, 'service_resolve_team_folder', {
      p_team: common.teamId,
      p_actor: actorId,
      p_drive_folder_id: source.parentFolderId,
      p_permission: 'edit'
    })
  );
  const folderId = folder ? stringValue(folder, 'material_id') : null;
  if (!folderId) throw new TeamFunctionError('ROOT_ESCAPE', { retryable: false });
  const client = await driveClient(service, source.credentialId, request);
  const live = await proveContext(source, client);
  validateLiveMutationTarget({
    action: 'rename',
    target: liveTarget(live),
    rootFolderId: source.rootFolderId,
    ancestryProven: true
  });
  const liveParent = await client.getFile(source.parentFolderId);
  const names = await nameCandidates(client, liveParent);
  const fakeUpload: UploadStartRequest = {
    teamId: common.teamId,
    destinationFolderId: folderId,
    name: newName,
    mimeType: source.mimeType ?? 'application/octet-stream',
    sizeBytes: source.sizeBytes ?? 0,
    conflictMode: conflictMode.value,
    replaceMaterialId: null,
    versionOfMaterialId: null,
    idempotencyKey: common.idempotencyKey
  };
  const plan = buildUploadConflictPlan(fakeUpload, names);
  const authority = await startSimpleOperation({
    service,
    teamId: common.teamId,
    actorId,
    kind: 'rename',
    idempotencyKey: common.idempotencyKey,
    sourceMaterialId: common.materialId,
    destinationFolderId: folderId,
    reservedNameKey: plan.reservationKey
  });
  await bindIntent({
    service,
    authority,
    actorId,
    expectedName: plan.name,
    mimeType: null,
    expectedSize: null
  });
  if (authority.reused) return operationRecord(authority);
  await transitionOperation({
    service,
    operationId: authority.operationId,
    state: 'running',
    stage: 'renaming',
    progress: 25
  });
  const updated = await client.updateFileMetadata({
    fileId: live.id,
    resourceKey: live.resourceKey,
    name: plan.name
  });
  postconditionForMutation('rename', liveTarget(updated), { name: plan.name });
  return rpcValue(service, 'service_commit_team_material_mutation', {
    p_operation: authority.operationId,
    p_actor: actorId,
    p_drive: { ...driveResult(updated), trashed: updated.trashed }
  });
}

async function destinationWithClient(input: {
  request: Request;
  service: RpcClient;
  teamId: string;
  destinationFolderId: string;
  actorId: string;
  permission: 'edit' | 'upload' | 'process' | 'delete';
}) {
  const context = await loadContext({
    service: input.service,
    teamId: input.teamId,
    materialId: input.destinationFolderId,
    actorId: input.actorId,
    permission: input.permission
  });
  const client = await driveClient(input.service, context.credentialId, input.request);
  const live = await proveContext(context, client);
  if (live.mimeType !== 'application/vnd.google-apps.folder') {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  requireDriveCapability(live, 'canAddChildren');
  return { context, client, live };
}

async function handleMove(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient,
  actorId: string
) {
  const common = parseMutationBody(body);
  const destinationFolderId = requireUuid(body.destinationFolderId);
  const conflictMode = parseEnum(body.conflictMode, ['cancel', 'keep_both'] as const);
  if (!conflictMode.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  const source = await loadContext({
    service,
    teamId: common.teamId,
    materialId: common.materialId,
    actorId,
    permission: 'edit'
  });
  const sourceClient = await driveClient(service, source.credentialId, request);
  const liveSource = await proveContext(source, sourceClient);
  const destination = await destinationWithClient({
    request,
    service,
    teamId: common.teamId,
    destinationFolderId,
    actorId,
    permission: 'edit'
  });
  if (
    liveSource.driveId === destination.live.driveId
      ? !liveSource.capabilities.canMoveItemWithinDrive
      : !liveSource.capabilities.canMoveItemOutOfDrive
  ) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  const names = await nameCandidates(destination.client, destination.live);
  const plan = buildUploadConflictPlan(
    {
      teamId: common.teamId,
      destinationFolderId,
      name: source.name,
      mimeType: source.mimeType ?? 'application/octet-stream',
      sizeBytes: source.sizeBytes ?? 0,
      conflictMode: conflictMode.value,
      replaceMaterialId: null,
      versionOfMaterialId: null,
      idempotencyKey: common.idempotencyKey
    },
    names
  );
  const authority = await startSimpleOperation({
    service,
    teamId: common.teamId,
    actorId,
    kind: 'move',
    idempotencyKey: common.idempotencyKey,
    sourceMaterialId: common.materialId,
    destinationFolderId,
    reservedNameKey: plan.reservationKey
  });
  await bindIntent({
    service,
    authority,
    actorId,
    expectedName: plan.name,
    mimeType: null,
    expectedSize: null
  });
  if (authority.reused) return operationRecord(authority);
  await transitionOperation({
    service,
    operationId: authority.operationId,
    state: 'running',
    stage: 'moving',
    progress: 25
  });
  const updated = await sourceClient.updateFileMetadata({
    fileId: liveSource.id,
    resourceKey: liveSource.resourceKey,
    ...(plan.name !== source.name ? { name: plan.name } : {}),
    addParentId: destination.live.id,
    removeParentIds: liveSource.parents
  });
  postconditionForMutation('move', liveTarget(updated), { parentId: destination.live.id });
  return rpcValue(service, 'service_commit_team_material_mutation', {
    p_operation: authority.operationId,
    p_actor: actorId,
    p_drive: { ...driveResult(updated), trashed: updated.trashed }
  });
}

async function handleTrashRestore(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient,
  actorId: string,
  action: 'trash' | 'restore'
) {
  const common = parseMutationBody(body);
  if (action === 'trash' && body.confirmed !== true) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const source = await loadContext({
    service,
    teamId: common.teamId,
    materialId: common.materialId,
    actorId,
    permission: 'delete',
    allowTrashed: action === 'restore'
  });
  const client = await driveClient(service, source.credentialId, request);
  const live = await proveContext(source, client, action === 'restore');
  validateLiveMutationTarget({
    action,
    target: liveTarget(live),
    rootFolderId: source.rootFolderId,
    ancestryProven: true
  });
  let destinationFolderId: string | null = null;
  let destination: Awaited<ReturnType<typeof destinationWithClient>> | null = null;
  if (action === 'restore' && body.destinationFolderId !== undefined) {
    destinationFolderId = requireUuid(body.destinationFolderId);
    destination = await destinationWithClient({
      request,
      service,
      teamId: common.teamId,
      destinationFolderId,
      actorId,
      permission: 'delete'
    });
  }
  const authority = await startSimpleOperation({
    service,
    teamId: common.teamId,
    actorId,
    kind: action,
    idempotencyKey: common.idempotencyKey,
    sourceMaterialId: common.materialId,
    destinationFolderId
  });
  if (authority.reused) return operationRecord(authority);
  await transitionOperation({
    service,
    operationId: authority.operationId,
    state: 'running',
    stage: action === 'trash' ? 'trashing' : 'restoring',
    progress: 25
  });
  const updated = await client.updateFileMetadata({
    fileId: live.id,
    resourceKey: live.resourceKey,
    trashed: action === 'trash',
    ...(destination ? { addParentId: destination.live.id, removeParentIds: live.parents } : {})
  });
  postconditionForMutation(action, liveTarget(updated), {});
  return rpcValue(service, 'service_commit_team_material_mutation', {
    p_operation: authority.operationId,
    p_actor: actorId,
    p_drive: { ...driveResult(updated), trashed: updated.trashed }
  });
}

async function handleTextEdit(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient,
  actorId: string
) {
  const common = parseMutationBody(body);
  const text = body.text;
  const expectedDriveVersion = parseBoundedString(body.expectedDriveVersion, 1, 256);
  const expectedChecksum =
    body.expectedChecksum === undefined || body.expectedChecksum === null
      ? null
      : parseBoundedString(body.expectedChecksum, 1, 256);
  if (
    typeof text !== 'string' ||
    !expectedDriveVersion.ok ||
    (expectedChecksum !== null && !expectedChecksum.ok)
  ) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  await loadContext({
    service,
    teamId: common.teamId,
    materialId: common.materialId,
    actorId,
    permission: 'view'
  });
  const source = await loadContext({
    service,
    teamId: common.teamId,
    materialId: common.materialId,
    actorId,
    permission: 'edit'
  });
  const sizeBytes = assertTextEditEligibility(source, text);
  const client = await driveClient(service, source.credentialId, request);
  const live = await proveContext(source, client);
  validateLiveMutationTarget({
    action: 'text_edit',
    target: liveTarget(live),
    rootFolderId: source.rootFolderId,
    ancestryProven: true
  });
  assertExpectedSourceIdentity(liveTarget(live), {
    driveFileId: source.driveFileId,
    driveVersion: expectedDriveVersion.value,
    checksum: expectedChecksum?.ok ? expectedChecksum.value : undefined
  });
  const authority = await startSimpleOperation({
    service,
    teamId: common.teamId,
    actorId,
    kind: 'content_edit',
    idempotencyKey: common.idempotencyKey,
    sourceMaterialId: common.materialId,
    bytesTotal: sizeBytes
  });
  if (authority.reused) return operationRecord(authority);
  await transitionOperation({
    service,
    operationId: authority.operationId,
    state: 'running',
    stage: 'writing',
    progress: 25
  });
  const updated = await client.updateSmallFileContent({
    fileId: live.id,
    resourceKey: live.resourceKey,
    mimeType: 'text/plain; charset=utf-8',
    bytes: new TextEncoder().encode(text)
  });
  postconditionForMutation('text_edit', liveTarget(updated), {
    previousVersion: live.version ?? expectedDriveVersion.value
  });
  return rpcValue(service, 'service_commit_team_text_edit', {
    p_operation: authority.operationId,
    p_actor: actorId,
    p_expected_version: expectedDriveVersion.value,
    p_expected_checksum: expectedChecksum?.ok ? expectedChecksum.value : null,
    p_new_version: updated.version,
    p_new_checksum: updated.checksum,
    p_text: text,
    p_size_bytes: sizeBytes
  });
}

function randomTicket(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function operationGrant(input: {
  service: RpcClient;
  purpose: 'process_input' | 'finalize';
  operationId: string;
  teamId: string;
  actorId: string;
  materialId: string | null;
  destinationFolderId: string | null;
  toolId: string;
  maxUses: number;
}): Promise<TeamTransferGrant> {
  const ticket = randomTicket();
  const expiresAt = new Date(Date.now() + TRANSFER_GRANT_TTL_SECONDS * 1000).toISOString();
  await issueTransferGrant({
    service: input.service,
    token: ticket,
    operationId: input.operationId,
    teamId: input.teamId,
    actorId: input.actorId,
    purpose: input.purpose,
    materialId: input.materialId,
    destinationFolderId: input.destinationFolderId,
    toolId: input.toolId,
    maxRangeBytes: RANGE_REQUEST_MAX_BYTES,
    expiresAt,
    maxUses: input.maxUses
  });
  return {
    ticket,
    purpose: input.purpose,
    expiresAt,
    maxRangeBytes: RANGE_REQUEST_MAX_BYTES,
    maxUses: input.maxUses
  };
}

async function handleProcessStart(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient,
  actorId: string
) {
  const teamId = requireUuid(body.teamId);
  const materialId = requireUuid(body.materialId);
  const destinationFolderId = requireUuid(body.destinationFolderId);
  const idempotencyKey = requireIdempotency(body.idempotencyKey);
  const toolId = typeof body.toolId === 'string' ? body.toolId : '';
  const tool = TOOL_RULES[toolId];
  const outputName = displayDriveName(body.outputName);
  const conflictMode = parseEnum(body.conflictMode, ['cancel', 'keep_both'] as const);
  const agentContractVersion = safeInteger(body.agentContractVersion);
  const toolContractVersion = safeInteger(body.toolContractVersion);
  if (
    !tool ||
    !conflictMode.ok ||
    agentContractVersion === null ||
    agentContractVersion < 1 ||
    toolContractVersion === null ||
    toolContractVersion < tool.contractVersion ||
    (body.optionsSummary !== undefined && !isRecord(body.optionsSummary))
  ) {
    throw new TeamFunctionError(
      tool && agentContractVersion !== null ? 'AGENT_UPDATE_REQUIRED' : 'INVALID_INPUT',
      { retryable: false }
    );
  }
  const source = await loadContext({
    service,
    teamId,
    materialId,
    actorId,
    permission: 'process'
  });
  if (!source.category || !tool.categories.includes(source.category)) {
    throw new TeamFunctionError('UNSUPPORTED_MEDIA', { retryable: false });
  }
  if (source.sizeBytes === null || source.sizeBytes > AGENT_INTAKE_MAX_BYTES) {
    throw new TeamFunctionError('TOO_LARGE', { retryable: false });
  }
  const sourceClient = await driveClient(service, source.credentialId, request);
  const liveSource = await proveContext(source, sourceClient);
  requireDriveCapability(liveSource, 'canDownload');
  const destination = await destinationWithClient({
    request,
    service,
    teamId,
    destinationFolderId,
    actorId,
    permission: 'process'
  });
  const names = await nameCandidates(destination.client, destination.live);
  const plan = buildUploadConflictPlan(
    {
      teamId,
      destinationFolderId,
      name: outputName,
      mimeType: tool.outputMimeType,
      sizeBytes: 0,
      conflictMode: conflictMode.value,
      replaceMaterialId: null,
      versionOfMaterialId: null,
      idempotencyKey
    },
    names
  );
  const authority = await startOperation({
    service,
    teamId,
    actorId,
    kind: 'process',
    idempotencyKey,
    requestNonce: requestNonce(idempotencyKey),
    sourceMaterialId: materialId,
    destinationFolderId,
    reservedNameKey: plan.reservationKey,
    reservationExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    bytesTotal: source.sizeBytes
  });
  await bindIntent({
    service,
    authority,
    actorId,
    expectedName: plan.name,
    mimeType: tool.outputMimeType,
    expectedSize: null,
    toolId,
    toolContractVersion
  });
  await bindSource(service, authority.operationId, actorId, liveSource);
  if (authority.reused) {
    throw new TeamFunctionError('WRONG_STATE', { retryable: false });
  }
  await transitionOperation({
    service,
    operationId: authority.operationId,
    state: 'running',
    stage: 'awaiting_agent',
    progress: 0
  });
  const ranges = Math.ceil((liveSource.size ?? source.sizeBytes) / RANGE_REQUEST_MAX_BYTES) + 8;
  const [sourceGrant, finalizeGrant] = await Promise.all([
    operationGrant({
      service,
      purpose: 'process_input',
      operationId: authority.operationId,
      teamId,
      actorId,
      materialId,
      destinationFolderId,
      toolId,
      maxUses: Math.min(Math.max(ranges, 1), 10_000)
    }),
    operationGrant({
      service,
      purpose: 'finalize',
      operationId: authority.operationId,
      teamId,
      actorId,
      materialId,
      destinationFolderId,
      toolId,
      maxUses: 2
    })
  ]);
  return {
    operationId: authority.operationId,
    state: 'running',
    sourceGrant,
    finalizeGrant,
    agentContractVersion: 1
  };
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function byteaHex(value: Uint8Array): string {
  return `\\x${[...value].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function consumeOperationGrant(service: RpcClient, ticket: unknown, purpose: 'finalize') {
  if (typeof ticket !== 'string' || ticket.length < 32 || ticket.length > 2048) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  const grant = consumedGrant(
    await rpcValue(service, 'consume_team_transfer_grant', {
      p_token_hash: byteaHex(await sha256(ticket)),
      p_purpose: purpose
    })
  );
  if (!grant) throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  return grant;
}

async function handleProcessOutputStart(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient
) {
  const operationId = requireUuid(body.operationId);
  const sizeBytes = safeInteger(body.sizeBytes);
  if (sizeBytes === null) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  const grant = await consumeOperationGrant(service, body.ticket, 'finalize');
  if (grant.operationId !== operationId || !grant.destinationFolderId || !grant.toolId) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  const operation = await getOperation(service, operationId, grant.actorId);
  if (
    operation.kind !== 'process' ||
    operation.state !== 'running' ||
    operation.destinationFolderId !== grant.destinationFolderId ||
    operation.toolId !== grant.toolId ||
    !operation.expectedName ||
    !operation.mimeType
  ) {
    throw new TeamFunctionError('WRONG_STATE', { retryable: false });
  }
  const destination = await destinationWithClient({
    request,
    service,
    teamId: operation.teamId,
    destinationFolderId: grant.destinationFolderId,
    actorId: grant.actorId,
    permission: 'process'
  });
  await rpcValue(service, 'service_set_team_operation_intent', {
    p_operation: operationId,
    p_actor: grant.actorId,
    p_expected_name: operation.expectedName,
    p_mime_type: operation.mimeType,
    p_expected_size: sizeBytes,
    p_replace_material: null,
    p_version_of_material: null,
    p_tool: operation.toolId,
    p_tool_contract_version: operation.toolContractVersion
  });
  const session = await destination.client.startResumableUpload({
    name: operation.expectedName,
    mimeType: operation.mimeType,
    sizeBytes,
    parentId: destination.live.id
  });
  await transitionOperation({
    service,
    operationId,
    state: 'running',
    stage: 'uploading',
    progress: 75
  });
  return {
    operationId,
    sessionUri: session.sessionUri,
    expiresAt: session.expiresAt,
    chunkMultiple: UPLOAD_CHUNK_MULTIPLE_BYTES
  };
}

async function handleProcessOutputFinalize(
  request: Request,
  body: Record<string, unknown>,
  service: RpcClient
) {
  const operationId = requireUuid(body.operationId);
  const grant = await consumeOperationGrant(service, body.ticket, 'finalize');
  if (grant.operationId !== operationId) {
    throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
  }
  return handleUploadFinalize(
    request,
    operationId,
    { driveFileId: body.driveFileId, idempotencyKey: `agent:${operationId}` },
    service,
    grant.actorId
  );
}

function parseRelayRange(value: string | null, expectedTotal: number) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value ?? '');
  if (!match) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  const length = end - start + 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    total !== expectedTotal ||
    start < 0 ||
    end < start ||
    end >= total ||
    start % UPLOAD_CHUNK_MULTIPLE_BYTES !== 0 ||
    length > RANGE_REQUEST_MAX_BYTES ||
    (end + 1 < total && length % UPLOAD_CHUNK_MULTIPLE_BYTES !== 0)
  ) {
    throw new TeamFunctionError(length > RANGE_REQUEST_MAX_BYTES ? 'TOO_LARGE' : 'INVALID_INPUT', {
      retryable: false
    });
  }
  return { start, end, total, length };
}

function boundedRequestBody(
  body: ReadableStream<Uint8Array> | null,
  expectedBytes: number
): ReadableStream<Uint8Array> {
  if (!body) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > expectedBytes) {
          throw new TeamFunctionError('TOO_LARGE', { retryable: false });
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== expectedBytes) {
          throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
        }
      }
    })
  );
}

async function handleRelay(
  request: Request,
  operationId: string,
  service: RpcClient,
  actorId: string
) {
  const operation = await getOperation(service, operationId, actorId);
  if (
    !['upload', 'new_version'].includes(operation.kind) ||
    operation.state !== 'running' ||
    operation.expectedSize === null ||
    !operation.destinationFolderId
  ) {
    throw new TeamFunctionError('WRONG_STATE', { retryable: false });
  }
  const sessionUri = request.headers.get('x-wishly-upload-session');
  if (!sessionUri) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  const range = parseRelayRange(request.headers.get('content-range'), operation.expectedSize);
  const declaredLength = safeInteger(request.headers.get('content-length'));
  if (declaredLength !== range.length) {
    throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  }
  const destination = await loadContext({
    service,
    teamId: operation.teamId,
    materialId: operation.destinationFolderId,
    actorId,
    permission: 'upload'
  });
  const client = await driveClient(service, destination.credentialId, request);
  await proveContext(destination, client);
  const response = await client.relayResumableChunk({
    sessionUri,
    contentRange: request.headers.get('content-range') ?? '',
    contentLength: range.length,
    body: boundedRequestBody(request.body, range.length),
    signal: request.signal
  });
  if (response.status === 308) {
    const received = response.headers.get('range');
    return { complete: false, receivedRange: received };
  }
  const payload: unknown = await response.json().catch(() => null);
  const driveFileId = isRecord(payload) ? stringValue(payload, 'id') : null;
  if (!driveFileId) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  return { complete: true, driveFileId };
}

function routePath(url: URL) {
  const marker = '/drive-ops';
  const index = url.pathname.lastIndexOf(marker);
  return index < 0 ? '/' : url.pathname.slice(index + marker.length) || '/';
}

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const browserCors = corsHeadersForRequest(request);
  if (request.headers.has('origin') && !browserCors) return new Response(null, { status: 403 });
  const cors = browserCors ?? {};

  try {
    const url = new URL(request.url);
    const path = routePath(url);
    const configured = clients(request);
    if (request.method !== 'POST') {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }

    if (path === '/process/output/start' || path === '/process/output/finalize') {
      const parsed = await parseJsonBody(request);
      if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
      const value =
        path === '/process/output/start'
          ? await handleProcessOutputStart(request, parsed.value, configured.service)
          : await handleProcessOutputFinalize(request, parsed.value, configured.service);
      return successResponse(value, cors, path.endsWith('/start') ? 202 : 200);
    }

    const { userId } = await authorizeCaller(request, configured.service);
    const relay = /^\/uploads\/([0-9a-f-]{36})\/relay$/iu.exec(path);
    if (relay) {
      const value = await handleRelay(request, requireUuid(relay[1]), configured.service, userId);
      return successResponse(value, cors);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    const body = parsed.value;
    let value: unknown;
    let status = 200;
    const finalize = /^\/uploads\/([0-9a-f-]{36})\/finalize$/iu.exec(path);
    if (path === '/uploads/start') {
      value = await handleUploadStart(request, body, configured.service, userId);
      status = 202;
    } else if (finalize) {
      value = await handleUploadFinalize(
        request,
        requireUuid(finalize[1]),
        body,
        configured.service,
        userId
      );
    } else if (path === '/rename') {
      value = await handleRename(request, body, configured.service, userId);
    } else if (path === '/move') {
      value = await handleMove(request, body, configured.service, userId);
    } else if (path === '/trash') {
      value = await handleTrashRestore(request, body, configured.service, userId, 'trash');
    } else if (path === '/restore') {
      value = await handleTrashRestore(request, body, configured.service, userId, 'restore');
    } else if (path === '/text-edit') {
      value = await handleTextEdit(request, body, configured.service, userId);
    } else if (path === '/process/start') {
      value = await handleProcessStart(request, body, configured.service, userId);
      status = 202;
    } else {
      throw new TeamFunctionError('NOT_FOUND', { retryable: false });
    }
    return successResponse(value, cors, status);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
