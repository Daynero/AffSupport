import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  TEAM_ERROR_CODES,
  type TeamErrorCode
} from '../../../packages/shared/dist/team/transport.js';
import { TEAM_BASE_ROLES } from '../../../packages/shared/dist/team/contract.js';
import { authorizeCaller } from '../_shared/auth.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import {
  parseBoundedString,
  parseEnum,
  parseIdempotencyKey,
  parseJsonBody,
  parseUuid
} from '../_shared/validation.ts';
import { sendInvitationEmail } from './email.ts';
import { executeInvitationCommand, type InvitationCommand } from './handler.ts';

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

function configuredClients(request: Request) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: true });
  }
  const authorization = request.headers.get('authorization') ?? '';
  const caller = createClient(url, anonKey, {
    global: { headers: { authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return { caller, service };
}

function mappedRpcError(error: RpcFailure): TeamFunctionError {
  const possible = [error.message, error.code]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.match(/[A-Z][A-Z0-9_]+/g) ?? []);
  const code = possible.find(value => (TEAM_ERROR_CODES as readonly string[]).includes(value)) as
    TeamErrorCode | undefined;
  return new TeamFunctionError(code ?? 'INVALID_RESPONSE', {
    retryable: code === 'DELIVERY_UNAVAILABLE' || code === 'DRIVE_UNAVAILABLE'
  });
}

function asRpc(client: RpcClient) {
  return async (name: string, parameters: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name, parameters);
    if (error) {
      const mapped = mappedRpcError(error);
      return {
        ok: false as const,
        error: { code: mapped.code, retryable: mapped.retryable, details: mapped.details }
      };
    }
    return { ok: true as const, value: data };
  };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function actionFromUrl(url: URL, body: Record<string, unknown>): string | null {
  if (typeof body.action === 'string') return body.action;
  const parts = url.pathname.split('/').filter(Boolean);
  const candidate = parts.at(-1);
  return candidate && ['create', 'resend', 'revoke'].includes(candidate) ? candidate : null;
}

function invitationIdFromUrl(url: URL, body: Record<string, unknown>): unknown {
  if (body.invitationId !== undefined) return body.invitationId;
  const parts = url.pathname.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.at(-2) : undefined;
}

function parseCommand(url: URL, body: Record<string, unknown>): InvitationCommand {
  const action = actionFromUrl(url, body);
  if (action === 'create') {
    const teamId = parseUuid(body.teamId);
    const email = parseBoundedString(body.email, 3, 320);
    const initialRole = parseEnum(body.initialRole, TEAM_BASE_ROLES);
    const idempotencyKey = parseIdempotencyKey(body.idempotencyKey);
    if (
      !teamId.ok ||
      !email.ok ||
      !initialRole.ok ||
      !idempotencyKey.ok ||
      !email.value.includes('@')
    ) {
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    }
    return {
      action,
      teamId: teamId.value,
      email: email.value,
      initialRole: initialRole.value,
      idempotencyKey: idempotencyKey.value
    };
  }
  if (action === 'resend' || action === 'revoke') {
    const invitationId = parseUuid(invitationIdFromUrl(url, body));
    if (!invitationId.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    return { action, invitationId: invitationId.value };
  }
  throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
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
    const body = await parseJsonBody(request);
    if (!body.ok) throw new TeamFunctionError(body.error, { retryable: false });
    const command = parseCommand(new URL(request.url), body.value);
    const { caller, service } = configuredClients(request);
    await authorizeCaller(request, service);
    const callerRpc = asRpc(caller as unknown as RpcClient);
    const serviceRpc = asRpc(service as unknown as RpcClient);
    const value = await executeInvitationCommand(command, {
      rpc: (name, parameters) =>
        name === 'set_invitation_delivery_state'
          ? serviceRpc(name, parameters)
          : callerRpc(name, parameters),
      deliver: requestValue =>
        sendInvitationEmail({
          apiKey: Deno.env.get('RESEND_API_KEY') ?? '',
          from: Deno.env.get('INVITE_EMAIL_FROM') ?? '',
          to: requestValue.to,
          message: requestValue.message
        }),
      createToken: randomToken,
      siteUrl: Deno.env.get('WISHLY_SITE_URL') ?? 'http://127.0.0.1:5173'
    });
    return successResponse(value, cors);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
