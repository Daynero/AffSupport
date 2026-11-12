import { isCatalogImageClassification } from '../../../packages/shared/dist/team/catalog-images.js';
import { corsHeadersForRequest } from '../_shared/cors.ts';
import { errorResponse, successResponse, TeamFunctionError } from '../_shared/errors.ts';
import {
  catalogImageObject,
  catalogImageRpc,
  catalogImageId,
  type CatalogImageRpc
} from '../_shared/catalog-images.ts';
import type { CatalogImageR2 } from '../_shared/r2-catalog-images.ts';
import { readGlobalImageReadiness } from '../_shared/catalog-global-images.ts';
export interface GlobalHandlerDeps {
  service: CatalogImageRpc;
  r2: CatalogImageR2 | null;
  siteUrl: string;
  authorize(request: Request): Promise<string>;
  authorizeWorker(request: Request): Promise<void>;
  runWorker(): Promise<unknown>;
}
export async function handleGlobalCatalogImages(
  request: Request,
  deps: GlobalHandlerDeps
): Promise<Response> {
  const cors = corsHeadersForRequest(request, deps.siteUrl);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
  try {
    if (request.headers.has('origin') && !cors) throw new TeamFunctionError('PERMISSION_DENIED');
    const url = new URL(request.url),
      path = url.pathname.replace(/^.*\/catalog-global-images/u, '') || '/';
    if (path === '/worker' && request.method === 'POST') {
      await deps.authorizeWorker(request);
      return successResponse(await deps.runWorker(), cors ?? {});
    }
    const actor = await deps.authorize(request);
    if (path === '/readiness' && request.method === 'GET')
      return successResponse(
        await readGlobalImageReadiness(
          deps.service,
          actor,
          url.searchParams.has('teamId')
            ? catalogImageId(url.searchParams.get('teamId'))
            : undefined
        ),
        cors ?? {}
      );
    if (path !== '/control' || request.method !== 'POST')
      throw new TeamFunctionError('INVALID_INPUT');
    // A streamed cap applies even when Content-Length is absent or dishonest.
    const reader = request.body?.getReader();
    if (!reader) throw new TeamFunctionError('INVALID_INPUT');
    const buffer = new Uint8Array(64_000);
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.length > buffer.length) {
          await reader.cancel();
          throw new TeamFunctionError('TOO_LARGE');
        }
        buffer.set(chunk.value, size);
        size += chunk.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))
      );
    } catch {
      throw new TeamFunctionError('INVALID_INPUT');
    }
    const body = catalogImageObject(decoded),
      payload = catalogImageObject(body.payload ?? {});
    if (
      typeof body.action !== 'string' ||
      ![
        'configure',
        'begin',
        'manifest',
        'seal',
        'get',
        'grant',
        'delivered',
        'cancel',
        'retry',
        'prepare',
        'resume_legacy',
        'activate',
        'status'
      ].includes(body.action)
    )
      throw new TeamFunctionError('INVALID_INPUT');
    if (body.action === 'manifest') {
      if (
        !Array.isArray(payload.entries) ||
        payload.entries.length < 1 ||
        payload.entries.length > 100 ||
        !payload.entries.every(raw =>
          isCatalogImageClassification(catalogImageObject(raw).classification)
        )
      )
        throw new TeamFunctionError('INVALID_INPUT');
    }
    const control =
      body.action === 'prepare' ||
      body.action === 'resume_legacy' ||
      body.action === 'activate' ||
      body.action === 'status'
        ? 'service_catalog_global_cutover'
        : 'service_catalog_global_control';
    const result = await catalogImageRpc(deps.service, control, {
      p_actor: actor,
      p_action: body.action,
      p_payload: payload
    });
    if (['seal', 'delivered', 'retry'].includes(body.action))
      await catalogImageRpc(deps.service, 'service_catalog_global_kick', {}).catch(() => undefined);
    if (body.action === 'grant') {
      if (!deps.r2) throw new TeamFunctionError('GLOBAL_IMAGE_READINESS_UNKNOWN');
      const value = catalogImageObject(result);
      return successResponse(
        await deps.r2.stagingGrant(
          String(value.stagingKey),
          String(value.mime),
          String(value.expiresAt),
          Number(value.generation)
        ),
        cors ?? {}
      );
    }
    return successResponse(result, cors ?? {});
  } catch (error) {
    return errorResponse(
      error instanceof TeamFunctionError ? error : new TeamFunctionError('INVALID_INPUT'),
      cors ?? {}
    );
  }
}
