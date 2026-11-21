import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Rpc } from '../_shared/ai-allowance.ts';
import { authorizeCaller } from '../_shared/auth.ts';
import type { ClaudeClient } from '../_shared/claude.ts';
import { createClaudeClient } from '../_shared/claude-sdk.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import { errorResponse, mapUnknownError, successResponse, TeamFunctionError } from '../_shared/errors.ts';
import { parseJsonBody } from '../_shared/validation.ts';
import { createAssistantFakeClient, isAssistantFakeMode } from './fake-provider.ts';
import { handleAssistant, parseAssistantCommand } from './handler.ts';

interface RpcCapable {
  rpc: Rpc;
}

function clients(request: Request) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) throw new TeamFunctionError('MODEL_UNAVAILABLE', { retryable: true });
  const authorization = request.headers.get('authorization') ?? '';
  const caller = createClient(url, anonKey, {
    global: { headers: { authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return { caller, service };
}

/**
 * The real model when a key is configured; no hidden SDK retries, so every billed call is one
 * recorded attempt. Only on the beta stack, and only without a key, may the stand-in answer.
 */
function modelClient(): ClaudeClient | null {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (apiKey) return createClaudeClient(apiKey, { maxRetries: 0 });
  const fake = Deno.env.get('SOTY_ASSISTANT_PROVIDER');
  if (Deno.env.get('SOTY_ENVIRONMENT') === 'beta' && isAssistantFakeMode(fake)) return createAssistantFakeClient(fake);
  return null;
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
    const command = parseAssistantCommand(body.value);
    const { caller, service } = clients(request);
    const identity = await authorizeCaller(request, service);
    const result = await handleAssistant(command, {
      userId: identity.userId,
      callerRpc: (caller as unknown as RpcCapable).rpc.bind(caller),
      serviceRpc: (service as unknown as RpcCapable).rpc.bind(service),
      client: modelClient()
    });
    return successResponse(result, cors);
  } catch (error) {
    return errorResponse(mapUnknownError(error), cors);
  }
});
