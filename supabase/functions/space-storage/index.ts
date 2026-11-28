import { createClient } from 'npm:@supabase/supabase-js@2';
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import { BUILD_ID } from '../../../packages/shared/dist/release.js';
import { authorizeCaller } from '../_shared/auth.ts';
import { corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { readSpaceR2Config, SpaceR2 } from '../_shared/r2-space.ts';
import { writeSpaceStorageJournal } from '../_shared/space-storage-journal.ts';
import { parseJsonBody } from '../_shared/validation.ts';
import { createSpace } from './create.ts';
import {
  parseCreateSpaceCommand,
  requireSpaceStorageClient,
  spaceRpcError,
  spaceStorageClient,
  spaceStorageRouteMatch,
  spaceStorageRoutePath
} from './handler.ts';
import {
  emptyTrash,
  mutateMaterials,
  parseMutateCommand,
  parseTrashEmptyCommand
} from './mutate.ts';
import { issueReadGrant, readSpaceReadGrantConfig, type SpaceReadGrantConfig } from './read.ts';
import {
  abortUpload,
  admitUpload,
  completeUpload,
  parseAdmitCommand,
  parseCompleteCommand,
  parsePartsCommand,
  parseTeamCommand,
  signUploadParts
} from './uploads.ts';

/**
 * space-storage (057): the storage of Soty spaces on R2. POST only, routed by path as
 * `drive-ops` is. The handler verifies the caller's JWT itself; the client never names a bucket,
 * a key or a storage URL. Routes: `/spaces/create` (T015), `/uploads/*` (T023),
 * `/materials/mutate` and `/trash/empty` (T025), `/read-grant` (T027).
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

/** The bucket of this environment, or null until R2_SPACE_* are provisioned (T002). */
function spaceBucket(): SpaceR2 | null {
  const config = readSpaceR2Config(key => Deno.env.get(key));
  if (!config) return null;
  return new SpaceR2(
    config,
    new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: 'auto'
    }),
    (input, init) => fetch(input, init)
  );
}

let grantConfig: Promise<SpaceReadGrantConfig | null> | null = null;

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  const browserCors = corsHeadersForRequest(request);
  if (request.headers.has('origin') && !browserCors) return new Response(null, { status: 403 });
  const cors = browserCors ?? {};

  try {
    if (request.method !== 'POST')
      throw new TeamFunctionError('INVALID_INPUT', { retryable: false });
    const { route, uploadId } = spaceStorageRouteMatch(spaceStorageRoutePath(new URL(request.url)));
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
    const base = { actorId: userId, rpc, journal, operationId: crypto.randomUUID(), client };
    if (route === '/materials/mutate')
      return successResponse(await mutateMaterials(parseMutateCommand(body.value), base), cors);
    if (route === '/materials/read')
      return successResponse(
        await readMaterials(parseReadMaterialsCommand(body.value), base),
        cors
      );
    if (route === '/trash/empty')
      return successResponse(await emptyTrash(parseTrashEmptyCommand(body.value), base), cors);
    if (route === '/read-grant') {
      grantConfig ??= readSpaceReadGrantConfig(key => Deno.env.get(key));
      const config = await grantConfig;
      return successResponse(
        await issueReadGrant(parseTeamCommand(body.value), { ...base, config }),
        cors
      );
    }
    const bucket = spaceBucket();
    if (!bucket) throw new TeamFunctionError('STORAGE_UNAVAILABLE');
    const upload = { ...base, bucket, signal: request.signal };
    if (route === '/uploads/admit')
      return successResponse(await admitUpload(parseAdmitCommand(body.value), upload), cors);
    if (uploadId && route === '/uploads/{id}/parts')
      return successResponse(
        await signUploadParts(uploadId, parsePartsCommand(body.value), upload),
        cors
      );
    if (uploadId && route === '/uploads/{id}/complete')
      return successResponse(
        await completeUpload(uploadId, parseCompleteCommand(body.value), upload),
        cors
      );
    if (uploadId && route === '/uploads/{id}/abort')
      return successResponse(
        await abortUpload(uploadId, parseTeamCommand(body.value), upload),
        cors
      );
    throw new TeamFunctionError('NOT_FOUND', { retryable: false });
  } catch (error) {
    if (error instanceof TeamFunctionError) return errorResponse(error, cors);
    // Logged redacted by mapUnknownError; answered as this function's own retryable 503, not
    // as Drive being unavailable.
    mapUnknownError(error);
    return errorResponse(new TeamFunctionError('STORAGE_UNAVAILABLE'), cors);
  }
});
