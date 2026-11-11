import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11, TR 7_v8 (set a0f1fd63): a catalog creation whose window was
 * closed could not be found again. The video's «Каталоги» window listed only
 * finished catalogs and knew about a running one from browser storage alone.
 * The person's own unfinished creations are now listed by the server, with the
 * progress the window shows; finished and canceled ones never linger.
 */
let db: TeamTestDb, team: string, source: string;
const owner = 'c3700000-0000-4000-8000-000000000001',
  member = 'c3700000-0000-4000-8000-000000000002',
  outsider = 'c3700000-0000-4000-8000-000000000003',
  executor = 'c3700000-0000-4000-8000-000000000004';
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207370000_catalog_creation_unfinished_list.sql'
  });
  await createUser(db, { id: owner, email: 'unfinished-owner@example.invalid' });
  await createUser(db, { id: member, email: 'unfinished-member@example.invalid' });
  await createUser(db, { id: outsider, email: 'unfinished-outsider@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Unfinished')")
  )[0]!.id;
  await db.root("insert into public.team_members(team_id,user_id,base_role)values($1,$2,'admin')", [
    team,
    member
  ]);
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'unfinished','unfinished@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','TR 7.mp4','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
}, 240000);
afterAll(async () => {
  await db?.close();
});

/** A creation begun by `actor`, with a video set of `count` variants when `restitch`. */
async function creation(actor: string, restitch = true, count = 2) {
  const key = `product-catalog:${crypto.randomUUID()}`;
  const payload = {
    sourceLink: 'https://offer.example.invalid/?sub=1',
    productCount: 100,
    restitchEnabled: restitch,
    videoVariationCount: count,
    restitchDuration: { finalDurationMode: 'random-40-50', customFinalDurationSeconds: 2700 },
    catalogVideoProtocolVersion: 1,
    catalogImageContractVersion: 2
  };
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, actor, key, payload, executor]
    )
  )[0]!.v.id;
  if (!restitch) return { key, intent, set: null as string | null };
  const set = crypto.randomUUID();
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    actor,
    executor,
    {
      setId: set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
      settingsDigest: 'a'.repeat(64),
      requestedCount: count,
      // One assignment row per product; a set this small keeps the fixture short.
      productCount: count,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    Array.from({ length: count }, (_, index) => ({ index, requestId: crypto.randomUUID() })),
    Array.from({ length: count }, (_, index) => ({
      recipeRowId: crypto.randomUUID(),
      videoVariantIndex: index
    }))
  ]);
  return { key, intent, set: set as string | null };
}

/** State changes the flow makes through many calls; set directly, triggers aside. */
async function force(sql: string, params: unknown[]) {
  await db.root('set session_replication_role = replica');
  try {
    await db.root(sql, params);
  } finally {
    await db.root('set session_replication_role = origin');
  }
}

type Row = Record<string, unknown>;
const list = async (actor: string) =>
  (
    await db.asUser<{ v: Row[] }>(
      actor,
      'select public.list_my_unfinished_product_catalog_creations($1,$2) v',
      [team, source]
    )
  )[0]!.v;

it('lists the caller own unfinished creation with its progress and inputs', async () => {
  const mine = await creation(owner);
  // A registered variant names its output video.
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type)select team_id,connection_id,'variant-0','TR 7 v0.mp4','file','video','video/mp4' from public.team_materials where id=$1 returning id",
      [source]
    )
  )[0]!.id;
  await force(
    "update private.catalog_video_variants set state=case video_variant_index when 0 then 'registered' else 'working' end,output_material_id=case video_variant_index when 0 then $2::uuid end where video_set_id=$1",
    [mine.set, output]
  );
  const rows = await list(owner);
  const row = rows.find(value => value.idempotencyKey === mine.key);
  expect(row).toMatchObject({
    restitch: true,
    sourceLink: 'https://offer.example.invalid/?sub=1',
    productCount: 100,
    variationCount: 2,
    duration: { finalDurationMode: 'random-40-50', customFinalDurationSeconds: 2700 },
    copyVideoToR2: false,
    requestedCount: 2,
    registeredCount: 1,
    workingCount: 1,
    agentSilent: false
  });
  expect(typeof row?.variant).toBe('number');
});

it('flags a working variant the server saw go silent', async () => {
  const mine = await creation(owner, true, 1);
  await force(
    "update private.catalog_video_variants set state='working',silence_observed_at=clock_timestamp() where video_set_id=$1",
    [mine.set]
  );
  const row = (await list(owner)).find(value => value.idempotencyKey === mine.key);
  expect(row?.agentSilent).toBe(true);
});

it('lists a creation without restitch, which has no video set', async () => {
  const mine = await creation(owner, false);
  const row = (await list(owner)).find(value => value.idempotencyKey === mine.key);
  expect(row).toMatchObject({ restitch: false, setState: null, registeredCount: 0 });
});

it('never lists finished, canceled or someone else creations', async () => {
  const registered = await creation(owner, false);
  await force("update private.catalog_generation_intents set state='registered' where id=$1", [
    registered.intent
  ]);
  const canceledSet = await creation(owner);
  await force("update private.catalog_video_sets set state='canceled' where id=$1", [
    canceledSet.set
  ]);
  const canceled = await creation(owner, false);
  await force("update private.catalog_generation_intents set state='canceled' where id=$1", [
    canceled.intent
  ]);
  const theirs = await creation(member);
  const keys = (await list(owner)).map(value => value.idempotencyKey);
  expect(keys).not.toContain(registered.key);
  expect(keys).not.toContain(canceledSet.key);
  expect(keys).not.toContain(canceled.key);
  expect(keys).not.toContain(theirs.key);
  expect((await list(member)).map(value => value.idempotencyKey)).toEqual([theirs.key]);
});

it('refuses someone outside the team', async () => {
  await expect(list(outsider)).rejects.toThrow(/PERMISSION_DENIED/u);
});
