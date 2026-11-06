import {
  resolveMaterialShare,
  parseShareReservation,
  parseShareStatus
} from './share-resolution.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
// Narrow module imports rather than the `types.js` barrel — see the note in
// drive-ops/index.ts: the barrel drags the whole shared package into this
// function's module graph, and a module it never uses could stop it booting.
import {
  parseLibraryPlacementMutation,
  parseLibraryShareCopyRequest,
  parseUploadBatchRequest,
  type LibraryPlacementMutationRequest,
  type LibraryShareCopyRequest,
  type UploadBatchRequest
} from '../../../packages/shared/dist/team/creative-library.js';
import { parseLibraryJobFinalize } from '../../../packages/shared/dist/team/library-processing.js';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode
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
import {
  applyLibraryGroupMutation,
  ensureCanonicalFolderPath,
  parseLibraryGroupIntent,
  safeProviderErrorCode
} from '../_shared/library.ts';
import { isRecord, parseBoundedString, parseJsonBody, parseUuid } from '../_shared/validation.ts';
import { executeLibraryOpsCommand, type LibraryOpsCommand, type LibraryOpsRpc } from './handler.ts';

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
    retryable: ['DRIVE_UNAVAILABLE', 'RATE_LIMITED', 'GROUP_RECONCILING'].includes(code ?? '')
  });
}

function rpcValue(client: RpcClient): LibraryOpsRpc {
  return async (name, parameters) => {
    const { data, error } = await client.rpc(name, parameters);
    if (error) throw mappedRpcError(error);
    return data;
  };
}

function routeAction(url: URL, body: Record<string, unknown>): string {
  if (typeof body.action === 'string') return body.action;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.at(-1) === 'start') return 'batch_start';
  if (parts.at(-1) === 'finalize' && parts.includes('items')) return 'batch_item_finalize';
  if (parts.at(-1) === 'fail' && parts.includes('items')) return 'batch_item_fail';
  if (parts.at(-1) === 'move' && parts.includes('placement')) return 'placement_move';
  if (parts.at(-1) === 'finalize' && parts.includes('jobs')) return 'job_finalize';
  if (parts.at(-1) === 'copy' && parts.includes('share')) return 'share_copy';
  if (parts.includes('batches')) return 'batch_get';
  return '';
}

function parseCommand(url: URL, body: Record<string, unknown>): LibraryOpsCommand {
  const action = routeAction(url, body);
  if (action === 'batch_start') {
    const { action: _action, ...requestBody } = body;
    const request = parseUploadBatchRequest(requestBody);
    if (!request) throw new TeamFunctionError('INVALID_INPUT');
    return { action, request };
  }
  if (action === 'placement_move') {
    const { action: _action, ...requestBody } = body;
    const request = parseLibraryPlacementMutation(requestBody);
    if (!request) throw new TeamFunctionError('INVALID_INPUT');
    return { action, request };
  }
  if (action === 'job_finalize') {
    const { action: _action, ...requestBody } = body;
    const request = parseLibraryJobFinalize(requestBody);
    if (!request) throw new TeamFunctionError('INVALID_INPUT');
    return { action, request };
  }
  if (action === 'share_copy') {
    const { action: _action, ...requestBody } = body;
    const request = parseLibraryShareCopyRequest(requestBody);
    if (!request) throw new TeamFunctionError('INVALID_INPUT');
    return { action, request };
  }
  const teamId = parseUuid(body.teamId);
  const batchId = parseUuid(body.batchId ?? batchIdFromUrl(url));
  if (!teamId.ok || !batchId.ok) throw new TeamFunctionError('INVALID_INPUT');
  if (action === 'batch_get') return { action, teamId: teamId.value, batchId: batchId.value };
  if (action === 'batch_item_finalize') {
    const materialId = parseUuid(body.materialId);
    const clientItemKey = parseBoundedString(body.clientItemKey, 1, 128);
    if (!materialId.ok || !clientItemKey.ok) {
      throw new TeamFunctionError('INVALID_INPUT');
    }
    return {
      action,
      teamId: teamId.value,
      batchId: batchId.value,
      clientItemKey: clientItemKey.value,
      materialId: materialId.value
    };
  }
  if (action === 'batch_item_fail') {
    const clientItemKey = parseBoundedString(body.clientItemKey, 1, 128);
    const errorCode = parseBoundedString(body.errorCode, 3, 64);
    if (!clientItemKey.ok || !errorCode.ok || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode.value)) {
      throw new TeamFunctionError('INVALID_INPUT');
    }
    return {
      action,
      teamId: teamId.value,
      batchId: batchId.value,
      clientItemKey: clientItemKey.value,
      errorCode: errorCode.value
    };
  }
  throw new TeamFunctionError('INVALID_INPUT');
}

