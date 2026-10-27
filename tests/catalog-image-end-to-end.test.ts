import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  isCatalogImageCapabilities,
  isCatalogImageDictionaryPage,
  isCatalogImageGrant,
  isCatalogImageImportJob,
  isCatalogImageInventory,
  type CatalogImageImportJob
} from '../packages/shared/src/team/catalog-images';
import {
  handleCatalogImages,
  type CatalogImageHandlerDeps
} from '../supabase/functions/catalog-images/handler';
import { runCatalogImageWorker } from '../supabase/functions/catalog-images/worker';
import { CatalogImageR2 } from '../supabase/functions/_shared/r2-catalog-images';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { drawCatalogImagePool } from '../supabase/functions/_shared/catalog-image-draw';
import { planCatalogRows } from '../supabase/functions/_shared/product-catalog';
import { isR2CatalogImage } from '../packages/shared/src/team/catalog-images';

const OWNER = '45000000-0000-4000-8000-000000000711';
const ATTEMPT = '45000000-0000-4000-8000-000000000712';
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64'
  )
);
let db: TeamTestDb;
let team: string;
let deps: CatalogImageHandlerDeps;
let transport: typeof fetch;
const objects = new Map<string, { bytes: ArrayBuffer; mime: string }>();
const driveRead = vi.fn(async (): Promise<Uint8Array> => {
  throw new Error('Local source must never read Drive');
});

// Behave like PostgREST named-argument RPC against the real complete migration chain.
// Only the outer provider transport is replaced; no handler/worker RPC reply is mocked.
const service: ServiceRpcClient = {
  async rpc(name, params) {
    if (
      !/^service_(?:catalog_image_\w+|draw_product_catalog_images_v2)$/u.test(name) ||
      Object.keys(params).some(key => !/^p_[a-z_]+$/u.test(key))
    )
      throw new Error('Unexpected RPC');
    const values = Object.values(params).map(value =>
      value && typeof value === 'object' ? JSON.stringify(value) : value
    );
    try {
      const rows = await db.root<{ value: unknown }>(
        `select public.${name}(${Object.keys(params)
          .map((key, index) => `${key} => $${index + 1}`)
          .join(',')}) value`,
        values
      );
      return { data: rows[0]?.value ?? null, error: null };
    } catch (error) {
      return {
        data: null,
        error: { message: error instanceof Error ? error.message : 'Unknown database error' }
      };
    }
  }
};

