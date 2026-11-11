// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import {
  isCatalogVideoR2Availability,
  isCatalogVideoR2PreferenceReceipt,
  isCatalogVideoR2Signals,
  isCatalogVideoR2State,
  isCatalogVideoR2Usage,
  parseCatalogVideoR2WorkerRoute
} from '../../../packages/shared/dist/team/catalog-video-r2.js';
import { corsHeadersForRequest } from '../_shared/cors.ts';
import { errorResponse, successResponse, TeamFunctionError } from '../_shared/errors.ts';
import {
  videoR2Id,
  videoR2Object,
  videoR2Rpc,
  type CatalogVideoR2Rpc
} from '../_shared/catalog-video-r2.ts';
import { isRecord } from '../_shared/validation.ts';

export interface CatalogVideoR2HandlerDeps {
  service: CatalogVideoR2Rpc;
  authorize(request: Request): Promise<string>;
  authorizeWorker(request: Request): Promise<void>;
  runWorker(route: 'claim' | 'sweep'): Promise<unknown>;
  /** Runtime gate: env `CATALOG_VIDEOS_ENABLED` and a complete, confirmed bucket configuration. */
  enabled: boolean;
  configuredOrigin: string | null;
  siteUrl: string;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const buffer = new Uint8Array(65_536);
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
    if (!isRecord(value)) throw new TeamFunctionError('INVALID_INPUT');
    return value;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function handleCatalogVideoR2(
  request: Request,
  deps: CatalogVideoR2HandlerDeps
): Promise<Response> {
  const cors = corsHeadersForRequest(request, deps.siteUrl);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
  if (request.headers.has('origin') && !cors)
    return errorResponse(new TeamFunctionError('PERMISSION_DENIED'));
  const headers = cors ?? {};
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*\/catalog-video-r2/u, '') || '/';
    if (path === '/worker') {
      if (request.method !== 'POST') throw new TeamFunctionError('INVALID_INPUT');
      await deps.authorizeWorker(request);
      const route = parseCatalogVideoR2WorkerRoute(await bodyOf(request));
      if (!route) throw new TeamFunctionError('INVALID_INPUT');
      return successResponse(await deps.runWorker(route), headers);
    }
    const actor = await deps.authorize(request);
    const rpc = (name: string, parameters: Record<string, unknown>) =>
      videoR2Rpc(deps.service, name, parameters);
    if (request.method === 'GET' && path === '/availability') {
      const teamId = videoR2Id(url.searchParams.get('teamId'));
      const value = videoR2Object(
        await rpc('service_catalog_video_r2_availability', { p_actor: actor, p_team: teamId })
      );
      const canManage = value.canManage === true;
      // The database decides policy and enablement; the runtime decides whether the
      // bucket it would write to is the one the database hands out links for.
      const runtimeOk =
        deps.enabled &&
        deps.configuredOrigin !== null &&
        (value.available !== true || value.publicOrigin === deps.configuredOrigin);
      const answer = runtimeOk
        ? {
            available: value.available === true,
            ...(value.available === true ? {} : { reason: value.reason }),
            canManage,
            contractVersion: 1
          }
        : { available: false, reason: 'VIDEO_R2_NOT_CONFIGURED', canManage, contractVersion: 1 };
      if (!isCatalogVideoR2Availability(answer)) throw new TeamFunctionError('INVALID_RESPONSE');
      return successResponse(answer, headers);
    }
    if (request.method === 'GET' && path === '/usage') {
      const teamId = videoR2Id(url.searchParams.get('teamId'));
      const value = await rpc('service_catalog_video_r2_usage', { p_actor: actor, p_team: teamId });
      if (!isCatalogVideoR2Usage(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      return successResponse(value, headers);
    }
    if (request.method === 'GET' && path === '/signals') {
      const teamId = videoR2Id(url.searchParams.get('teamId'));
      const value = await rpc('service_catalog_video_r2_signals', {
        p_actor: actor,
        p_team: teamId
      });
      if (!isCatalogVideoR2Signals(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      return successResponse(value, headers);
    }
    const route = /^\/catalogs\/([^/]+)\/(state|preference)$/u.exec(path);
    if (!route) throw new TeamFunctionError('NOT_FOUND');
    const catalogId = videoR2Id(route[1]);
    if (route[2] === 'state') {
      if (request.method !== 'GET') throw new TeamFunctionError('INVALID_INPUT');
      const value = await rpc('service_catalog_video_r2_state', {
        p_actor: actor,
        p_catalog: catalogId
      });
      if (!isCatalogVideoR2State(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      return successResponse(value, headers);
    }
    if (request.method !== 'POST') throw new TeamFunctionError('INVALID_INPUT');
    const body = await bodyOf(request);
    if (typeof body.enabled !== 'boolean') throw new TeamFunctionError('INVALID_INPUT');
    if (body.enabled && (!deps.enabled || deps.configuredOrigin === null))
      throw new TeamFunctionError('VIDEO_R2_NOT_CONFIGURED');
    const value = await rpc('service_catalog_video_r2_set_preference', {
      p_actor: actor,
      p_catalog: catalogId,
      p_enabled: body.enabled
    });
    if (!isCatalogVideoR2PreferenceReceipt(value)) throw new TeamFunctionError('INVALID_RESPONSE');
    return successResponse(value, headers);
  } catch (error) {
    return errorResponse(
      error instanceof TeamFunctionError
        ? error
        : new TeamFunctionError('VIDEO_R2_PROVIDER_UNAVAILABLE', { retryable: true }),
      headers
    );
  }
}