function batchIdFromUrl(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  const batchIndex = parts.lastIndexOf('batches');
  return batchIndex >= 0 ? parts[batchIndex + 1] : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return isRecord(row) ? row : null;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TeamFunctionError('INVALID_RESPONSE');
  }
  return value;
}

function productionSignals(request: Request): OAuthProductionSignals {
  return {
    siteUrl: Deno.env.get('WISHLY_SITE_URL'),
    requestOrigin: request.headers.get('origin')
  };
}

async function ensurePlacement(input: {
  request: UploadBatchRequest;
  actorId: string;
  service: RpcClient;
  requestContext: Request;
}): Promise<{ destinationFolderId: string }> {
  const serviceRpc = rpcValue(input.service);
  const context = firstRecord(
    await serviceRpc('service_get_library_connection_context', {
      p_team: input.request.teamId,
      p_actor: input.actorId
    })
  );
  if (!context) throw new TeamFunctionError('NEEDS_REAUTH');
  const connectionId = requiredString(context, 'connection_id');
  const credentialId = requiredString(context, 'credential_id');
  const rootFolderId = requiredString(context, 'root_folder_id');
  const credential = await readDriveCredential(input.service, credentialId);
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  const access = await refreshGoogleAccessToken({
    credential,
    clientId,
    clientSecret,
    oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
    productionSignals: productionSignals(input.requestContext)
  });
  const drive = new GoogleDriveClient(access.accessToken);
  const root = await drive.getFile(
    rootFolderId,
    typeof context.root_resource_key === 'string' ? context.root_resource_key : null
  );
  requireDriveCapability(root, 'canAddChildren');
  const bindings = await ensureCanonicalFolderPath({
    service: input.service,
    drive,
    teamId: input.request.teamId,
    connectionId,
    rootFolderId,
    placement: {
      stage: input.request.stage,
      offer: input.request.offer,
      language: input.request.language ?? 'unknown',
      type: input.request.typeHint ?? 'Unknown'
    }
  });
  const destination = bindings.at(-1);
  if (!destination) throw new TeamFunctionError('INVALID_RESPONSE');
  return { destinationFolderId: destination.materialId };
}

function placementOperationKey(request: LibraryPlacementMutationRequest, materialId: string) {
  return `placement.${request.idempotencyKey.slice(0, 100)}.${materialId}`;
}