async function route(path: string, body?: unknown) {
  const response = await handleCatalogImages(
    new Request(`https://backend.test/functions/v1/catalog-images${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    deps
  );
  const envelope: unknown = await response.json();
  expect(response.status, JSON.stringify(envelope)).toBeLessThan(300);
  expect(envelope).toMatchObject({ ok: true });
  return (envelope as { value: unknown }).value;
}
function snapshot(value: unknown): CatalogImageImportJob {
  expect(isCatalogImageImportJob(value)).toBe(true);
  if (!isCatalogImageImportJob(value)) throw new Error('Invalid real job response');
  return value;
}

beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261206152000_catalog_r2_integration.sql' });
  await createUser(db, { id: OWNER, email: 'image-wire-owner@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Image wire')")
  )[0]!.id;
  await db.root(
    'insert into private.catalog_image_config(team_id,import_enabled) values($1,true)',
    [team]
  );
  transport = vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = url.hostname === 'media.test' ? `public${url.pathname}` : url.pathname.slice(1);
    if (request.method === 'PUT') {
      if (request.headers.get('if-none-match') === '*' && objects.has(key))
        return new Response(null, { status: 412 });
      objects.set(key, {
        bytes: await request.arrayBuffer(),
        mime: request.headers.get('content-type') ?? ''
      });
      return new Response(null, { status: 200 });
    }
    if (request.method === 'GET') {
      const object = objects.get(key);
      return object
        ? new Response(object.bytes.slice(0), {
            headers: {
              'content-type': object.mime,
              'content-length': String(object.bytes.byteLength),
              'x-content-type-options': 'nosniff'
            }
          })
        : new Response(null, { status: 404 });
    }
    throw new Error('Unexpected provider operation');
  });
  const r2 = new CatalogImageR2(
    {
      accountId: 'a'.repeat(32),
      stagingBucket: 'staging',
      publicBucket: 'public',
      publicOrigin: 'https://media.test',
      zoneId: 'b'.repeat(32),
      purgeToken: 'test-only'
    },
    { sign: async request => request },
    transport
  );
  deps = {
    enabled: true,
    siteUrl: 'https://soty.test',
    r2,
    service,
    authorize: async () => OWNER,
    authorizeWorker: async () => undefined,
    runWorker: () =>
      runCatalogImageWorker({
        service,
        r2,
        enabled: true,
        readDrive: driveRead,
        enumerateDrive: async () => {
          throw new Error('Local import must never enumerate Drive');
        }
      })
  };
}, 60_000);
afterAll(async () => {
  await db?.close();
});

describe('real image route → SQL → worker → public readback → dictionary', () => {
  it('publishes an ordinary image, observes readiness and draws its immutable URL into catalog rows', async () => {
    expect(isCatalogImageCapabilities(await route(`/capabilities?teamId=${team}`))).toBe(true);
    const accepted = snapshot(
      await route('/imports', {
        teamId: team,
        contractVersion: 2,
        sourceKind: 'local',
        idempotencyKey: 'wire-import-request-01'
      })
    );
    const manifested = snapshot(
      await route(`/imports/${accepted.id}/manifest`, {
        pageKey: 'wire-manifest-page-01',
        entries: [
          {
            clientFileKey: 'wire-file-01',
            name: 'IMG_2031.png',
            declaredSize: PNG.length,
            declaredMime: 'image/png'
          }
        ]
      })
    );
    const sealed = snapshot(
      await route(`/imports/${accepted.id}/seal`, {
        revision: manifested.revision,
        manifestCount: 1
      })
    );
    const entry = sealed.entries[0]!;
    const grant = await route(`/imports/${accepted.id}/entries/${entry.id}/grant`, {
      generation: entry.grantGeneration ?? 0,
      requestKey: 'wire-grant-request-01'
    });
    expect(isCatalogImageGrant(grant)).toBe(true);
    if (!isCatalogImageGrant(grant)) throw new Error('Invalid real grant');
    expect(
      (await transport(grant.url, { method: 'PUT', headers: grant.headers, body: PNG })).ok
    ).toBe(true);
    snapshot(
      await route(`/imports/${accepted.id}/entries/${entry.id}/delivered`, {
        grantGeneration: grant.generation,
        requestKey: 'wire-delivery-request-01'
      })
    );
    expect(await route('/worker', {})).toMatchObject({
      outcome: 'ready',
      classificationMode: 'unclassified'
    });
    const completed = snapshot(await route(`/imports/${accepted.id}`));
    expect(completed.state).toBe('completed');
    expect(completed.counts).toMatchObject({ total: 1, ready: 1, unclassified: 1, failed: 0 });
    const dictionary = await route(`/dictionary?teamId=${team}`);
    expect(isCatalogImageDictionaryPage(dictionary)).toBe(true);
    if (!isCatalogImageDictionaryPage(dictionary)) throw new Error('Invalid dictionary');
    expect(dictionary.items).toHaveLength(1);
    expect(dictionary.items[0]!.classification.mode).toBe('unclassified');
    const inventory = await route(`/inventory?teamId=${team}`);
    expect(isCatalogImageInventory(inventory)).toBe(true);
    expect(inventory).toMatchObject({ total: 1, unclassified: 1, pairs: [] });
    const images = await drawCatalogImagePool(
      async (name, params) => {
        const reply = await service.rpc(name, params);
        if (reply.error) throw new Error(reply.error.message);
        return reply.data;
      },
      team,
      1,
      { contractVersion: 2, attemptId: ATTEMPT }
    );
    const selected = images[0];
    expect(isR2CatalogImage(selected)).toBe(true);
    if (!isR2CatalogImage(selected)) throw new Error('Invalid selected image');
    const rows = planCatalogRows({
      count: 1,
      settings: {
        title: 'Clothing item',
        description: 'Generic clothing.',
        imageLink: '',
        priceMin: 10,
        priceMax: 10
      },
      texts: [],
      images: [{ link: selected.publicUrl, image: selected }]
    });
    expect(rows?.[0]).toMatchObject({
      title: 'Clothing item',
      imageLink: dictionary.items[0]!.publicUrl
    });
    expect(driveRead).not.toHaveBeenCalled();
    const evidence = await db.root<{ stage: string }>(
      'select stage from public.analytics_catalog_image_journal where entry_id=$1 order by evidence_id::bigint',
      [entry.id]
    );
    expect(evidence.map(item => item.stage)).toEqual(
      expect.arrayContaining([
        'staged',
        'validating',
        'deduplicating',
        'publishing',
        'verifying_origin',
        'verifying_public',
        'committing',
        'ready'
      ])
    );
  });

  it('does not expose a signed input grant or private name in diagnostic projection', async () => {
    const evidence = await db.root('select * from public.analytics_catalog_image_journal');
    expect(JSON.stringify(evidence)).not.toMatch(
      /IMG_2031|r2\.cloudflarestorage|publicUrl|stagingKey|sha256/u
    );
    expect(objects.size).toBe(2);
  });
});
