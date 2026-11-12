import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Owner decision 2026-11-11: a catalog with its video in R2 is deleted for good and its copy
 * is removed at once. On production (2026-11-12) a trashed catalog kept its copy, because the
 * sweep that releases trashed catalogs only started when something else was already due.
 */
const OWNER = '50000000-0000-4000-8000-000000000961';
let db: TeamTestDb, team: string, connection: string;
let ordinal = 0;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'video-r2-trash@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('R2 trash')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2-trash','trash@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [OWNER]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'synthetic-root','Synthetic','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
  await db.root(
    "update private.catalog_video_r2_config set enabled=true,public_origin='https://videos.test',policy_confirmed_at=clock_timestamp()"
  );
}, 240_000);
afterAll(async () => {
  await db?.close();
});

async function material(category: string, mime: string) {
  ordinal += 1;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum) values($1,$2,$3,'synthetic-root',$3,'file',$4,$5,4000000,$6) returning id",
      [team, connection, `trash-${ordinal}`, category, mime, 'a'.repeat(32)]
    )
  )[0]!.id;
}
async function catalogUsing(copy: string, source: string) {
  const id = await material('other', 'application/vnd.google-apps.spreadsheet');
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://videos.test/v.mp4','{}',$4,1)",
    [id, team, source, OWNER]
  );
  await db.root(
    'insert into private.catalog_video_r2_preferences(catalog_material_id,team_id,enabled,configured_by) values($1,$2,true,$3)',
    [id, team, OWNER]
  );
  await db.root(
    'insert into private.catalog_video_r2_uses(catalog_material_id,source_material_id,copy_id,team_id) values($1,$2,$3,$4)',
    [id, source, copy, team]
  );
  return id;
}
async function readyCopy(version: string) {
  const source = await material('video', 'video/mp4');
  const copy = (
    await db.root<{ id: string }>(
      "insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,size_bytes,part_bytes,state,ready_at) values($1,$2,$3,4000000,16777216,'ready',clock_timestamp()) returning id",
      [team, source, version]
    )
  )[0]!.id;
  return { source, copy };
}
const copyRow = async (copy: string) =>
  (
    await db.root<{ state: string; due: boolean; reason: string | null }>(
      'select state,retire_after<=clock_timestamp() due,retire_reason reason from private.catalog_video_r2_copies where id=$1',
      [copy]
    )
  )[0]!;
const trash = (catalog: string) =>
  db.root(
    "update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp() where id=$1",
    [catalog]
  );

it('a trashed catalog makes its R2 copy due for deletion at once and wakes the sweep', async () => {
  const { source, copy } = await readyCopy('content-v1:' + '1'.repeat(64));
  const catalog = await catalogUsing(copy, source);
  await trash(catalog);
  expect(await copyRow(copy)).toMatchObject({
    state: 'retiring',
    due: true,
    reason: 'catalog_deleted'
  });
  expect(
    await db.root('select 1 from private.catalog_video_r2_uses where catalog_material_id=$1', [
      catalog
    ])
  ).toEqual([]);
});

it('a copy another live catalog still uses is kept', async () => {
  const { source, copy } = await readyCopy('content-v1:' + '2'.repeat(64));
  const gone = await catalogUsing(copy, source);
  await catalogUsing(copy, source);
  await trash(gone);
  expect(await copyRow(copy)).toMatchObject({ state: 'ready' });
});

it('the sweep counts uses of a removed catalog as work, even with nothing else due', async () => {
  const { source, copy } = await readyCopy('content-v1:' + '3'.repeat(64));
  const catalog = await catalogUsing(copy, source);
  // A trash that bypassed the trigger (replication, a restore of old data).
  await db.root('set session_replication_role = replica');
  try {
    await trash(catalog);
  } finally {
    await db.root('set session_replication_role = origin');
  }
  expect(
    (await db.root<{ w: boolean }>("select private.catalog_video_r2_has_work('sweep') w"))[0]!.w
  ).toBe(true);
});
