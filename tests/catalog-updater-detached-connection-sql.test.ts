import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { expireBackoff, poisonRows, settleFailure } from './support/poison-rows';

/**
 * 1.4.3 (beta, 2026-11-11): rounds of catalogs whose Drive connection was
 * detached were leased every minute by private.claim_catalog_updater_items and
 * dropped by its wrapper (connected/unavailable only), so they never ended: the
 * manager said "Оновлюємо 3–4 каталоги" forever, item attempts reached 503, and
 * Stop raised WRONG_STATE because of the worker's live claim lease. A dispatched
 * publication job on such a catalog was re-claimed every minute and answered
 * SOURCE_CHANGED.
 */
let db: TeamTestDb, team: string, connected: string;
const owner = 'c2500000-0000-4000-8000-000000000001';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'updater-detached@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Detached')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'detached','detached@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  connected = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
}, 240000);
afterAll(async () => {
  await db?.close();
});

async function newCatalog(connection: string): Promise<string> {
  const source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,gen_random_uuid()::text,'source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version,companion_of,companion_kind)values($1,$2,gen_random_uuid()::text,'sheet','file','other','application/vnd.google-apps.spreadsheet',4,repeat('a',32),'1',$3,'product_catalog')returning id",
      [team, connection, source]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)values($1,$2,$3,'https://example.invalid/',3,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)values($1,$2,true,true,false,false,false)on conflict(catalog_material_id)do update set restitch=false',
    [catalog, team]
  );
  await db.asUser(owner, 'select public.run_team_catalog_update_now($1,array[$2]::uuid[])', [
    team,
    catalog
  ]);
  return catalog;
}

const itemOf = async (catalog: string) =>
  (
    await db.root<{
      round_due_at: string | null;
      lease_owner: string | null;
      attempts: number;
    }>(
      'select round_due_at,lease_owner,attempts from public.team_catalog_updater_items where catalog_material_id=$1',
      [catalog]
    )
  )[0];
const claim = (worker: string) =>
  db.root<{ catalog_material_id: string }>(
    'select catalog_material_id from public.service_claim_catalog_updater_items($1,10,60)',
    [worker]
  );

it('closes a round whose Drive connection is detached instead of leasing it forever', async () => {
  const catalog = await newCatalog(connected);
  const due = (await itemOf(catalog))!.round_due_at;
  expect(due).not.toBeNull();
  await db.root(
    "update public.team_drive_connections set state='detached',detached_at=clock_timestamp() where id=$1",
    [connected]
  );
  try {
    const claimed = await claim('catalog-updater:w-detached');
    expect(claimed.map(row => row.catalog_material_id)).not.toContain(catalog);
    // A manual item without a schedule is forgotten once its round ends.
    const item = await itemOf(catalog);
    expect(item?.round_due_at ?? null).toBeNull();
    expect(item?.lease_owner ?? null).toBeNull();
    const attempt = (
      await db.root<{ result: string; failure_code: string | null }>(
        'select result,failure_code from public.team_catalog_update_attempts where catalog_material_id=$1 and round_due_at=$2',
        [catalog, due]
      )
    )[0]!;
    expect(attempt).toMatchObject({ result: 'failed', failure_code: 'NEEDS_REAUTH' });
    const record = (
      await db.root<{ last_update_error: string | null }>(
        'select last_update_error from public.team_product_catalogs where material_id=$1',
        [catalog]
      )
    )[0]!;
    expect(record.last_update_error).toBe('NEEDS_REAUTH');
  } finally {
    await db.root(
      "update public.team_drive_connections set state='connected',detached_at=null where id=$1",
      [connected]
    );
  }
});

it('names a deleted root and leaves a transiently unavailable Drive to retry', async () => {
  const missing = await newCatalog(connected);
  await db.root("update public.team_drive_connections set state='root_missing' where id=$1", [
    connected
  ]);
  await claim('catalog-updater:w-root');
  await db.root("update public.team_drive_connections set state='connected' where id=$1", [
    connected
  ]);
  expect((await itemOf(missing))?.round_due_at ?? null).toBeNull();
  expect(
    (
      await db.root<{ last_update_error: string | null }>(
        'select last_update_error from public.team_product_catalogs where material_id=$1',
        [missing]
      )
    )[0]!.last_update_error
  ).toBe('ROOT_MISSING');

  const flaky = await newCatalog(connected);
  await db.root("update public.team_drive_connections set state='unavailable' where id=$1", [
    connected
  ]);
  try {
    await claim('catalog-updater:w-flaky');
    // 'unavailable' is a passing outage: the round stays open for the next tick.
    expect((await itemOf(flaky))?.round_due_at ?? null).not.toBeNull();
  } finally {
    await db.root(
      "update public.team_drive_connections set state='connected',detached_at=null where id=$1",
      [connected]
    );
    await db.root(
      'update public.team_catalog_updater_items set round_due_at=null where catalog_material_id=$1',
      [flaky]
    );
  }
});

