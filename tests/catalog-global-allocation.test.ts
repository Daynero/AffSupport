import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db.js';
import { globalFixtureId } from './fixtures/catalog-global.js';
import { isGlobalCatalogImage } from '../packages/shared/src/team/catalog-global-images.js';

let db: TeamTestDb;
let team: string;
const OWNER = globalFixtureId(40001);
const OUTSIDER = globalFixtureId(40002);
const IMAGE = globalFixtureId(40003);
const allocate = async (catalog: string, intent: string, count = 1) => {
  const result = await db.root<{ value: { images: unknown[]; recipeId: string; reused: boolean } }>(
    'select public.service_catalog_global_allocate($1,$2,$3,$4,$5,1) value',
    [OWNER, team, catalog, intent, count]
  );
  return result[0]!.value;
};

beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261208100200_catalog_global_retirement.sql' });
  await createUser(db, { id: OWNER, email: 'global-owner@example.test' });
  await createUser(db, { id: OUTSIDER, email: 'global-outsider@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Global fixtures')")
  )[0]!.id;
  await db.root(`update private.catalog_global_policy set environment='beta',epoch=1,state='active',
    media_origin='https://images.example.test',routing_revision='fixture-v1',serving_revision='fixture-v1',
    serving_verified_at=clock_timestamp(),activated_at=now(),delete_after=now()+interval '30 days'`);
  await db.root(
    `insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,
    classification,state,content_proof_revision,content_verified_at,content_expires_at)
    values($1::uuid,'beta','g1/'||($1::uuid)::text,repeat('a',64),'image/jpeg',1000,1024,1024,
    '{"mode":"matched","garment":"Hoodie","color":"black","vocabularyVersion":"catalog-clothing-v1"}',
    'ready','fixture-v1',clock_timestamp(),clock_timestamp()+interval '24 hours')`,
    [IMAGE]
  );
  await db.root(
    `insert into private.catalog_global_aliases(image_id,generation,public_url,key_version,state,identity_revision,identity_verified_at)
    select $1,g,'https://images.example.test/g/fixture-'||g||'.jpg',1,'ready','fixture-v1',clock_timestamp()
    from generate_series(1,3) g`,
    [IMAGE]
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});