async function movePlacement(input: {
  request: LibraryPlacementMutationRequest;
  actorId: string;
  service: RpcClient;
  requestContext: Request;
}): Promise<{
  targetStage: LibraryPlacementMutationRequest['targetStage'];
  succeeded: Array<{ materialId: string; reused: boolean }>;
  failed: Array<{ materialId: string; errorCode: string; retryable: boolean }>;
}> {
  const serviceRpc = rpcValue(input.service);
  const context = firstRecord(
    await serviceRpc('service_get_library_connection_context', {
      p_team: input.request.teamId,
      p_actor: input.actorId
    })
  );
  if (!context) throw new TeamFunctionError('NEEDS_REAUTH');
  const connectionId = requiredString(context, 'connection_id');
  const credentialId = requiredString(context, 'credential_id');
  const rootFolderId = requiredString(context, 'root_folder_id');
  const credential = await readDriveCredential(input.service, credentialId);
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  const access = await refreshGoogleAccessToken({
    credential,
    clientId,
    clientSecret,
    oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
    productionSignals: productionSignals(input.requestContext)
  });
  const drive = new GoogleDriveClient(access.accessToken);
  const succeeded: Array<{ materialId: string; reused: boolean }> = [];
  const failed: Array<{ materialId: string; errorCode: string; retryable: boolean }> = [];

  for (const materialId of input.request.materialIds) {
    try {
      const placement = firstRecord(
        await serviceRpc('service_get_library_asset_placement', {
          p_team: input.request.teamId,
          p_actor: input.actorId,
          p_material: materialId
        })
      );
      if (!placement) throw new TeamFunctionError('NOT_FOUND');
      const revision = placement.placement_revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) {
        throw new TeamFunctionError('INVALID_RESPONSE');
      }
      const desired = input.request.placement ?? {
        stage: input.request.targetStage,
        offer: requiredString(placement, 'offer'),
        language: requiredString(placement, 'language'),
        type: requiredString(placement, 'type')
      };
      const folders = await ensureCanonicalFolderPath({
        service: input.service,
        drive,
        teamId: input.request.teamId,
        connectionId,
        rootFolderId,
        placement: desired
      });
      const destination = folders.at(-1);
      if (!destination) throw new TeamFunctionError('INVALID_RESPONSE');
      const operationKey = placementOperationKey(input.request, materialId);
      const operation = firstRecord(
        await serviceRpc('service_start_team_operation', {
          p_team: input.request.teamId,
          p_actor: input.actorId,
          p_kind: 'move',
          p_idempotency_key: operationKey,
          p_request_nonce: `request.${operationKey}`,
          p_source_material: materialId,
          p_destination_folder: destination.materialId,
          p_reserved_name_key: null,
          p_reservation_expires_at: null,
          p_bytes_total: 0
        })
      );
      if (!operation) throw new TeamFunctionError('INVALID_RESPONSE');
      const operationId = requiredString(operation, 'operation_id');
      if (operation.state === 'succeeded') {
        succeeded.push({ materialId, reused: true });
        continue;
      }
      const intent = parseLibraryGroupIntent(
        await serviceRpc('service_create_material_group_intent', {
          p_team: input.request.teamId,
          p_actor: input.actorId,
          p_operation: operationId,
          p_material: materialId,
          p_expected_revision: revision,
          p_destination_material: destination.materialId,
          p_destination_parent_id: destination.driveFolderId,
          p_stage: desired.stage,
          p_offer: desired.offer,
          p_language: desired.language,
          p_type: desired.type
        })
      );
      if (!intent) throw new TeamFunctionError('INVALID_RESPONSE');
      await applyLibraryGroupMutation({
        service: input.service,
        drive,
        rootFolderId,
        intent,
        destinationFolderId: destination.driveFolderId
      });
      const completed = firstRecord(
        await serviceRpc('service_complete_material_group_intent', { p_intent: intent.intentId })
      );
      if (!completed || completed.state !== 'succeeded') {
        throw new TeamFunctionError('INVALID_RESPONSE');
      }
      succeeded.push({ materialId, reused: completed.reused === true });
    } catch (error) {
      const code = safeProviderErrorCode(error);
      failed.push({
        materialId,
        errorCode: code,
        retryable:
          error instanceof TeamFunctionError
            ? error.retryable
            : ['DRIVE_UNAVAILABLE', 'RATE_LIMITED', 'GROUP_RECONCILING'].includes(code)
      });
    }
  }
  return { targetStage: input.request.targetStage, succeeded, failed };
}

