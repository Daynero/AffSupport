import { createClient } from 'npm:@supabase/supabase-js@2';
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
import { GoogleDriveClient } from '../_shared/drive.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import {
  isRecord,
  parseBoundedString,
  parseIdempotencyKey,
  parseJsonBody,
  parseSafePageToken,
  parseUuid
} from '../_shared/validation.ts';
import {
  executeDriveConnectCommand,
  validateRootCandidate,
  type DriveConnectCommand,
  type RootCandidateSnapshot
} from './handler.ts';
import { evaluateTeamProviderReadiness } from './readiness.ts';

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

function mappedRpcError(error: RpcFailure): TeamFunctionError {
  const values = [error.message, error.code]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.match(/[A-Z][A-Z0-9_]+/g) ?? []);
  const code = values.find(value => (TEAM_ERROR_CODES as readonly string[]).includes(value)) as
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

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return value;
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

function productionSignals(request: Request): OAuthProductionSignals {
  return {
    siteUrl: Deno.env.get('WISHLY_SITE_URL'),
    requestOrigin: request.headers.get('origin')
  };
}

function randomBase64Url(byteLength: number): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(byteLength))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function byteaHex(value: Uint8Array): string {
  return `\\x${[...value].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

async function startOAuth(
  command: DriveConnectCommand,
  service: RpcClient,
  userId: string,
  signals: OAuthProductionSignals
) {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!clientId || !supabaseUrl) {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
  }
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await rpcValue(service, 'service_create_drive_oauth_transaction', {
    p_team: command.teamId,
    p_actor: userId,
    p_state_hash: byteaHex(await sha256(state)),
    p_pkce_verifier: verifier,
    p_request_origin: signals.requestOrigin ?? signals.siteUrl ?? 'http://127.0.0.1:5173',
    p_expires_at: expiresAt
  });
  const callbackUrl =
    Deno.env.get('GOOGLE_REDIRECT_URI') ??
    `${supabaseUrl.replace(/\/$/, '')}/functions/v1/drive-oauth-callback`;
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive');
  authorizationUrl.searchParams.set('access_type', 'offline');
  authorizationUrl.searchParams.set('include_granted_scopes', 'true');
  authorizationUrl.searchParams.set('prompt', 'consent');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('code_challenge', base64Url(await sha256(verifier)));
  return { authorizationUrl: authorizationUrl.toString(), expiresAt };
}

async function accessContext(
  teamId: string,
  userId: string,
  service: RpcClient,
  signals: OAuthProductionSignals
) {
  const reference = firstRecord(
    await rpcValue(service, 'service_get_drive_credential_reference', {
      p_team: teamId,
      p_actor: userId
    })
  );
  if (!reference) throw new TeamFunctionError('NEEDS_REAUTH', { retryable: false });
  const credentialId = requiredString(reference, 'credential_id');
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
      productionSignals: signals
    });
    return {
      credential,
      credentialId,
      drive: new GoogleDriveClient(token.accessToken)
    };
  } catch (error) {
    if (error instanceof TeamFunctionError && error.code === 'NEEDS_REAUTH') {
      await rpcValue(service, 'service_mark_drive_needs_reauth', {
        p_credential: credentialId
      });
    }
    throw error;
  }
}

async function getStartPageToken(accessToken: string, driveId: string | null): Promise<string> {
  const url = new URL('https://www.googleapis.com/drive/v3/changes/startPageToken');
  url.searchParams.set('supportsAllDrives', 'true');
  if (driveId) url.searchParams.set('driveId', driveId);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  if (response.status === 401) throw new TeamFunctionError('NEEDS_REAUTH');
  if (response.status === 429) throw new TeamFunctionError('RATE_LIMITED', { retryable: true });
  if (!response.ok) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.startPageToken !== 'string') {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return payload.startPageToken;
}

function rootCapabilities(root: RootCandidateSnapshot, startPageToken: string) {
  return {
    ...root.capabilities,
    resourceKey: root.resourceKey,
    startPageToken
  };
}

function actionFromRequest(url: URL, body?: Record<string, unknown>): string {
  if (typeof body?.action === 'string') return body.action;
  const candidate = url.pathname.split('/').filter(Boolean).at(-1);
  return candidate === 'drive-connect' ? 'status' : (candidate ?? 'status');
}

function parseTeamId(value: unknown): string {
  const parsed = parseUuid(value);
  if (!parsed.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
  return parsed.value;
}

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const cors = corsHeadersForRequest(request);
  if (!cors) return new Response(null, { status: 403 });

  try {
    const url = new URL(request.url);
    const bodyResult = request.method === 'POST' ? await parseJsonBody(request) : null;
    if (bodyResult && !bodyResult.ok) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const body = bodyResult?.ok ? bodyResult.value : undefined;
    const action = actionFromRequest(url, body);
    const signals = productionSignals(request);
    if (request.method === 'GET' && action === 'readiness') {
      return successResponse(
        evaluateTeamProviderReadiness(
          {
            DRIVE_OAUTH_MODE: Deno.env.get('DRIVE_OAUTH_MODE'),
            GOOGLE_CLIENT_ID: Deno.env.get('GOOGLE_CLIENT_ID'),
            GOOGLE_CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET'),
            GOOGLE_REDIRECT_URI: Deno.env.get('GOOGLE_REDIRECT_URI'),
            RESEND_API_KEY: Deno.env.get('RESEND_API_KEY'),
            INVITE_EMAIL_FROM: Deno.env.get('INVITE_EMAIL_FROM'),
            TEAM_DIRECT_ADD_MODE: Deno.env.get('TEAM_DIRECT_ADD_MODE'),
            CATALOG_SYNC_SECRET: Deno.env.get('CATALOG_SYNC_SECRET')
          },
          signals
        ),
        cors
      );
    }
    const configured = clients(request);
    const { userId } = await authorizeCaller(request, configured.service);

    if (request.method === 'GET' && action === 'status') {
      const teamId = parseTeamId(url.searchParams.get('teamId'));
      const value = firstRecord(
        await rpcValue(configured.caller, 'get_drive_connection_status', { p_team: teamId })
      );
      return successResponse(value ?? { state: 'none' }, cors);
    }

    if ((request.method === 'GET' || request.method === 'POST') && action === 'folders') {
      const requestedTeamId =
        request.method === 'POST' ? body?.teamId : url.searchParams.get('teamId');
      const gateResult = await executeDriveConnectCommand(
        { action: 'start', teamId: parseTeamId(requestedTeamId) },
        {
          oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
          signals,
          createOAuthTransaction: async command => command
        }
      );
      const teamId = (gateResult as { teamId: string }).teamId;
      const parent = parseBoundedString(
        request.method === 'POST'
          ? (body?.parentId ?? 'root')
          : (url.searchParams.get('parentId') ?? 'root'),
        1,
        1024
      );
      const pageToken = parseSafePageToken(
        request.method === 'POST' ? body?.pageToken : url.searchParams.get('pageToken')
      );
      if (!parent.ok || !pageToken.ok) {
        throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
      }
      const context = await accessContext(teamId, userId, configured.service, signals);
      const connection = firstRecord(
        await rpcValue(configured.service, 'service_get_drive_connection_credential', {
          p_team: teamId,
          p_actor: userId
        })
      );
      const result = await context.drive.listFolders({
        parentId: parent.value,
        pageToken: pageToken.value,
        driveId: connection && typeof connection.drive_id === 'string' ? connection.drive_id : null
      });
      return successResponse(
        {
          folders: result.files.map(folder => ({
            id: folder.id,
            name: folder.name,
            driveKind: folder.driveId ? 'shared_drive' : 'my_drive',
            resourceKey: folder.resourceKey
          })),
          nextPageToken: result.nextPageToken
        },
        cors
      );
    }

    if (request.method !== 'POST' || !body) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    const teamId = parseTeamId(body.teamId);
    let command: DriveConnectCommand;
    if (action === 'start' || action === 'reauth') {
      command = { action, teamId };
    } else if (action === 'confirm') {
      const folderId = parseBoundedString(body.folderId, 1, 1024);
      const expectedAccount =
        body.expectedAccount === undefined
          ? null
          : parseBoundedString(body.expectedAccount, 3, 320);
      if (
        !folderId.ok ||
        (expectedAccount !== null && !expectedAccount.ok) ||
        typeof body.confirmed !== 'boolean' ||
        (body.confirmed && expectedAccount === null)
      ) {
        throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
      }
      command = {
        action,
        teamId,
        folderId: folderId.value,
        confirmed: body.confirmed,
        ...(expectedAccount?.ok ? { expectedAccount: expectedAccount.value } : {}),
        ...(typeof body.resourceKey === 'string' ? { resourceKey: body.resourceKey } : {})
      };
    } else if (action === 'detach' || action === 'replace') {
      const idempotency = parseIdempotencyKey(body.idempotencyKey);
      if (!idempotency.ok || body.confirmed !== true) {
        throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
      }
      if (action === 'detach') {
        command = {
          action,
          teamId,
          confirmed: true,
          idempotencyKey: idempotency.value,
          ...(typeof body.connectionId === 'string' ? { connectionId: body.connectionId } : {})
        };
      } else {
        const folderId = parseBoundedString(body.folderId, 1, 1024);
        if (!folderId.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
        command = {
          action,
          teamId,
          folderId: folderId.value,
          confirmed: true,
          idempotencyKey: idempotency.value,
          ...(typeof body.resourceKey === 'string' ? { resourceKey: body.resourceKey } : {}),
          ...(typeof body.expectedAccount === 'string'
            ? { expectedAccount: body.expectedAccount }
            : {})
        };
      }
    } else {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }

    let syncJobId: string | null = null;
    const result = await executeDriveConnectCommand(command, {
      oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
      signals,
      createOAuthTransaction: input => startOAuth(input, configured.service, userId, signals),
      loadAccount: async () => {
        const context = await accessContext(teamId, userId, configured.service, signals);
        return { email: context.credential.googleAccountEmail };
      },
      getRoot: async (folderId, resourceKey) => {
        const context = await accessContext(teamId, userId, configured.service, signals);
        return context.drive.getFile(folderId, resourceKey);
      },
      persistConnection: async root => {
        const context = await accessContext(teamId, userId, configured.service, signals);
        const startPageToken = await getStartPageToken(
          (
            await refreshGoogleAccessToken({
              credential: context.credential,
              clientId: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
              clientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
              oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
              productionSignals: signals
            })
          ).accessToken,
          root.driveId
        );
        const persisted = firstRecord(
          await rpcValue(configured.service, 'service_confirm_drive_connection', {
            p_team: teamId,
            p_actor: userId,
            p_credential: context.credentialId,
            p_root_folder_id: root.id,
            p_root_folder_name: root.name,
            p_drive_id: root.driveId,
            p_drive_kind: root.driveKind,
            p_capabilities: rootCapabilities(root, startPageToken)
          })
        );
        if (!persisted) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
        syncJobId = requiredString(persisted, 'sync_job_id');
        return { connectionId: requiredString(persisted, 'connection_id') };
      },
      enqueueInitialSync: async () => {
        if (!syncJobId) throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
        return { jobId: syncJobId };
      },
      mutateConnection: async input => {
        if (input.action === 'detach') {
          const active = firstRecord(
            await rpcValue(configured.service, 'service_get_drive_connection_credential', {
              p_team: teamId,
              p_actor: userId
            })
          );
          if (!active) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
          const connectionId = requiredString(active, 'connection_id');
          if (input.connectionId && input.connectionId !== connectionId) {
            throw new TeamFunctionError('NOT_FOUND', { retryable: false });
          }
          const detached = firstRecord(
            await rpcValue(configured.service, 'service_detach_drive_connection', {
              p_team: teamId,
              p_actor: userId,
              p_connection: connectionId
            })
          );
          if (detached?.delete_credential === true) {
            await rpcValue(configured.service, 'service_delete_google_drive_credential', {
              p_credential: detached.credential_id
            });
          }
          return { state: 'detached' };
        }
        if (input.action !== 'replace') {
          throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
        }
        const context = await accessContext(teamId, userId, configured.service, signals);
        if (
          input.expectedAccount &&
          input.expectedAccount.toLocaleLowerCase('en-US') !==
            context.credential.googleAccountEmail.toLocaleLowerCase('en-US')
        ) {
          throw new TeamFunctionError('PERMISSION_DENIED', { retryable: false });
        }
        const root = validateRootCandidate(
          await context.drive.getFile(input.folderId, input.resourceKey)
        );
        const startPageToken = await getStartPageToken(
          (
            await refreshGoogleAccessToken({
              credential: context.credential,
              clientId: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
              clientSecret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
              oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
              productionSignals: signals
            })
          ).accessToken,
          root.driveId
        );
        const replaced = firstRecord(
          await rpcValue(configured.service, 'service_replace_drive_connection', {
            p_team: teamId,
            p_actor: userId,
            p_credential: context.credentialId,
            p_root_folder_id: root.id,
            p_root_folder_name: root.name,
            p_drive_id: root.driveId,
            p_drive_kind: root.driveKind,
            p_capabilities: rootCapabilities(root, startPageToken)
          })
        );
        return replaced ?? { state: 'connected' };
      }
    });
    return successResponse(result, cors);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
