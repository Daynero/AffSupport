import { createClient } from 'npm:@supabase/supabase-js@2';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { completeDriveOAuthCallback } from './handler.ts';

interface RpcFailure {
  code?: string;
  message?: string;
}

interface RpcClient {
  rpc: (
    name: string,
    parameters: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: RpcFailure | null }>;
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

async function stateHash(state: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))
  );
  return `\\x${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function callbackUrl(): string {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
  return (
    Deno.env.get('GOOGLE_REDIRECT_URI') ??
    `${supabaseUrl.replace(/\/$/, '')}/functions/v1/drive-oauth-callback`
  );
}

async function exchangeCode(input: { code: string; codeVerifier: string }) {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: false });
  }
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: callbackUrl(),
        grant_type: 'authorization_code'
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isRecord(payload) && payload.error === 'invalid_grant') {
      throw new TeamFunctionError('NEEDS_REAUTH', { retryable: false });
    }
    throw new TeamFunctionError(response.status === 429 ? 'RATE_LIMITED' : 'DRIVE_UNAVAILABLE', {
      retryable: response.status === 429 || response.status >= 500
    });
  }
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length < 16
  ) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    scope:
      typeof payload.scope === 'string' ? payload.scope : 'https://www.googleapis.com/auth/drive'
  };
}

async function verifyPrincipal(accessToken: string) {
  let response: Response;
  try {
    response = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)',
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000)
      }
    );
  } catch {
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  if (!response.ok) {
    throw new TeamFunctionError(response.status === 401 ? 'NEEDS_REAUTH' : 'DRIVE_UNAVAILABLE', {
      retryable: response.status >= 500
    });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (
    !isRecord(payload) ||
    !isRecord(payload.user) ||
    typeof payload.user.permissionId !== 'string' ||
    typeof payload.user.emailAddress !== 'string'
  ) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  return {
    permissionId: payload.user.permissionId,
    email: payload.user.emailAddress
  };
}

function redirect(code: string): Response {
  let configured: URL;
  try {
    configured = new URL(Deno.env.get('WISHLY_SITE_URL') ?? 'http://127.0.0.1:5173');
  } catch {
    configured = new URL('http://127.0.0.1:5173');
  }
  const destination = new URL('/team', configured.origin);
  destination.searchParams.set('drive', code);
  return new Response(null, {
    status: 303,
    headers: {
      location: destination.toString(),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    }
  });
}

Deno.serve(async request => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (
    request.method !== 'GET' ||
    code.length < 1 ||
    code.length > 4096 ||
    state.length < 16 ||
    state.length > 1024
  ) {
    return redirect('WRONG_STATE');
  }

  try {
    const service = serviceClient();
    const result = await completeDriveOAuthCallback(
      {
        code,
        state,
        oauthMode: Deno.env.get('DRIVE_OAUTH_MODE'),
        signals: {
          siteUrl: Deno.env.get('WISHLY_SITE_URL'),
          requestOrigin: request.headers.get('origin')
        }
      },
      {
        peekTransaction: async plainState => {
          const row = firstRecord(
            await rpcValue(service, 'service_peek_drive_oauth_transaction', {
              p_state_hash: await stateHash(plainState)
            })
          );
          return row
            ? {
                origin: requiredString(row, 'request_origin'),
                teamId: requiredString(row, 'team_id'),
                actorId: requiredString(row, 'actor_id'),
                credentialId: typeof row.credential_id === 'string' ? row.credential_id : null
              }
            : null;
        },
        consumeTransaction: async plainState => {
          const row = firstRecord(
            await rpcValue(service, 'service_consume_drive_oauth_transaction', {
              p_state_hash: await stateHash(plainState)
            })
          );
          return row
            ? {
                teamId: requiredString(row, 'team_id'),
                actorId: requiredString(row, 'actor_id'),
                origin: requiredString(row, 'request_origin'),
                codeVerifier: requiredString(row, 'pkce_verifier'),
                credentialId: typeof row.credential_id === 'string' ? row.credential_id : null
              }
            : null;
        },
        exchangeCode,
        verifyPrincipal,
        storeCredential: async input => {
          const value = await rpcValue(service, 'service_store_google_drive_credential', {
            p_actor: input.actorId,
            p_google_permission_id: input.permissionId,
            p_google_account_email: input.email,
            p_scope: input.scope,
            p_refresh_token: input.refreshToken ?? null,
            p_existing_credential: input.credentialId
          });
          const credentialId = Array.isArray(value) ? value[0] : value;
          if (typeof credentialId !== 'string') {
            throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
          }
          return { credentialId };
        },
        bindCredential: async input => {
          await rpcValue(service, 'service_bind_drive_credential', {
            p_team: input.teamId,
            p_actor: input.actorId,
            p_credential: input.credentialId
          });
        },
        rescanAfterReconsent: async input => {
          await rpcValue(service, 'service_request_catalog_rescan', {
            p_team: input.teamId,
            p_actor: input.actorId
          });
        },
        markNeedsReauth: async credentialId => {
          if (credentialId) {
            await rpcValue(service, 'service_mark_drive_needs_reauth', {
              p_credential: credentialId
            });
          }
        }
      }
    );
    return redirect(result.code);
  } catch (error) {
    return redirect(error instanceof TeamFunctionError ? error.code : 'DRIVE_UNAVAILABLE');
  }
});
