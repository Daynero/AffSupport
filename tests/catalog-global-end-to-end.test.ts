import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import {
  globalTestDb,
  activateGlobalFixture,
  GLOBAL_OWNER,
  GLOBAL_IMAGE
} from './support/catalog-global-db.js';
import { globalFixtureId } from './fixtures/catalog-global.js';
import type { TeamTestDb } from './support/team-db.js';
import { handleGlobalCatalogImages } from '../supabase/functions/catalog-global-images/handler.ts';
import {
  runGlobalImageWorker,
  readGlobalWorkerKeys
} from '../supabase/functions/catalog-global-images/worker.ts';
import { handleGlobalImageDelivery } from '../apps/catalog-image-delivery/src/handler.js';
import { CatalogImageR2 } from '../supabase/functions/_shared/r2-catalog-images.ts';
import { isGlobalCatalogImage } from '../packages/shared/src/team/catalog-global-images.js';
import { pairCatalogImageRow } from '../supabase/functions/_shared/catalog-image-rows.ts';
let db: TeamTestDb, team: string;
beforeAll(async () => {
  ({ db, team } = await globalTestDb());
}, 60_000);
afterAll(async () => {
  await db?.close();
});
it('imports through real routes and SQL, serves real signed aliases, then freezes and confirms an entire recipe', async () => {
  // Only provider transport is in memory. Handler, worker, HMAC delivery and all RPCs are real.
  const source = new Uint8Array(readFileSync('tests/fixtures/catalog-images/garment.png'));
  const objects = new Map<string, { bytes: ArrayBuffer; mime: string }>();
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    const key =
      url.hostname === 'media.example.test' ? `public${url.pathname}` : url.pathname.slice(1);
    if (request.method === 'PUT') {
      if (request.headers.get('if-none-match') === '*' && objects.has(key))
        return new Response(null, { status: 412 });
      objects.set(key, {
        bytes: await request.arrayBuffer(),
        mime: request.headers.get('content-type') ?? ''
      });
      return new Response(null, { status: 201 });
    }
    if (request.method === 'GET') {
      const item = objects.get(key);
      return item
        ? new Response(item.bytes.slice(0), {
            headers: {
              'content-type': item.mime,
              'content-length': String(item.bytes.byteLength),
              'x-content-type-options': 'nosniff'
            }
          })
        : new Response(null, { status: 404 });
    }
    throw new Error('Unexpected provider write');
  });
  const service = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (
        !/^service_catalog_global_[a-z_]+$/u.test(name) ||
        Object.keys(params).some(key => !/^p_[a-z_]+$/u.test(key))
      )
        throw new Error('Unexpected RPC');
      try {
        const [row] = await db.root<{ value: unknown }>(
          `select public.${name}(${Object.keys(params)
            .map((key, index) => `${key} => $${index + 1}`)
            .join(',')}) value`,
          Object.values(params).map(value =>
            value && typeof value === 'object' ? JSON.stringify(value) : value
          )
        );
        return { data: row?.value ?? null, error: null };
      } catch (error) {
        return {
          data: null,
          error: { message: error instanceof Error ? error.message : 'INVALID_RESPONSE' }
        };
      }
    }
  };
  const r2 = new CatalogImageR2(
    {
      accountId: 'a'.repeat(32),
      stagingBucket: 'staging',
      publicBucket: 'public',
      publicOrigin: 'https://media.example.test',
      zoneId: 'b'.repeat(32),
      purgeToken: 'synthetic'
    },
    { sign: async request => request },
    transport
  );
  const keys = await readGlobalWorkerKeys(
    JSON.stringify({
      '1': Buffer.alloc(32, 7).toString('base64'),
      '2': Buffer.alloc(32, 8).toString('base64')
    })
  );
  let deliveryKeys = keys;
  const delivery: typeof fetch = async (input, init) =>
    handleGlobalImageDelivery(new Request(input, init), {
      environment: 'beta',
      canonicalOrigin: r2.config.publicOrigin,
      keys: deliveryKeys,
      fetcher: transport
    });
  const route = async (action: string, payload: Record<string, unknown> = {}) => {
    const response = await handleGlobalCatalogImages(
      new Request('https://backend.test/functions/v1/catalog-global-images/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload })
      }),
      {
        service,
        r2,
        siteUrl: 'https://soty.test',
        authorize: async () => GLOBAL_OWNER,
        authorizeWorker: async () => undefined,
        runWorker: async () => null
      }
    );
    const envelope = await response.json();
    expect(response.status, JSON.stringify(envelope)).toBe(200);
    return envelope.value as Record<string, unknown>;
  };
  const job = await route('begin', {
    idempotencyKey: 'wire-global-import',
    totalFiles: 1,
    totalBytes: String(source.length)
  });
  const manifest = await route('manifest', {
    jobId: job.id,
    pageKey: 'wire-page',
    entries: [
      {
        fileKey: 'wire-image',
        displayName: 'owned.png',
        size: source.length,
        mime: 'image/png',
        classification: {
          mode: 'unclassified',
          garment: null,
          color: null,
          reason: 'unknown',
          vocabularyVersion: 'catalog-clothing-v1'
        }
      }
    ]
  });
  await route('seal', { jobId: job.id });
  const entry = (manifest.entries as { id: string }[])[0]!;
  const grant = await route('grant', {
    jobId: job.id,
    entryId: entry.id,
    requestKey: 'wire-grant-01'
  });
  expect(
    (
      await transport(String(grant.url), {
        method: 'PUT',
        headers: grant.headers as Record<string, string>,
        body: new Uint8Array(source)
      })
    ).ok
  ).toBe(true);
  await route('delivered', { jobId: job.id, entryId: entry.id });
  expect(await runGlobalImageWorker({ service, r2, keys, fetcher: delivery })).toEqual({
    imported: true
  });
  const [imported] = await db.root<{ id: string }>(
    'select id from private.catalog_global_images where id<>$1',
    [GLOBAL_IMAGE]
  );
  expect(imported).toBeDefined();
  const aliases = await db.root<{ public_url: string }>(
    'select public_url from private.catalog_global_aliases where image_id=$1 order by generation',
    [imported!.id]
  );
  expect(aliases).toHaveLength(3);
  for (const alias of aliases) {
    const response = await delivery(alias.public_url);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }
  await db.root('update private.catalog_global_images set active=false where id=$1', [
    GLOBAL_IMAGE
  ]);
  await activateGlobalFixture(db);
  const catalog = globalFixtureId(78001),
    intent = globalFixtureId(78002);
  const result = await service.rpc('service_catalog_global_allocate', {
    p_actor: GLOBAL_OWNER,
    p_team: team,
    p_catalog: catalog,
    p_intent: intent,
    p_count: 200,
    p_epoch: 1
  });
  expect(result.error).toBeNull();
  const images = (result.data as { images: unknown[] }).images;
  expect(images).toHaveLength(200);
  expect(images.every(isGlobalCatalogImage)).toBe(true);
  const outgoing = images.map(image => {
    if (!isGlobalCatalogImage(image)) throw new Error('Invalid frozen image');
    return pairCatalogImageRow(
      { title: 'Generic', description: 'Item', price: 10, imageLink: '' },
      image,
      { allowTextGeneration: true }
    );
  });
  const requestsBefore = transport.mock.calls.length;
  expect(outgoing.every(row => row.imageLink === aliases[0]!.public_url)).toBe(true);
  expect(
    await service.rpc('service_catalog_global_validate_rows', { p_team: team, p_images: images })
  ).toMatchObject({ error: null });
  expect(transport.mock.calls.length).toBe(requestsBefore);
  const confirmed = await service.rpc('service_catalog_global_confirm', {
    p_team: team,
    p_intent: intent,
    p_completion: intent
  });
  expect(confirmed).toMatchObject({ data: { confirmed: 1 }, error: null });
  expect(
    await service.rpc('service_catalog_global_confirm', {
      p_team: team,
      p_intent: intent,
      p_completion: intent
    })
  ).toMatchObject({ data: { confirmed: 0 }, error: null });
  const reusedJob = await route('begin', {
    idempotencyKey: 'wire-global-reimport',
    totalFiles: 1,
    totalBytes: String(source.length)
  });
  const reusedManifest = await route('manifest', {
    jobId: reusedJob.id,
    pageKey: 'one',
    entries: [
      {
        fileKey: 'same',
        displayName: 'same-bytes.png',
        size: source.length,
        mime: 'image/png',
        classification: {
          mode: 'unclassified',
          garment: null,
          color: null,
          reason: 'unknown',
          vocabularyVersion: 'catalog-clothing-v1'
        }
      }
    ]
  });
  await route('seal', { jobId: reusedJob.id });
  const reusedEntry = (reusedManifest.entries as { id: string }[])[0]!;
  const reusedGrant = await route('grant', {
    jobId: reusedJob.id,
    entryId: reusedEntry.id,
    requestKey: 'wire-reused-01'
  });
  await transport(String(reusedGrant.url), {
    method: 'PUT',
    headers: reusedGrant.headers as Record<string, string>,
    body: new Uint8Array(source)
  });
  await route('delivered', { jobId: reusedJob.id, entryId: reusedEntry.id });
  const publicPutCount = () =>
    transport.mock.calls.filter(([input, init]) => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const url = input instanceof Request ? input.url : String(input);
      return method === 'PUT' && new URL(url).pathname.startsWith('/public/');
    }).length;
  const priorPuts = publicPutCount();
  expect(await runGlobalImageWorker({ service, r2, keys, fetcher: delivery })).toEqual({
    imported: true
  });
  expect(publicPutCount()).toBe(priorPuts);
  const [reuseState] = await db.root<{ state: string; image_id: string }>(
    'select state,image_id from private.catalog_global_entries where id=$1',
    [reusedEntry.id]
  );
  expect(reuseState).toEqual({ state: 'reused', image_id: imported!.id });
  expect(
    (
      await db.root<{ issued: string }>(
        'select issued_seq::text issued from private.catalog_global_images where id=$1',
        [imported!.id]
      )
    )[0]!.issued
  ).toBe('1');
  // Controlled issued history moves current+2 beyond the old key's closed URLs.
  await db.root('update private.catalog_global_images set issued_seq=600 where id=$1', [
    imported!.id
  ]);
  await route('configure', {
    environment: 'beta',
    mediaOrigin: r2.config.publicOrigin,
    routingRevision: 'fixture-keys-v2',
    acceptedKeyVersions: [2, 1]
  });
  deliveryKeys = new Map([[2, keys.get(2)!]]);
  await db.root(
    'update private.catalog_global_images set next_probe_at=clock_timestamp() where id=$1',
    [imported!.id]
  );
  await runGlobalImageWorker({ service, r2, keys, fetcher: delivery });
  expect(
    (
      await db.root<{ state: string }>(
        'select state from private.catalog_global_images where id=$1',
        [imported!.id]
      )
    )[0]!.state
  ).toBe('unknown');
  expect((await delivery(aliases[0]!.public_url)).status).toBe(404);
  deliveryKeys = keys;
  await db.root(
    'update private.catalog_global_images set next_probe_at=clock_timestamp() where id=$1',
    [imported!.id]
  );
  await runGlobalImageWorker({ service, r2, keys, fetcher: delivery });
  expect(
    (
      await db.root<{ state: string; issued: string }>(
        'select state,issued_seq::text issued from private.catalog_global_images where id=$1',
        [imported!.id]
      )
    )[0]
  ).toEqual({ state: 'ready', issued: '600' });
  expect((await delivery(aliases[0]!.public_url)).status).toBe(200);
  expect(
    await service.rpc('service_catalog_global_validate_rows', { p_team: team, p_images: images })
  ).toMatchObject({ error: null });
});
