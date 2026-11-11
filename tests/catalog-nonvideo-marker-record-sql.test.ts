import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { expectedPreviousMarker } from '../supabase/functions/catalog-updater/nonvideo-writer.ts';

/**
 * 1.4.3: recording a manual round's change summary replaced actual_changes and
 * dropped the non-video sheet marker begin-write had recorded. The sheet kept
 * the marker, the attempt forgot it, and every later round failed with
 * PROCESS_RESULT_UNCERTAIN before any stage (beta, TR 14_v3 / TR 14_v4).
 */
let db: TeamTestDb, team: string, catalog: string, first: string;
const actor = 'c1790000-0000-4000-8000-000000000001',
  worker = 'marker-worker';

const lease = () =>
  db.root(
    "insert into public.team_catalog_updater_items(team_id,catalog_material_id,round_due_at,lease_owner,lease_expires_at)values($1,$2,clock_timestamp(),$3,clock_timestamp()+interval '5 minutes')on conflict(catalog_material_id)do update set round_due_at=excluded.round_due_at,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at",
    [team, catalog, worker]
  );
const context = async () =>
  (
    await db.root<{
      v: { contextToken: string; previousMarker: string | null; markerRecordLost: boolean };
    }>('select public.service_read_catalog_nonvideo_update_context($1,$2)v', [catalog, worker])
  )[0]!.v;
const currentAttempt = async () =>
  (
    await db.root<{ attempt_id: string }>(
      'select attempt_id from public.team_catalog_update_attempts where catalog_material_id=$1 order by started_at desc limit 1',
      [catalog]
    )
  )[0]!.attempt_id;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: actor, email: 'marker@fixture.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [actor]);
  team = (await db.asUser<{ id: string }>(actor, "select id from public.create_team('Marker')"))[0]!
    .id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'marker','marker@fixture.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file') returning id",
      [actor]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'root','Root','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
  const source = (
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
  await lease();
  first = await currentAttempt();
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
}, 180000);
afterAll(async () => {
  await db?.close();
});

it('keeps the sheet marker on the attempt when the change summary is recorded', async () => {
  const c = await context(),
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
        'select public.service_record_catalog_update_changes($1,$2,\'{"textsRefreshed":true}\')v',
        [catalog, worker]
      )
    )[0]!.v
  ).toBe(true);
  const changes = (
    await db.root<{ c: Record<string, unknown> }>(
      'select actual_changes c from public.team_catalog_update_attempts where attempt_id=$1',
      [first]
    )
  )[0]!.c;
  expect(changes).toMatchObject({ _nativeNonVideoMarker: marker, textsRefreshed: true });
});

it('reports a lost marker record so a stranded catalog can adopt its own single marker', async () => {
  // A round verified by the old code: delivered, but no marker recorded.
  await db.root(
    "update public.team_catalog_update_attempts set actual_changes='{\"textsRefreshed\":true}'::jsonb,delivery_verified_at=clock_timestamp(),result='success' where attempt_id=$1",
    [first]
  );
  await db.root(
    'update public.team_catalog_updater_items set round_due_at=null,lease_owner=null,lease_expires_at=null where catalog_material_id=$1',
    [catalog]
  );
  await lease();
  expect(await currentAttempt()).not.toBe(first);
  const c = await context();
  expect(c.previousMarker).toBeNull();
  expect(c.markerRecordLost).toBe(true);
  expect(expectedPreviousMarker(c, ['sheet-marker'])).toBe('sheet-marker');
  expect(expectedPreviousMarker(c, ['a', 'b'])).toBeNull();
  expect(expectedPreviousMarker({ previousMarker: null, markerRecordLost: false }, ['x'])).toBe(
    null
  );
});
