import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Rpc } from '../_shared/ai-allowance.ts';
import { authorizeCaller } from '../_shared/auth.ts';
import type { ClaudeClient } from '../_shared/claude.ts';
import { createClaudeClient } from '../_shared/claude-sdk.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { parseJsonBody } from '../_shared/validation.ts';
import { createFakeClient, isFakeMode } from './fake-provider.ts';
import {
  parseTranslateCommand,
  startTranslation,
  watchTranslation,
  type TranslateDeps
} from './handler.ts';

interface RpcCapable {
  rpc: Rpc;
}

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

function clients(request: Request) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    throw new TeamFunctionError('TRANSLATION_UNAVAILABLE', { retryable: true });
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

/**
 * The real model when a key is configured. On the beta stack only, and only without a key, a
 * deterministic stand-in may replace it, so production can never translate with the fake.
 */
function modelClient(): ClaudeClient | null {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (apiKey) return createClaudeClient(apiKey);
  const fake = Deno.env.get('SOTY_TRANSLATION_PROVIDER');
  if (Deno.env.get('SOTY_ENVIRONMENT') === 'beta' && isFakeMode(fake))
    return createFakeClient(fake);
  return null;
}

function background(work: Promise<void>): void {
  const guarded = work.catch(error =>
    console.error('translation background failed', error instanceof Error ? error.name : 'unknown')
  );
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(guarded);
}

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const cors = corsHeadersForRequest(request);
  if (!cors) return new Response(null, { status: 403 });
  if (request.method !== 'POST') return errorResponse(new TeamFunctionError('INVALID_INPUT'), cors);

  try {
    const body = await parseJsonBody(request);
    if (!body.ok) throw new TeamFunctionError(body.error, { retryable: false });
    const command = parseTranslateCommand(body.value);
    const { caller, service } = clients(request);
    const identity = await authorizeCaller(request, service);
    const callerRpc = (caller as unknown as RpcCapable).rpc.bind(caller);
    const serviceRpc = (service as unknown as RpcCapable).rpc.bind(service);
    const deps: TranslateDeps = {
      userId: identity.userId,
      callerRpc,
      serviceRpc,
      client: modelClient(),
      background
    };
    if (command.action === 'watch') {
      const stream = await watchTranslation(command, deps);
      return new Response(stream, {
        status: 200,
        headers: {
          ...cors,
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      });
    }
    return successResponse(await startTranslation(command, deps), cors);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
