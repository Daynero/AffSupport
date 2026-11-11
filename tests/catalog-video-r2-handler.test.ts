import { describe, expect, it, vi } from 'vitest';
import {
  handleCatalogVideoR2,
  type CatalogVideoR2HandlerDeps
} from '../supabase/functions/catalog-video-r2/handler';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

const TEAM = '50000000-0000-4000-8000-000000000401';
const CATALOG = '50000000-0000-4000-8000-000000000402';
const ACTOR = '50000000-0000-4000-8000-000000000403';
const BASE = 'https://project.supabase.co/functions/v1/catalog-video-r2';

function harness(
  overrides: Partial<CatalogVideoR2HandlerDeps> = {},
  answers: Record<string, unknown> = {}
) {
  const rpc = vi.fn(async (name: string) => {
    if (name in answers) return { data: answers[name], error: null };
    return { data: null, error: { message: 'NOT_FOUND' } };
  });
  const runWorker = vi.fn(async (route: string) => ({ route }));
  const deps: CatalogVideoR2HandlerDeps = {
    service: { rpc },
    authorize: async request => {
      if (request.headers.get('authorization') !== 'Bearer user')
        throw new TeamFunctionError('AUTH_REQUIRED');
      return ACTOR;
    },
    authorizeWorker: async request => {
      if (request.headers.get('x-catalog-sync-secret') !== 's'.repeat(40))
        throw new TeamFunctionError('AUTH_REQUIRED');
    },
    runWorker,
    enabled: true,
    configuredOrigin: 'https://videos.test',
    siteUrl: 'https://app.test',
    ...overrides
  };
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { authorization: 'Bearer user' }
  ) => {
    const response = await handleCatalogVideoR2(
      new Request(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      deps
    );
    return {
      status: response.status,
      body: (await response.json()) as { ok: boolean; value?: unknown; error?: { code: string } }
    };
  };
  return { call, rpc, runWorker };
}