it('Stop ends a round held only by a worker claim lease, and the worker can no longer write', async () => {
  const catalog = await newCatalog(connected);
  const worker = 'catalog-updater:w-stop';
  const claimed = await claim(worker);
  expect(claimed.map(row => row.catalog_material_id)).toContain(catalog);
  const held = (await itemOf(catalog))!;
  expect(held.lease_owner).toBe(worker);
  const attemptId = (
    await db.root<{ attempt_id: string }>(
      'select attempt_id from public.team_catalog_update_attempts where catalog_material_id=$1 and round_due_at=$2',
      [catalog, held.round_due_at]
    )
  )[0]!.attempt_id;
  const stopped = (
    await db.asUser<{ v: boolean }>(
      owner,
      'select public.cancel_team_catalog_update_attempt_as_actor($1,$2,$3,$4,$5)v',
      [team, catalog, held.round_due_at, attemptId, owner]
    )
  )[0]!.v;
  expect(stopped).toBe(true);
  expect((await itemOf(catalog))?.round_due_at ?? null).toBeNull();
  const write = (
    await db.root<{ v: boolean }>(
      "select public.service_begin_catalog_update_write($1,$2,gen_random_uuid(),'1',3,null,3,'{}'::jsonb)v",
      [catalog, worker]
    )
  )[0]!.v;
  expect(write).toBe(false);
});

it('does not re-claim a publication job of a catalog whose connection is detached', async () => {
  const source = (
    await db.root<{ d: string }>(
      "select pg_get_functiondef('public.service_claim_catalog_publication_jobs(uuid,integer)'::regprocedure) d"
    )
  )[0]!.d;
  expect(source).toContain('private.catalog_connection_usable(q.catalog_material_id)');
  const preparations = (
    await db.root<{ d: string }>(
      "select pg_get_functiondef('public.service_claim_catalog_publication_preparations(uuid,integer)'::regprocedure) d"
    )
  )[0]!.d;
  expect(preparations).toContain('private.catalog_connection_usable(j.catalog_material_id)');
  const usable = async (catalog: string) =>
    (await db.root<{ v: boolean }>('select private.catalog_connection_usable($1) v', [catalog]))[0]!
      .v;
  const catalog = await newCatalog(connected);
  expect(await usable(catalog)).toBe(true);
  await db.root(
    "update public.team_drive_connections set state='detached',detached_at=clock_timestamp() where id=$1",
    [connected]
  );
  try {
    expect(await usable(catalog)).toBe(false);
  } finally {
    await db.root(
      "update public.team_drive_connections set state='connected',detached_at=null where id=$1",
      [connected]
    );
  }
});

it('one unreachable round that cannot be closed does not stop the others', async () => {
  const healthy = await newCatalog(connected);
  const poisoned = await newCatalog(connected);
  await db.root(
    "update public.team_drive_connections set state='detached',detached_at=clock_timestamp() where id=$1",
    [connected]
  );
  const cure = await poisonRows(db, 'public.team_catalog_updater_items', 'catalog_material_id', [
    poisoned
  ]);
  const close = async () =>
    (await db.root<{ n: number }>('select private.close_unreachable_catalog_rounds() n'))[0]!.n;
  try {
    expect(await close()).toBeGreaterThanOrEqual(1);
    expect((await itemOf(healthy))?.round_due_at ?? null).toBeNull();
    expect((await itemOf(poisoned))!.round_due_at).not.toBeNull();
    expect(await settleFailure(db, 'catalog_unreachable_round', poisoned)).toEqual({
      attempts: 1,
      last_code: 'SETTLE_TEST_POISON',
      deferred: true
    });
    // The claim that runs it every minute keeps working for everyone else.
    await claim('catalog-updater:w-poisoned');
    await cure();
    await expireBackoff(db, 'catalog_unreachable_round', poisoned);
    expect(await close()).toBeGreaterThanOrEqual(1);
    expect((await itemOf(poisoned))?.round_due_at ?? null).toBeNull();
    expect(await settleFailure(db, 'catalog_unreachable_round', poisoned)).toBeUndefined();
  } finally {
    await cure();
    await db.root(
      "update public.team_drive_connections set state='connected',detached_at=null where id=$1",
      [connected]
    );
  }
});
