import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb, team: string, catalog: string, source: string, attempt: string;
const actor = 'c1770000-0000-4000-8000-000000000001',
  worker = 'nonvideo-worker';
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207177000_catalog_nonvideo_preservation.sql'
  });
  await createUser(db, { id: actor, email: 'nonvideo@fixture.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [actor]);
  team = (
    await db.asUser<{ id: string }>(actor, "select id from public.create_team('Nonvideo')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'nonvideo','nonvideo@fixture.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file') returning id",
      [actor]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'root','Root','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','Source','file','video','video/mp4',4,repeat('a',32),'1') returning id",
      [team, connection]
    )
  )[0]!.id;
  catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type)values($1,$2,'sheet','Catalog','file','other','application/vnd.google-apps.spreadsheet') returning id",
      [team, connection]
    )
  )[0]!.id;
  await db.root(
    "update public.team_materials set companion_of=$2,companion_kind='product_catalog'where id=$1",
    [catalog, source]
  );
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)values($1,$2,$3,'https://fixture.invalid/',3,'https://docs.google.com/spreadsheets/d/sheet/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)values($1,$2,true,true,false,true,false)on conflict do nothing',
    [catalog, team]
  );
  await db.root(
    'insert into public.team_catalog_updaters(team_id) values($1) on conflict do nothing',
    [team]
  );
  await db.root(
    "insert into public.team_catalog_updater_items(team_id,catalog_material_id,round_due_at,lease_owner,lease_expires_at)values($1,$2,clock_timestamp(),$3,clock_timestamp()+interval '5 minutes')on conflict(catalog_material_id)do update set round_due_at=excluded.round_due_at,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at",
    [team, catalog, worker]
  );
  attempt = (
    await db.root<{ attempt_id: string }>(
      'select attempt_id from public.team_catalog_update_attempts where catalog_material_id=$1',
      [catalog]
    )
  )[0]!.attempt_id;
  const target = (
    await db.root<{ v: unknown }>(
      "select jsonb_build_object('kind','source','materialId',$1::uuid,'sourceVersion',private.catalog_publication_source_version($1,$2))v",
      [source, team]
    )
  )[0]!.v;
  await db.root(
    "select public.service_save_catalog_publication($1,$2,gen_random_uuid(),$3,0,'scheduled','2030-01-01T00:00:00Z','UTC',$4)",
    [team, actor, catalog, target]
  );
  await db.root(
    "insert into private.catalog_publication_cell_writes(job_id,team_id,catalog_material_id,target_id,connection_id,file_id,payload) select j.id,j.team_id,j.catalog_material_id,j.target_id,$2,'sheet',jsonb_build_object('products',jsonb_build_array(jsonb_build_object('id','old1','url','https://fixture.invalid/old1'),jsonb_build_object('id','old2','url','https://fixture.invalid/old2'),jsonb_build_object('id','old3','url','https://fixture.invalid/old3'))) from private.catalog_video_publication_jobs j where j.catalog_material_id=$1",
    [catalog, connection]
  );
}, 180000);
afterAll(async () => {
  await db?.close();
});
const read = async () =>
  (
    await db.root<{
      v: { contextToken: string; productCount: number; currentProductCount: number };
    }>('select public.service_read_catalog_nonvideo_update_context($1,$2)v', [catalog, worker])
  )[0]!.v;
