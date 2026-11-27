import { createClient } from 'npm:@supabase/supabase-js@2';
import { BUILD_ID } from '../../../packages/shared/dist/release.js';
import { authorizeCaller } from '../_shared/auth.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { writeSpaceStorageJournal } from '../_shared/space-storage-journal.ts';
import { parseJsonBody } from '../_shared/validation.ts';
import { createSpace } from './create.ts';
import {
  parseCreateSpaceCommand,
  requireSpaceStorageClient,
  spaceRpcError,
  spaceStorageClient,
  spaceStorageRoute,
  spaceStorageRoutePath
} from './handler.ts';

/**
 * space-storage (057): the storage of Soty spaces on R2. POST only, routed by path as
 * `drive-ops` is. The handler verifies the caller's JWT itself; the client never names a bucket,
 * a key or a storage URL. Routes land task by task: `/spaces/create` (T015) first.
 */

interface RpcCapable {
  rpc: (
    name: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
}

function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new TeamFunctionError('STORAGE_UNAVAILABLE');
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const browserCors = corsHeadersForRequest(request);
  if (request.headers.has('origin') && !browserCors) return new Response(null, { status: 403 });
  const cors = browserCors ?? {};

  try {
    if (request.method !== 'POST')
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    const route = spaceStorageRoute(spaceStorageRoutePath(new URL(request.url)));
    requireSpaceStorageClient(request.headers);
    const body = await parseJsonBody(request);
    if (!body.ok) throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    const service = serviceClient();
    const { userId } = await authorizeCaller(request, service);
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await (service as unknown as RpcCapable).rpc(name, args);
      if (error) throw spaceRpcError(error);
      return data;
    };
    const client = spaceStorageClient(request.headers, BUILD_ID);
    const journal = (entry: unknown) => writeSpaceStorageJournal(service, entry);

    if (route === '/spaces/create') {
      const created = await createSpace(parseCreateSpaceCommand(body.value), {
        actorId: userId,
        rpc,
        journal,
        operationId: crypto.randomUUID(),
        client
      });
      return successResponse(created, cors);
    }
    throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  } catch (error) {
    if (error instanceof TeamFunctionError) return errorResponse(error, cors);
    // Logged redacted by mapUnknownError; answered as this function's own retryable 503, not
    // as Drive being unavailable.
    mapUnknownError(error);
    return errorResponse(new TeamFunctionError('STORAGE_UNAVAILABLE'), cors);
  }
});
