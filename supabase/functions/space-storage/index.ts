import { createClient } from 'npm:@supabase/supabase-js@2';
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import { BUILD_ID } from '../../../packages/shared/dist/release.js';
import { authorizeCaller } from '../_shared/auth.ts';
import { allowedBrowserOrigins, corsHeadersForRequest, corsPreflight } from '../_shared/cors.ts';
import {
  errorResponse,
  mapUnknownError,
  successResponse,
  TeamFunctionError
} from '../_shared/errors.ts';
import { readSpaceR2Config, SpaceR2 } from '../_shared/r2-space.ts';
import { writeSpaceStorageJournal } from '../_shared/space-storage-journal.ts';
import { parseJsonBody } from '../_shared/validation.ts';
import { parseCatalogVariantRunCommand, runCatalogVariant } from './catalog-variants.ts';
import { createSpace } from './create.ts';
import {
  localEpochReader,
  localSpaceReadPrefix,
  parseEpoch,
  readLocalSpaceReadConfig,
  serveLocalSpaceRead,
  spaceReadBucket,
  type LocalSpaceReadConfig
} from './files.ts';
import {
  parseCreateSpaceCommand,
  requireSpaceStorageClient,
  spaceRpcError,
  spaceStorageClient,
  spaceStorageRouteMatch,
  spaceStorageRoutePath,
  SPACE_STORAGE_TICKET_ROUTES
} from './handler.ts';
import {
  emptyTrash,
  mutateMaterials,
  parseMutateCommand,
  parseReadMaterialsCommand,
  parseTrashEmptyCommand,
  readMaterials
} from './mutate.ts';
import {
  acknowledgeProcessQuiesced,
  agentSource,
  finalizeProcessOutput,
  issueAgentDownloadGrant,
  parseProcessStartCommand,
  signProcessOutputParts,
  startProcessOutput,
  startSpaceProcess,
  type ProcessDeps
} from './process.ts';
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
 * `/materials/mutate` and `/trash/empty` (T025), `/read-grant` (T027), and a tool run:
 * `/process/start` and `/catalog-variants/run` (T094) for a member, `/agent/source` and
 * `/process/output/*` for the desktop agent with its operation ticket (T033/T035) — those five
 * never see a member's session.
 * On beta and dev only, `GET|HEAD /files/…` serves space reads in place of the Worker
 * (`files.ts`); under a production config that path does not exist.
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
let localReadConfig: Promise<LocalSpaceReadConfig | null> | null = null;
let localEpoch: ((teamId: string) => Promise<bigint | null>) | null = null;

/** The beta read route (`files.ts`). Its answers are the Worker's, CORS included. */
async function localSpaceRead(request: Request, prefix: string): Promise<Response> {
  localReadConfig ??= readLocalSpaceReadConfig(key => Deno.env.get(key));
  const config = await localReadConfig;
  const r2 = config ? spaceBucket() : null;
  localEpoch ??= localEpochReader(async teamId => {
    const { data, error } = await (serviceClient() as unknown as RpcCapable).rpc(
      'service_space_read_epoch',
      { p_team: teamId }
    );
    if (error) throw new Error('Epoch lookup failed');
    return parseEpoch(data);
  });
  return serveLocalSpaceRead(request, prefix, {
    config,
    bucket: r2 ? spaceReadBucket(r2, request.signal) : null,
    epoch: localEpoch,
    allowedOrigins: [...allowedBrowserOrigins()],
    nowSeconds: () => Math.floor(Date.now() / 1000)
  });
}

Deno.serve(async request => {
  const preflight = corsPreflight(request);
  if (preflight) return preflight;
  if (request.method === 'GET' || request.method === 'HEAD') {
    const prefix = localSpaceReadPrefix(new URL(request.url));
    if (prefix !== null) return localSpaceRead(request, prefix);
  }
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
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await (service as unknown as RpcCapable).rpc(name, args);
      if (error) throw spaceRpcError(error);
      return data;
    };
    const client = spaceStorageClient(request.headers, BUILD_ID);
    const journal = (entry: unknown) => writeSpaceStorageJournal(service, entry);
    const readGrantConfig = async () => {
      grantConfig ??= readSpaceReadGrantConfig(key => Deno.env.get(key));
      return grantConfig;
    };

    if (SPACE_STORAGE_TICKET_ROUTES.has(route)) {
      // The agent: its ticket is the authority, checked by the database when it is spent.
      const agent: ProcessDeps = {
        actorId: null,
        rpc,
        bucket: route === '/agent/source' ? null : spaceBucket(),
        readGrant: route === '/agent/source' ? await readGrantConfig() : null,
        journal,
        operationId: crypto.randomUUID(),
        client,
        signal: request.signal
      };
      if (route === '/agent/source')
        return successResponse(await agentSource(body.value, agent), cors);
      if (!agent.bucket) throw new TeamFunctionError('STORAGE_UNAVAILABLE');
      if (route === '/process/output/start')
        return successResponse(await startProcessOutput(body.value, agent), cors);
      if (route === '/process/output/parts')
        return successResponse(await signProcessOutputParts(body.value, agent), cors);
      if (route === '/process/output/finalize')
        return successResponse(await finalizeProcessOutput(body.value, agent), cors);
      return successResponse(await acknowledgeProcessQuiesced(body.value, agent), cors);
    }

    const { userId } = await authorizeCaller(request, service);

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
    if (route === '/process/start')
      return successResponse(
        await startSpaceProcess(parseProcessStartCommand(body.value), {
          ...base,
          bucket: null,
          readGrant: null
        }),
        cors
      );
    if (route === '/catalog-variants/run')
      return successResponse(
        await runCatalogVariant(parseCatalogVariantRunCommand(body.value), {
          ...base,
          bucket: null,
          readGrant: null
        }),
        cors
      );
    if (route === '/materials/agent-grant')
      return successResponse(
        await issueAgentDownloadGrant(body.value, { ...base, bucket: null, readGrant: null }),
        cors
      );
    if (route === '/read-grant') {
      const config = await readGrantConfig();
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
