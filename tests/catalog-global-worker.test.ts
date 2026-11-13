import { readFileSync } from 'node:fs';
import { it, expect, vi } from 'vitest';
import {
  runGlobalImageWorker,
  readGlobalWorkerKeys
} from '../supabase/functions/catalog-global-images/worker.ts';
import { CatalogImageR2 } from '../supabase/functions/_shared/r2-catalog-images.ts';
import { optimizeCatalogImage } from '../supabase/functions/_shared/catalog-image-optimization.ts';
import { globalFixtureId } from './fixtures/catalog-global.js';
it('publishes canonical bytes once and requires three anonymous alias readbacks before ready', async () => {
  const source = new Uint8Array(readFileSync('tests/fixtures/catalog-images/garment.png')),
    canonical = await optimizeCatalogImage(source, 'image/png');
  const id = globalFixtureId(70001),
    entry = globalFixtureId(70002);
  let bytes: Uint8Array | null = null;
  const calls: string[] = [];
  const r2 = new CatalogImageR2(
    {
      accountId: 'a'.repeat(32),
      stagingBucket: 'staging',
      publicBucket: 'public',
      publicOrigin: 'https://media.test',
      zoneId: 'b'.repeat(32),
      purgeToken: 'synthetic'
    },
    { sign: async request => request },
    async input => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === 'PUT') {
        expect(request.headers.get('if-none-match')).toBe('*');
        bytes = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 201 });
      }
      return new Response(
        new Uint8Array(request.url.includes('/staging/') ? source : (bytes ?? [])),
        { headers: { 'content-type': 'image/png' } }
      );
    }
  );
  const service = {
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      const action = String(params.p_action ?? name);
      calls.push(action);
      if (action === 'probe_candidates') return { data: [], error: null };
      if (action === 'claim')
        return {
          data: {
            id: entry,
            jobId: globalFixtureId(70003),
            fence: '1',
            stagingKey: globalFixtureId(70004),
            size: source.length,
            mime: 'image/png',
            environment: 'beta',
            origin: 'https://media.test',
            revision: 'fixture',
            keyVersion: 1
          },
          error: null
        };
      if (action === 'reserve')
        return {
          data: {
            id,
            key: `g1/${id}`,
            sha256: canonical.image.sha256,
            mime: 'image/png',
            size: canonical.bytes.length,
            ready: false
          },
          error: null
        };
      if (name === 'service_catalog_global_alias_plan')
        return {
          data: [1, 2, 3].map(generation => ({ generation, keyVersion: 1, url: null })),
          error: null
        };
      return { data: { accepted: true }, error: null };
    })
  };
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array(bytes ?? []), {
        headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' }
      })
  );
  const keys = await readGlobalWorkerKeys(
    JSON.stringify({ '1': Buffer.alloc(32, 7).toString('base64') })
  );
  expect(await runGlobalImageWorker({ service, r2, keys, fetcher })).toEqual({ imported: true });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(calls.filter(action => action === 'alias')).toHaveLength(3);
  expect(calls.indexOf('probe_candidates')).toBeLessThan(calls.indexOf('claim'));
  expect(calls).toContain('service_catalog_global_kick');
  expect(calls.indexOf('probe')).toBeLessThan(calls.indexOf('finish'));
});
it('leaves a lost provider write unknown without publishing ready metadata', async () => {
  const calls: string[] = [];
  const service = {
    rpc: vi.fn(async (_name: string, params: Record<string, unknown>) => {
      const action = String(params.p_action);
      calls.push(action);
      if (action === 'probe_candidates') return { data: [], error: null };
      return {
        data:
          action === 'claim'
            ? {
                id: globalFixtureId(71001),
                jobId: globalFixtureId(71002),
                fence: '1',
                stagingKey: globalFixtureId(71003),
                size: 100,
                mime: 'image/png'
              }
            : { accepted: true },
        error: null
      };
    })
  };
  const r2 = new CatalogImageR2(
    {
      accountId: 'a'.repeat(32),
      stagingBucket: 'staging',
      publicBucket: 'public',
      publicOrigin: 'https://media.test',
      zoneId: 'b'.repeat(32),
      purgeToken: 'synthetic'
    },
    { sign: async request => request },
    async () => {
      throw new Error('synthetic lost provider response');
    }
  );
  expect(await runGlobalImageWorker({ service, r2, keys: new Map() })).toMatchObject({
    outcome: 'unknown'
  });
  expect(calls).not.toContain('probe');
  expect(calls).toContain('finish');
});
it('refreshes serving health before a failed import and still schedules the next bounded item', async () => {
  const source = new Uint8Array(readFileSync('tests/fixtures/catalog-images/garment.png'));
  const canonical = await optimizeCatalogImage(source, 'image/png');
  const id = globalFixtureId(72001),
    calls: string[] = [];
  const service = {
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      const action = String(params.p_action ?? name);
      calls.push(action);
      if (action === 'probe_candidates')
        return {
          data: [
            {
              id,
              key: `g1/${id}`,
              sha256: canonical.image.sha256,
              mime: canonical.image.mime,
              size: canonical.bytes.length,
              environment: 'beta',
              origin: 'https://media.test',
              revision: 'fixture',
              keyVersion: 1
            }
          ],
          error: null
        };
      if (name === 'service_catalog_global_alias_plan')
        return {
          data: [1, 2, 3].map(generation => ({ generation, keyVersion: 1, url: null })),
          error: null
        };
      if (action === 'claim')
        return {
          data: {
            id: globalFixtureId(72002),
            fence: '1',
            stagingKey: 'missing',
            size: 100,
            mime: 'image/png'
          },
          error: null
        };
      return { data: { accepted: true }, error: null };
    })
  };
  const r2 = new CatalogImageR2(
    {
      accountId: 'a'.repeat(32),
      stagingBucket: 'staging',
      publicBucket: 'public',
      publicOrigin: 'https://media.test',
      zoneId: 'b'.repeat(32),
      purgeToken: 'synthetic'
    },
    { sign: async request => request },
    async input => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url.includes('/staging/')) throw new Error('synthetic import failure');
      return new Response(new Uint8Array(canonical.bytes), {
        headers: { 'content-type': canonical.image.mime }
      });
    }
  );
  const keys = await readGlobalWorkerKeys(
    JSON.stringify({ '1': Buffer.alloc(32, 7).toString('base64') })
  );
  const outcome = await runGlobalImageWorker({
    service,
    r2,
    keys,
    fetcher: async () =>
      new Response(new Uint8Array(canonical.bytes), {
        headers: { 'content-type': canonical.image.mime, 'x-content-type-options': 'nosniff' }
      })
  });
  expect(outcome).toMatchObject({ outcome: 'unknown' });
  expect(calls.indexOf('probe')).toBeLessThan(calls.indexOf('claim'));
  expect(calls).toContain('service_catalog_global_kick');
});