describe('catalog video R2 handler', () => {
  it('gates availability on the runtime configuration and the database policy together', async () => {
    const dbAvailable = {
      available: true,
      canManage: true,
      contractVersion: 1,
      publicOrigin: 'https://videos.test'
    };
    const h = harness({}, { service_catalog_video_r2_availability: dbAvailable });
    expect((await h.call('GET', `/availability?teamId=${TEAM}`)).body.value).toEqual({
      available: true,
      canManage: true,
      contractVersion: 1
    });
    expect(h.rpc).toHaveBeenCalledWith('service_catalog_video_r2_availability', {
      p_actor: ACTOR,
      p_team: TEAM
    });
    const mismatched = harness(
      { configuredOrigin: 'https://other.test' },
      { service_catalog_video_r2_availability: dbAvailable }
    );
    expect((await mismatched.call('GET', `/availability?teamId=${TEAM}`)).body.value).toEqual({
      available: false,
      reason: 'VIDEO_R2_NOT_CONFIGURED',
      canManage: true,
      contractVersion: 1
    });
    const off = harness({ enabled: false }, { service_catalog_video_r2_availability: dbAvailable });
    expect((await off.call('GET', `/availability?teamId=${TEAM}`)).body.value).toMatchObject({
      available: false,
      reason: 'VIDEO_R2_NOT_CONFIGURED'
    });
    const pending = harness(
      {},
      {
        service_catalog_video_r2_availability: {
          available: false,
          reason: 'VIDEO_R2_POLICY_PENDING',
          canManage: false,
          contractVersion: 1
        }
      }
    );
    expect((await pending.call('GET', `/availability?teamId=${TEAM}`)).body.value).toEqual({
      available: false,
      reason: 'VIDEO_R2_POLICY_PENDING',
      canManage: false,
      contractVersion: 1
    });
    expect((await h.call('GET', '/availability?teamId=nope')).body.error?.code).toBe(
      'INVALID_INPUT'
    );
  });

  it('reads state and usage through the actor-bound RPCs and validates every answer', async () => {
    const state = {
      catalogMaterialId: CATALOG,
      enabled: true,
      link: 'r2',
      lastSuccessfulUpdateAt: null,
      copy: null,
      reason: null,
      usedBytes: 1,
      quotaBytes: 2,
      canManage: true,
      revision: 1
    };
    const h = harness(
      {},
      {
        service_catalog_video_r2_state: state,
        service_catalog_video_r2_usage: {
          usedBytes: 1,
          quotaBytes: 2,
          readyCopies: 1,
          retiringCopies: 0,
          enabledCatalogs: 1
        }
      }
    );
    expect((await h.call('GET', `/catalogs/${CATALOG}/state`)).body.value).toEqual(state);
    expect(h.rpc).toHaveBeenCalledWith('service_catalog_video_r2_state', {
      p_actor: ACTOR,
      p_catalog: CATALOG
    });
    expect((await h.call('GET', `/usage?teamId=${TEAM}`)).body.value).toMatchObject({
      readyCopies: 1
    });
    const broken = harness({}, { service_catalog_video_r2_state: { ...state, link: 'ftp' } });
    expect((await broken.call('GET', `/catalogs/${CATALOG}/state`)).body.error?.code).toBe(
      'INVALID_RESPONSE'
    );
    expect((await h.call('POST', `/catalogs/${CATALOG}/state`)).body.error?.code).toBe(
      'INVALID_INPUT'
    );
    expect((await h.call('GET', '/catalogs/not-a-uuid/state')).body.error?.code).toBe(
      'INVALID_INPUT'
    );
    expect((await h.call('GET', '/nowhere')).body.error?.code).toBe('NOT_FOUND');
  });

  it('lists every catalog option of a space in one read for the manager', async () => {
    const signal = {
      catalogMaterialId: CATALOG,
      enabled: true,
      link: 'r2',
      copyState: 'ready',
      reason: null,
      lastSuccessfulUpdateAt: '2026-11-11T00:00:00Z',
      revision: 3
    };
    const h = harness({}, { service_catalog_video_r2_signals: [signal] });
    expect((await h.call('GET', `/signals?teamId=${TEAM}`)).body.value).toEqual([signal]);
    expect(h.rpc).toHaveBeenCalledWith('service_catalog_video_r2_signals', {
      p_actor: ACTOR,
      p_team: TEAM
    });
    const broken = harness(
      {},
      { service_catalog_video_r2_signals: [{ ...signal, reason: 'free text' }] }
    );
    expect((await broken.call('GET', `/signals?teamId=${TEAM}`)).body.error?.code).toBe(
      'INVALID_RESPONSE'
    );
    expect((await h.call('GET', '/signals?teamId=nope')).body.error?.code).toBe('INVALID_INPUT');
  });

  it('writes the preference with the caller as actor and reports the server refusal codes', async () => {
    const h = harness(
      {},
      {
        service_catalog_video_r2_set_preference: {
          enabled: true,
          revision: 2,
          updatedAt: '2026-11-10T09:00:00Z'
        }
      }
    );
    const ok = await h.call('POST', `/catalogs/${CATALOG}/preference`, { enabled: true });
    expect(ok.body.value).toEqual({
      enabled: true,
      revision: 2,
      updatedAt: '2026-11-10T09:00:00Z'
    });
    expect(h.rpc).toHaveBeenCalledWith('service_catalog_video_r2_set_preference', {
      p_actor: ACTOR,
      p_catalog: CATALOG,
      p_enabled: true
    });
    expect(
      (await h.call('POST', `/catalogs/${CATALOG}/preference`, { enabled: 'yes' })).body.error?.code
    ).toBe('INVALID_INPUT');
    const denied = harness();
    denied.rpc.mockResolvedValueOnce({ data: null, error: { message: 'PERMISSION_DENIED' } });
    const refused = await denied.call('POST', `/catalogs/${CATALOG}/preference`, { enabled: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe('PERMISSION_DENIED');
    const unconfigured = harness({ enabled: false });
    expect(
      (await unconfigured.call('POST', `/catalogs/${CATALOG}/preference`, { enabled: true })).body
        .error?.code
    ).toBe('VIDEO_R2_NOT_CONFIGURED');
    expect(unconfigured.rpc).not.toHaveBeenCalled();
    const disableAnyway = harness(
      { enabled: false },
      {
        service_catalog_video_r2_set_preference: {
          enabled: false,
          revision: 3,
          updatedAt: '2026-11-10T09:00:00Z'
        }
      }
    );
    expect(
      (await disableAnyway.call('POST', `/catalogs/${CATALOG}/preference`, { enabled: false })).body
        .value
    ).toMatchObject({ enabled: false });
    const anonymous = await h.call('GET', `/catalogs/${CATALOG}/state`, undefined, {});
    expect(anonymous.body.error?.code).toBe('AUTH_REQUIRED');
  });

  it('runs the worker only for the named secret and a closed route', async () => {
    const h = harness();
    expect(
      (
        await h.call(
          'POST',
          '/worker',
          { route: 'claim' },
          { 'x-catalog-sync-secret': 's'.repeat(40) }
        )
      ).body.value
    ).toEqual({ route: 'claim' });
    expect(
      (
        await h.call(
          'POST',
          '/worker',
          { route: 'sweep' },
          { 'x-catalog-sync-secret': 's'.repeat(40) }
        )
      ).body.value
    ).toEqual({ route: 'sweep' });
    expect(
      (
        await h.call(
          'POST',
          '/worker',
          { route: 'drop' },
          { 'x-catalog-sync-secret': 's'.repeat(40) }
        )
      ).body.error?.code
    ).toBe('INVALID_INPUT');
    expect(
      (await h.call('POST', '/worker', { route: 'claim' }, { authorization: 'Bearer user' })).body
        .error?.code
    ).toBe('AUTH_REQUIRED');
    expect(
      (await h.call('GET', '/worker', undefined, { 'x-catalog-sync-secret': 's'.repeat(40) })).body
        .error?.code
    ).toBe('INVALID_INPUT');
    expect(h.runWorker).toHaveBeenCalledTimes(2);
    const browser = await handleCatalogVideoR2(
      new Request(`${BASE}/worker`, {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'x-catalog-sync-secret': 's'.repeat(40) },
        body: '{"route":"claim"}'
      }),
      {
        service: { rpc: vi.fn() },
        authorize: async () => ACTOR,
        authorizeWorker: async () => {},
        runWorker: async () => ({}),
        enabled: true,
        configuredOrigin: null,
        siteUrl: 'https://app.test'
      }
    );
    expect(browser.status).toBe(403);
  });
});