describe('global allocator SQL authority and durable issuance', () => {
  it('does not expose private tables or service mutation RPCs to authenticated users', async () => {
    const [row] = await db.root<{ table_read: boolean; allocate: boolean; ready: boolean }>(`select
      has_table_privilege('authenticated','private.catalog_global_images','select') table_read,
      has_function_privilege('authenticated','public.service_catalog_global_allocate(uuid,uuid,uuid,uuid,integer,bigint,text,jsonb)','execute') allocate,
      has_function_privilege('service_role','public.service_catalog_global_readiness(uuid,uuid)','execute') ready`);
    expect(row).toEqual({ table_read: false, allocate: false, ready: true });
    await expect(
      db.root('select public.service_catalog_global_allocate($1,$2,$3,$4,1,1)', [
        OUTSIDER,
        team,
        globalFixtureId(41000),
        globalFixtureId(42000)
      ])
    ).rejects.toThrow('PERMISSION_DENIED');
  });
  it('freezes one assignment for repeated rows and retries without consuming another slot', async () => {
    const first = await allocate(globalFixtureId(41001), globalFixtureId(42001), 200);
    expect(first.images).toHaveLength(200);
    expect(first.images.every(isGlobalCatalogImage)).toBe(true);
    expect(new Set(first.images.map(v => JSON.stringify(v))).size).toBe(1);
    const second = await allocate(globalFixtureId(41001), globalFixtureId(42001), 200);
    expect(second.images).toEqual(first.images);
    expect(second.reused).toBe(true);
    const [row] = await db.root<{ issued: string; confirmed: string }>(
      'select issued_seq::text issued,confirmed_uses::text confirmed from private.catalog_global_images where id=$1',
      [IMAGE]
    );
    expect(row).toEqual({ issued: '1', confirmed: '0' });
  });
  it('confirms a proven pair once across retries and new update attempts', async () => {
    const catalog = globalFixtureId(41002),
      intent = globalFixtureId(42002);
    const first = await allocate(catalog, intent);
    const [one] = await db.root<{ value: { confirmed: number } }>(
      'select public.service_catalog_global_confirm($1,$2,$3) value',
      [team, intent, intent]
    );
    const [two] = await db.root<{ value: { confirmed: number } }>(
      'select public.service_catalog_global_confirm($1,$2,$3) value',
      [team, intent, intent]
    );
    expect(one!.value.confirmed).toBe(1);
    expect(two!.value.confirmed).toBe(0);
    const update = await allocate(catalog, globalFixtureId(42003));
    expect(update.images).toEqual(first.images);
  });
  it('moves from slot200 to a ready next URL without waiting for200 confirmed catalogs', async () => {
    await db.root('update private.catalog_global_images set issued_seq=199 where id=$1', [IMAGE]);
    const a = await allocate(globalFixtureId(41004), globalFixtureId(42004));
    const b = await allocate(globalFixtureId(41005), globalFixtureId(42005));
    expect(a.images[0]).toMatchObject({ issuedSlot: '200', generation: 1 });
    expect(b.images[0]).toMatchObject({ issuedSlot: '201', generation: 2 });
  });
  it('fails promptly on stale serving proof instead of preparing or silently switching a recipe', async () => {
    await db.root(
      "update private.catalog_global_policy set serving_verified_at=now()-interval '3 minutes'"
    );
    await expect(allocate(globalFixtureId(41006), globalFixtureId(42006))).rejects.toThrow(
      'GLOBAL_IMAGE_READINESS_UNKNOWN'
    );
    await db.root('update private.catalog_global_policy set serving_verified_at=clock_timestamp()');
  });
  it('revalidates frozen recipes against serving health immediately before an external write', async () => {
    const attempt = globalFixtureId(42070);
    await allocate(globalFixtureId(41070), attempt);
    await db.root('select public.service_catalog_image_validate_uses_v3($1,$2)', [team, attempt]);
    await db.root(
      "update private.catalog_global_policy set serving_verified_at=clock_timestamp()-interval '121 seconds'"
    );
    await expect(
      db.root('select public.service_catalog_image_validate_uses_v3($1,$2)', [team, attempt])
    ).rejects.toThrow('GLOBAL_IMAGE_READINESS_UNKNOWN');
    // Actual completion is still recordable after a health timeout; it is not a new write.
    await db.root('select public.service_catalog_global_confirm($1,$2,$2)', [team, attempt]);
    await db.root('update private.catalog_global_policy set serving_verified_at=clock_timestamp()');
  });
  it('keeps T0 immutable under attempted reset', async () => {
    await expect(
      db.root(
        "update private.catalog_global_policy set activated_at=null,delete_after=null,state='prepared'"
      )
    ).rejects.toThrow('GLOBAL_IMAGE_POLICY_CONFLICT');
  });
});
it('reuses a closed alias after asset proof refresh and never treats5000 as a stop', async () => {
  const catalog = globalFixtureId(43001),
    intent = globalFixtureId(43002);
  await db.root(
    'update private.catalog_global_policy set serving_verified_at=clock_timestamp(),serving_revision=routing_revision'
  );
  await db.root(
    "update private.catalog_global_images set content_expires_at=clock_timestamp()+interval '24 hours' where id=$1",
    [IMAGE]
  );
  const first = await allocate(catalog, intent);
  await db.root(
    "update private.catalog_global_aliases set identity_verified_at=clock_timestamp()-interval '90 days' where image_id=$1",
    [IMAGE]
  );
  await db.root(
    'update private.catalog_global_images set issued_seq=5001,confirmed_uses=5000 where id=$1',
    [IMAGE]
  );
  const second = await allocate(catalog, globalFixtureId(43003));
  expect(second.images).toEqual(first.images);
  expect(
    (
      await db.root<{ issued_seq: string }>(
        'select issued_seq::text from private.catalog_global_images where id=$1',
        [IMAGE]
      )
    )[0]!.issued_seq
  ).toBe('5001');
});
it('finds a rare required factual bucket outside a large unrelated pool before applying the scan bound', async () => {
  const rare = globalFixtureId(80003);
  await db.root(`insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification,state,content_proof_revision,content_expires_at)
    select id,'beta','g1/'||id::text,encode(sha256(convert_to(id::text,'UTF8')),'hex'),'image/jpeg',1000,500,500,
      '{"mode":"matched","garment":"Hoodie","color":"black","vocabularyVersion":"catalog-clothing-v1"}',
      'ready','fixture-v1',clock_timestamp()+interval '24 hours'
    from(select ('52000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid id from generate_series(1,2000)n)s`);
  await db.root(
    `insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification,state,content_proof_revision,content_expires_at)
    values($1::uuid,'beta','g1/'||$1::text,repeat('f',64),'image/jpeg',1000,500,500,
      '{"mode":"matched","garment":"Blouse","color":"navy","vocabularyVersion":"catalog-clothing-v1"}',
      'ready','fixture-v1',clock_timestamp()+interval '24 hours')`,
    [rare]
  );
  await db.root(
    `insert into private.catalog_global_aliases(image_id,generation,public_url,key_version,state,identity_revision,identity_verified_at)
    select i.id,g,'https://images.example.test/g/fixture-'||i.id||'-'||g||'.jpg',1,'ready','fixture-v1',clock_timestamp()
    from private.catalog_global_images i cross join generate_series(1,3)g where i.id<>$1`,
    [IMAGE]
  );
  const [result] = await db.root<{ value: { images: { imageId: string }[] } }>(
    "select public.service_catalog_global_allocate($1,$2,$3,$4,1,1,'refresh',$5::jsonb) value",
    [
      OWNER,
      team,
      globalFixtureId(81001),
      globalFixtureId(81002),
      JSON.stringify([{ garment: 'Blouse', color: 'navy' }])
    ]
  );
  expect(result!.value.images[0]!.imageId).toBe(rare);
});