it('permits nonvideo preservation before due without inventing an active delivery or changing held/scheduled policy', async () => {
  const context = await read();
  expect(context).toMatchObject({ productCount: 3, currentProductCount: 3 });
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.catalog_video_deliveries where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.n
  ).toBe(0);
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_begin_catalog_update_write($1,$2,gen_random_uuid(),\'1\',1,null,3,\'{"_catalogPublicIds":["1","2","3"]}\')v',
        [catalog, worker]
      )
    )[0]!.v
  ).toBe(false);
  expect(
    (
      await db.root<{ v: boolean }>(
        "select public.service_begin_catalog_nonvideo_update_write($1,$2,gen_random_uuid(),'1',1,3,'{}',$3)v",
        [catalog, worker, 'bad-token']
      )
    )[0]!.v
  ).toBe(false);
});
it('records only the original ordinary writer, interlocks publication and completes normal fields independently', async () => {
  const c = await read(),
    marker = crypto.randomUUID();
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_begin_catalog_nonvideo_update_write($1,$2,$3,\'1\',1,3,\'{"_catalogPublicIds":["1","2","3"]}\',$4)v',
        [catalog, worker, marker, c.contextToken]
      )
    )[0]!.v
  ).toBe(true);
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_read_catalog_nonvideo_reconciliation($1,$2)v',
        [catalog, marker]
      )
    )[0]!.v
  ).toBe(true);
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_complete_catalog_update($1,$2,1,null,3,\'{"_catalogPublicIds":["1","2","3"]}\')v',
        [catalog, worker]
      )
    )[0]!.v
  ).toBe(true);
  await db.root('select public.service_finish_catalog_update_write($1)', [catalog]);
  expect(
    (
      await db.root<{ mode: string; revision: number }>(
        'select mode,revision from private.catalog_video_publication_policies where catalog_material_id=$1',
        [catalog]
      )
    )[0]
  ).toMatchObject({ mode: 'scheduled', revision: 1 });
  expect(
    (
      await db.root<{ attempt_id: string }>(
        'select attempt_id from public.team_catalog_update_attempts where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.attempt_id
  ).toBe(attempt);
  const rebound = (
    await db.root<{ payload: { products: Array<{ id: string; url: string }> } }>(
      'select payload from private.catalog_publication_cell_writes where catalog_material_id=$1',
      [catalog]
    )
  )[0]!.payload;
  expect(rebound.products.map(p => p.id)).toEqual(['1', '2', '3']);
  expect(rebound.products.map(p => p.url)).toEqual([
    'https://fixture.invalid/old1',
    'https://fixture.invalid/old2',
    'https://fixture.invalid/old3'
  ]);
});
it('registry appends desired K/N through the same checked team snapshot', async () => {
  const result = (
    await db.asUser<{ v: { catalogs: Array<Record<string, unknown>> } }>(
      actor,
      'select public.list_team_catalog_manager_snapshot($1)v',
      [team]
    )
  )[0]!.v;
  expect(result.catalogs[0]).toHaveProperty('video_generation');
  await expect(
    db.asUser(actor, 'select public.list_team_catalog_manager_snapshot(gen_random_uuid())')
  ).rejects.toThrow('PERMISSION_DENIED');
});
it('marks the ordinary phase verified while retaining the SAME N parent round for publication settlement', async () => {
  await db.root(
    "insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,lease_owner,lease_expires_at)values($1,$3,clock_timestamp(),$2,clock_timestamp()+interval '5 minutes')on conflict(catalog_material_id)do update set round_due_at=excluded.round_due_at,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at",
    [catalog, worker, team]
  );
  const a = (
    await db.root<{ attempt_id: string }>(
      'select attempt_id from public.team_catalog_update_attempts where catalog_material_id=$1 order by started_at desc limit 1',
      [catalog]
    )
  )[0]!.attempt_id;
  await db.root(
    "insert into private.catalog_variant_round_snapshots(attempt_id,team_id,actor_id,catalog_material_id,source_material_id,requested_count,product_count,profile_version,settings_snapshot,recipe_row_ids,child_request_ids,assignment_seed,source_kind,regular_released) values($1,$2,$3,$4,$5,1,3,1,'{}',(select jsonb_agg(gen_random_uuid()) from generate_series(1,3)),jsonb_build_array(gen_random_uuid()),repeat('a',64),'updater',true)",
    [a, team, actor, catalog, source]
  );
  const lease = (
    await db.root<{
      lease_owner: string | null;
      round_due_at: string | null;
      lease_expires_at: string | null;
    }>(
      'select lease_owner,round_due_at,lease_expires_at from public.team_catalog_updater_items where catalog_material_id=$1',
      [catalog]
    )
  )[0]!;
  expect(lease.lease_owner).toBe(worker);
  expect(lease.round_due_at).not.toBeNull();
  const c = await read();
  const snapshot = { _catalogPublicIds: ['4', '5', '6'] };
  expect(
    (
      await db.root<{ v: boolean }>(
        "select public.service_begin_catalog_nonvideo_update_write($1,$2,gen_random_uuid(),'2',2,3,$3,$4)v",
        [catalog, worker, snapshot, c.contextToken]
      )
    )[0]!.v
  ).toBe(true);
  expect(
    (
      await db.root<{ v: boolean }>(
        'select public.service_complete_catalog_update($1,$2,2,null,3,$3)v',
        [catalog, worker, snapshot]
      )
    )[0]!.v
  ).toBe(true);
  await db.root('select public.service_finish_catalog_update_write($1)', [catalog]);
  const phase = (
    await db.root<{ result: string; verified: boolean; round_open: boolean }>(
      'select a.result,r.regular_verified_at is not null verified,i.round_due_at=a.round_due_at round_open from public.team_catalog_update_attempts a join private.catalog_variant_round_snapshots r on r.attempt_id=a.attempt_id join public.team_catalog_updater_items i on i.catalog_material_id=a.catalog_material_id where a.attempt_id=$1',
      [a]
    )
  )[0]!;
  expect(phase).toMatchObject({ result: 'running', verified: true, round_open: true });
  expect(
    (await db.root('select * from public.service_claim_catalog_updater_items($1,3,300)', [worker]))
      .length
  ).toBe(0);
});
