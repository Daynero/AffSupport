// @deno-types="../../../packages/shared/dist/team/catalog-images.d.ts"
import {
  classifyCatalogImageName,
  isCatalogImageCapabilities,
  isCatalogImageDictionaryPage,
  isCatalogImageImportJob,
  isCatalogImageImportList,
  isCatalogImageInventory
} from '../../../packages/shared/dist/team/catalog-images.js';
import { corsHeadersForRequest } from '../_shared/cors.ts';
import { errorResponse, successResponse, TeamFunctionError } from '../_shared/errors.ts';
import {
  catalogImageId,
  catalogImageInteger,
  catalogImageObject,
  catalogImageRpc,
  catalogImageString,
  type CatalogImageRpc
} from '../_shared/catalog-images.ts';
import type { CatalogImageR2 } from '../_shared/r2-catalog-images.ts';

export interface CatalogImageHandlerDeps {
  service: CatalogImageRpc;
  authorize(request: Request): Promise<string>;
  authorizeWorker(request: Request): Promise<void>;
  runWorker(): Promise<unknown>;
  enabled: boolean;
  r2: CatalogImageR2 | null;
  siteUrl: string;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const buffer = new Uint8Array(1_000_000);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > buffer.length) throw new TeamFunctionError('TOO_LARGE');
      buffer.set(part.value, offset);
      offset += part.value.length;
    }
    if (!offset) return {};
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
      );
    } catch {
      throw new TeamFunctionError('INVALID_INPUT');
    }
    return catalogImageObject(value);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function handleCatalogImages(
  request: Request,
  deps: CatalogImageHandlerDeps
): Promise<Response> {
  const cors = corsHeadersForRequest(request, deps.siteUrl);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
  if (request.headers.has('origin') && !cors)
    return errorResponse(new TeamFunctionError('PERMISSION_DENIED'));
  const headers = cors ?? {};
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*\/catalog-images/u, '') || '/';
    if (path === '/worker') {
      if (request.method !== 'POST') throw new TeamFunctionError('INVALID_INPUT');
      await deps.authorizeWorker(request);
      if (!deps.r2) return successResponse({ disabled: true }, headers);
      return successResponse(await deps.runWorker(), headers);
    }
    const actor = await deps.authorize(request);
    const body = request.method === 'POST' ? await bodyOf(request) : {};
    let action: string;
    let payload: Record<string, unknown>;
    let asynchronous = false;
    if (
      request.method === 'GET' &&
      ['/capabilities', '/imports', '/dictionary', '/inventory'].includes(path)
    ) {
      action = path === '/imports' ? 'list' : path.slice(1);
      payload = {
        teamId: catalogImageId(url.searchParams.get('teamId')),
        cursor: url.searchParams.get('cursor')
      };
    } else if (request.method === 'POST' && path === '/imports') {
      if (body.contractVersion !== 2 || !['local', 'drive'].includes(String(body.sourceKind)))
        throw new TeamFunctionError('INVALID_INPUT');
      const sources = body.sourceMaterialIds;
      if (
        body.sourceKind === 'drive' &&
        (!Array.isArray(sources) || sources.length < 1 || sources.length > 100)
      )
        throw new TeamFunctionError('INVALID_INPUT');
      payload = {
        teamId: catalogImageId(body.teamId),
        contractVersion: 2,
        sourceKind: body.sourceKind,
        idempotencyKey: catalogImageString(body.idempotencyKey, 200),
        ...(Array.isArray(sources) ? { sourceMaterialIds: sources.map(catalogImageId) } : {})
      };
      action = 'begin';
      asynchronous = true;
    } else {
      const route =
        /^\/imports\/([^/]+)(?:\/(manifest|seal|cancel|retry|continue)|\/entries\/([^/]+)\/(grant|delivered))?$/u.exec(
          path
        );
      const pool = /^\/pool\/([^/]+)\/remove$/u.exec(path);
      const publication = /^\/publications\/([^/]+)\/revoke$/u.exec(path);
      if (route) {
        payload = { ...body, jobId: catalogImageId(route[1]) };
        if (route[3]) payload.entryId = catalogImageId(route[3]);
        action = route[2] ?? route[4] ?? 'get';
        if (action === 'get') {
          if (request.method !== 'GET') throw new TeamFunctionError('INVALID_INPUT');
          payload.cursor = url.searchParams.get('cursor');
          payload.limit = Math.min(100, Number(url.searchParams.get('limit') ?? 100));
        } else if (request.method !== 'POST') throw new TeamFunctionError('INVALID_INPUT');
        if (action === 'manifest') {
          if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 100)
            throw new TeamFunctionError('INVALID_INPUT');
          payload.pageKey = catalogImageString(body.pageKey, 200);
          payload.entries = body.entries.map(raw => {
            const item = catalogImageObject(raw);
            const name = catalogImageString(item.name);
            const declaredSize = catalogImageInteger(item.declaredSize, 50_000_000);
            if (!declaredSize) throw new TeamFunctionError('INVALID_INPUT');
            return {
              clientFileKey: catalogImageString(item.clientFileKey, 200),
              name,
              declaredSize,
              declaredMime:
                typeof item.declaredMime === 'string' && item.declaredMime.length <= 100
                  ? item.declaredMime || 'application/octet-stream'
                  : 'application/octet-stream',
              classification: classifyCatalogImageName(name)
            };
          });
        }
        if (action === 'seal') {
          catalogImageInteger(body.revision);
          catalogImageInteger(body.manifestCount, 1000);
        }
        if (action === 'grant') {
          catalogImageInteger(body.generation);
          catalogImageString(body.requestKey, 200);
        }
        if (action === 'delivered') {
          catalogImageInteger(body.grantGeneration);
          catalogImageString(body.requestKey, 200);
          asynchronous = true;
        }
        if (action === 'cancel') {
          catalogImageInteger(body.revision);
          catalogImageString(body.idempotencyKey, 200);
        }
        if (action === 'retry' || action === 'continue') {
          catalogImageString(body.idempotencyKey, 200);
          if (
            body.entryIds !== undefined &&
            (!Array.isArray(body.entryIds) || body.entryIds.length > 100)
          )
            throw new TeamFunctionError('INVALID_INPUT');
          if (Array.isArray(body.entryIds)) payload.entryIds = body.entryIds.map(catalogImageId);
        }
      } else if (request.method === 'POST' && (pool || publication)) {
        action = pool ? 'remove' : 'revoke';
        catalogImageInteger(body.revision);
        catalogImageString(body.idempotencyKey, 200);
        if (publication && body.explicitRevocation !== true)
          throw new TeamFunctionError('INVALID_INPUT');
        payload = {
          ...body,
          ...(pool
            ? { entryId: catalogImageId(pool[1]) }
            : { publicationId: catalogImageId(publication![1]) })
        };
      } else throw new TeamFunctionError('NOT_FOUND');
    }
    if (
      ['begin', 'manifest', 'seal', 'grant', 'delivered', 'retry', 'continue'].includes(action) &&
      (!deps.enabled || !deps.r2)
    )
      throw new TeamFunctionError('CATALOG_IMAGE_IMPORT_DISABLED');
    const value = await catalogImageRpc(deps.service, 'service_catalog_image_control_v2', {
      p_action: action,
      p_actor: actor,
      p_payload: payload
    });
    if (action === 'capabilities') {
      if (!isCatalogImageCapabilities(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      return successResponse(
        {
          ...value,
          enabled: deps.enabled && !!deps.r2 && value.enabled,
          importEnabled: deps.enabled && !!deps.r2 && value.importEnabled
        },
        headers
      );
    }
    if (action === 'grant') {
      const grant = catalogImageObject(value);
      return successResponse(
        await deps.r2!.stagingGrant(
          catalogImageString(grant.key),
          catalogImageString(grant.mime, 100),
          catalogImageString(grant.expiresAt),
          catalogImageInteger(grant.generation)
        ),
        headers
      );
    }
    const valid =
      action === 'list'
        ? isCatalogImageImportList(value)
        : action === 'inventory'
          ? isCatalogImageInventory(value)
          : ['dictionary', 'remove', 'revoke'].includes(action)
            ? isCatalogImageDictionaryPage(value)
            : isCatalogImageImportJob(value);
    if (!valid) throw new TeamFunctionError('INVALID_RESPONSE');
    if (['begin', 'seal', 'delivered', 'retry', 'continue', 'revoke'].includes(action))
      await catalogImageRpc(deps.service, 'service_catalog_image_kick_v2', {}).catch(
        () => undefined
      );
    return successResponse(value, headers, asynchronous ? 202 : 200);
  } catch (error) {
    return errorResponse(
      error instanceof TeamFunctionError
        ? error
        : new TeamFunctionError('IMAGE_PROVIDER_UNAVAILABLE', { retryable: true }),
      headers
    );
  }
}
