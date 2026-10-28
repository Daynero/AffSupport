import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  isCatalogImageCapabilities,
  isCatalogImageDictionaryPage,
  isCatalogImageGrant,
  isCatalogImageImportJob,
  isCatalogImageInventory,
  isCatalogImageStorage,
  isCatalogImageLibraryPage,
  classifyCatalogImageName,
  type CatalogImageImportJob
} from '../packages/shared/src/team/catalog-images';
import {
  handleCatalogImages,
  type CatalogImageHandlerDeps
} from '../supabase/functions/catalog-images/handler';
import {
  runCatalogImageWorker,
  type CatalogImageWorkerDeps
} from '../supabase/functions/catalog-images/worker';
import { CatalogImageR2 } from '../supabase/functions/_shared/r2-catalog-images';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
import { drawCatalogImagePool } from '../supabase/functions/_shared/catalog-image-draw';
import { planCatalogRows } from '../supabase/functions/_shared/product-catalog';
import { isR2CatalogImage } from '../packages/shared/src/team/catalog-images';
import { optimizeCatalogImage } from '../supabase/functions/_shared/catalog-image-optimization';
import { validateCatalogImage } from '../supabase/functions/_shared/catalog-image-validation';
import { testPngChunk } from './support/catalog-image-fixtures';

const OWNER = '45000000-0000-4000-8000-000000000711';
const ATTEMPT = '45000000-0000-4000-8000-000000000712';
const originalPng = readFileSync('tests/fixtures/catalog-images/garment.png');
const PNG = Uint8Array.from(
  Buffer.concat([
    originalPng.subarray(0, 33),
    testPngChunk('tEXt', Buffer.from('Comment\0Removable wire metadata')),
    originalPng.subarray(33)
  ])
);
let canonical: Awaited<ReturnType<typeof optimizeCatalogImage>>;
let db: TeamTestDb;
let team: string;
let deps: CatalogImageHandlerDeps;
let transport: typeof fetch;
const objects = new Map<string, { bytes: ArrayBuffer; mime: string }>();
const driveRead = vi.fn<CatalogImageWorkerDeps['readDrive']>(async (): Promise<Uint8Array> => {
  throw new Error('Local source must never read Drive');
});
const enumerateDrive = vi.fn<CatalogImageWorkerDeps['enumerateDrive']>(async () => {
  throw new Error('Local import must never enumerate Drive');
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
const providerPuts = () =>
  vi
    .mocked(transport)
    .mock.calls.filter(
      ([input, init]) =>
        (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'PUT'
    );

beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261206159000_catalog_image_storage_quota.sql'
  });
  canonical = await optimizeCatalogImage(PNG, 'image/png');
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
        enumerateDrive
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
    const source = await validateCatalogImage(PNG, 'image/png');
    expect(canonical.image.sha256).not.toBe(source.sha256);
    expect(canonical.bytes.length).toBeLessThan(PNG.length);
    const persisted = await db.root(
      `select e.declared_size,e.source_size,e.source_sha256,e.optimization_version,
       e.canonical_size,e.canonical_sha256,e.canonical_mime,
       p.size_bytes,p.sha256,p.mime
       from private.catalog_image_import_entries e
       join private.catalog_image_publications p on p.id=e.publication_id where e.id=$1`,
      [entry.id]
    );
    expect(persisted[0]).toMatchObject({
      declared_size: PNG.length,
      source_size: PNG.length,
      source_sha256: source.sha256,
      optimization_version: 'lossless-v1',
      canonical_size: canonical.bytes.length,
      canonical_sha256: canonical.image.sha256,
      canonical_mime: 'image/png',
      size_bytes: canonical.bytes.length,
      sha256: canonical.image.sha256,
      mime: 'image/png'
    });
    const published = await transport(dictionary.items[0]!.publicUrl);
    expect(published.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await published.arrayBuffer())).toEqual(canonical.bytes);
    const storage = await route(`/storage?teamId=${team}`);
    expect(isCatalogImageStorage(storage)).toBe(true);
    expect(storage).toMatchObject({
      usedBytes: canonical.bytes.length,
      libraryBytes: canonical.bytes.length,
      reservedBytes: 0,
      pendingDeletionBytes: 0,
      totalImages: 1,
      limitBytes: 100_000_000,
      limitImages: 500
    });
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
    const library = await route(`/library?teamId=${team}`);
    expect(isCatalogImageLibraryPage(library)).toBe(true);
    if (!isCatalogImageLibraryPage(library)) throw new Error('Invalid real library');
    expect(library.items).toHaveLength(1);
    expect(library.items[0]).toMatchObject({
      id: dictionary.items[0]!.id,
      sizeBytes: canonical.bytes.length,
      active: true,
      inUse: true,
      publicationState: 'ready'
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
        'optimizing',
        'optimized',
        'deduplicating',
        'publishing',
        'verifying_origin',
        'verifying_public',
        'committing',
        'ready'
      ])
    );
    const stages = evidence.map(item => item.stage);
    expect(stages.indexOf('optimizing')).toBeLessThan(stages.indexOf('optimized'));
    expect(stages.indexOf('optimized')).toBeLessThan(stages.indexOf('deduplicating'));
  });

  it('does not expose a signed input grant or private name in diagnostic projection', async () => {
    const evidence = await db.root('select * from public.analytics_catalog_image_journal');
    expect(JSON.stringify(evidence)).not.toMatch(
      /IMG_2031|r2\.cloudflarestorage|publicUrl|stagingKey|sha256/u
    );
    expect(objects.size).toBe(2);
  });

  it('uses the same canonical identity for a Drive source and reuses the stored publication without another PUT', async () => {
    const previous = await route(`/dictionary?teamId=${team}`);
    if (!isCatalogImageDictionaryPage(previous)) throw new Error('Invalid previous dictionary');
    const accepted = snapshot(
      await route('/imports', {
        teamId: team,
        contractVersion: 2,
        sourceKind: 'drive',
        sourceMaterialIds: [ATTEMPT],
        idempotencyKey: 'wire-drive-import-request-01'
      })
    );
    enumerateDrive.mockResolvedValueOnce({
      entries: [
        {
          fileId: 'synthetic-drive-image',
          name: 'IMG_2031.png',
          size: PNG.length,
          mime: 'image/png',
          classification: classifyCatalogImageName('IMG_2031.png'),
          source: { fileId: 'synthetic-drive-image', rootMaterialId: ATTEMPT }
        }
      ],
      cursor: [],
      complete: true,
      more: false
    });
    driveRead.mockResolvedValueOnce(PNG.slice());
    expect(await route('/worker', {})).toMatchObject({ enumerated: 1, complete: true });
    const putsBefore = providerPuts().length;
    expect(await route('/worker', {})).toMatchObject({ outcome: 'reused' });
    const complete = snapshot(await route(`/imports/${accepted.id}`));
    expect(complete.counts).toMatchObject({ total: 1, ready: 0, reused: 1 });
    const after = await route(`/dictionary?teamId=${team}`);
    if (!isCatalogImageDictionaryPage(after)) throw new Error('Invalid final dictionary');
    expect(after.items.map(item => item.publicUrl)).toEqual(
      previous.items.map(item => item.publicUrl)
    );
    expect(providerPuts()).toHaveLength(putsBefore);
    expect(driveRead).toHaveBeenCalledOnce();
    expect(await route(`/storage?teamId=${team}`)).toMatchObject({
      usedBytes: canonical.bytes.length,
      totalImages: 1
    });
  });
});