async function shareMaterial(input: {
  request: LibraryShareCopyRequest;
  actorId: string;
  caller: RpcClient;
  service: RpcClient;
  requestContext: Request;
}) {
  const serviceRpc = rpcValue(input.service);
  const context = firstRecord(
    await serviceRpc('service_get_material_operation_context', {
      p_team: input.request.teamId,
      p_material: input.request.materialId,
      p_actor: input.actorId,
      p_permission: 'view',
      p_allow_trashed: false
    })
  );
  if (!context) throw new TeamFunctionError('NOT_FOUND');
  const credential = await readDriveCredential(
    input.service,
    requiredString(context, 'credential_id')
  );
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  const access = await refreshGoogleAccessToken({
    credential,
    clientId,
    clientSecret,
    oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
    productionSignals: productionSignals(input.requestContext)
  });
  // One deadline covers the entire metadata/permissions walk. POST is never retried.
  const deadline = AbortSignal.timeout(20_000);
  const drive = new GoogleDriveClient(access.accessToken, (url, init) =>
    fetch(url, {
      ...init,
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])])
    })
  );
  const sourceFile = requiredString(context, 'drive_file_id');
  const sourceConnection = requiredString(context, 'connection_id');
  const live = await proveLiveAncestry({
    client: drive,
    fileId: sourceFile,
    resourceKey: typeof context.resource_key === 'string' ? context.resource_key : null,
    rootFolderId: requiredString(context, 'root_folder_id')
  });
  if (live.id !== sourceFile) throw new TeamFunctionError('SOURCE_CHANGED');
  const identity = {
    p_team: input.request.teamId,
    p_actor: input.actorId,
    p_material: input.request.materialId,
    p_file: sourceFile
  };
  return resolveMaterialShare(
    {
      fileId: live.id,
      webViewLink: live.webViewLink,
      canShare: live.capabilities.canShare === true,
      shareVersion: input.request.expectedShareVersion ?? null,
      allowIfRestricted: input.request.allowIfRestricted,
      rememberChoice: input.request.rememberChoice
    },
    {
      listAnyonePermissions: id => drive.listAnyonePermissions(id),
      pending: async () =>
        parseShareStatus(await serviceRpc('service_material_share_status', identity)),
      observePublic: async () => {
        await serviceRpc('service_observe_material_share_public', identity);
      },
      authorizeWrite: async () => {
        const fresh = firstRecord(
          await serviceRpc('service_get_material_operation_context', {
            p_team: input.request.teamId,
            p_material: input.request.materialId,
            p_actor: input.actorId,
            p_permission: 'edit',
            p_allow_trashed: false
          })
        );
        if (!fresh) throw new TeamFunctionError('PERMISSION_DENIED');
        for (const key of ['drive_file_id', 'connection_id', 'credential_id', 'root_folder_id'])
          if (requiredString(fresh, key) !== requiredString(context, key))
            throw new TeamFunctionError('STALE_RESULT');
        const current = await proveLiveAncestry({
          client: drive,
          fileId: sourceFile,
          resourceKey: typeof fresh.resource_key === 'string' ? fresh.resource_key : null,
          rootFolderId: requiredString(fresh, 'root_folder_id')
        });
        if (current.id !== sourceFile || current.capabilities.canShare !== true)
          throw new TeamFunctionError('PERMISSION_DENIED');
      },
      reserve: async publicObserved =>
        parseShareReservation(
          await serviceRpc('service_begin_material_share', {
            ...identity,
            p_connection: sourceConnection,
            p_key: input.request.idempotencyKey,
            p_remember: input.request.rememberChoice,
            p_public_observed: publicObserved,
            p_expected_share_version: input.request.expectedShareVersion ?? null
          })
        ),
      createReader: id => drive.createAnyoneReaderPermission(id),
      recordAcknowledgement: async (intentId, permissionId) => {
        if (
          (await serviceRpc('service_acknowledge_material_share', {
            p_team: input.request.teamId,
            p_actor: input.actorId,
            p_intent: intentId,
            p_permission: permissionId
          })) !== true
        )
          throw new TeamFunctionError('INVALID_RESPONSE');
      },
      confirmPublic: async (intentId, permissionId, noWrite) => {
        if (
          (await serviceRpc('service_confirm_material_share', {
            p_team: input.request.teamId,
            p_actor: input.actorId,
            p_intent: intentId,
            p_file: sourceFile,
            p_permission: permissionId,
            p_no_write: noWrite
          })) !== true
        )
          throw new TeamFunctionError('CATALOG_LINK_SHARING_UNCERTAIN');
      },
      remember: async () => {
        const { error } = await input.caller.rpc('set_share_preference', {
          p_team: input.request.teamId,
          p_allow: true
        });
        if (error) throw mappedRpcError(error);
      },
      now: () => new Date().toISOString()
    }
  );
}

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const cors = corsHeadersForRequest(request);
  if (!cors) return new Response(null, { status: 403 });
  if (request.method !== 'POST') {
    return errorResponse(new TeamFunctionError('INVALID_INPUT'), cors);
  }
  try {
    const parsed = await parseJsonBody(request, 512 * 1024);
    if (!parsed.ok) throw new TeamFunctionError(parsed.error);
    const command = parseCommand(new URL(request.url), parsed.value);
    const configured = clients(request);
    const identity = await authorizeCaller(request, configured.service);
    const result = await executeLibraryOpsCommand(command, {
      actorId: identity.userId,
      callerRpc: rpcValue(configured.caller),
      serviceRpc: rpcValue(configured.service),
      ensurePlacement:
        command.action === 'batch_start'
          ? batchRequest =>
              ensurePlacement({
                request: batchRequest,
                actorId: identity.userId,
                service: configured.service,
                requestContext: request
              })
          : undefined,
      movePlacement:
        command.action === 'placement_move'
          ? placementRequest =>
              movePlacement({
                request: placementRequest,
                actorId: identity.userId,
                service: configured.service,
                requestContext: request
              })
          : undefined,
      shareMaterial:
        command.action === 'share_copy'
          ? shareRequest =>
              shareMaterial({
                request: shareRequest,
                actorId: identity.userId,
                caller: configured.caller,
                service: configured.service,
                requestContext: request
              })
          : undefined
    });
    return successResponse(result, cors);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
