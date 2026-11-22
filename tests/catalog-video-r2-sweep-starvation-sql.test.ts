import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-22: new catalogs with "copy video to R2" ticked stayed on Drive links for
 * good. The minute sweep took the 50 oldest candidates, and 55 of 66 were trashed or missing
 * catalogs that reconcile never settles, so no catalog made after 2026-11-19 was ever visited.
 */
const OWNER = '50000000-0000-4000-8000-000000000952';
let db: TeamTestDb, team: string, connection: string;
let ordinal = 0;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'video-r2-starve@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('R2 sweep starvation')"
    )
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2-starve','starve@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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

async function material(category: string, mime: string, sizeBytes: number | null = null) {
  ordinal += 1;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum) values($1,$2,$3,'synthetic-root',$3,'file',$4,$5,$6,$7) returning id",
      [team, connection, `starve-${ordinal}`, category, mime, sizeBytes, 'a'.repeat(32)]
    )
  )[0]!.id;
}

/** A catalog with the option on whose verified first publication put a Drive link in the cells. */
async function tickedPublishedCatalog(video: string, version: string) {
  const id = await material('other', 'application/vnd.google-apps.spreadsheet');
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://drive.google.com/file/d/x/view?usp=sharing','{}',$4,1)",
    [id, team, video, OWNER]
  );
  const target = (
    await db.root<{ id: string }>(
      "insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values($1,'source',$2,$3) returning id",
      [team, video, version]
    )
  )[0]!.id;
  await db.root(
    "insert into private.catalog_video_publication_policies(catalog_material_id,team_id,actor_id,revision,mode,target_id,legacy_delivery_unverified) values($1,$2,$3,1,'immediate',$4,false)",
    [id, team, OWNER, target]
  );
  const command = (
    await db.root<{ id: string }>(
      "insert into private.catalog_publication_commands(request_id,team_id,actor_id,payload,receipt) values(gen_random_uuid(),$1,$2,'{}','{}') returning request_id id",
      [team, OWNER]
    )
  )[0]!.id;
  const job = (
    await db.root<{ id: string }>(
      "insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state,verified_at) values($1,$2,$3,1,$4,$5,'published',clock_timestamp()) returning id",
      [id, team, OWNER, command, target]
    )
  )[0]!.id;
  await db.root(
    "insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url,link_kind) values($1,$2,$3,'https://drive.google.com/file/d/v/view','drive')",
    [job, video, version]
  );
  // Written directly: the planning that should have followed the publication never ran.
  await db.root(
    'insert into private.catalog_video_r2_preferences(catalog_material_id,team_id,enabled,configured_by) values($1,$2,true,$3)',
    [id, team, OWNER]
  );
  return id;
}
const sweep = (limit: number) =>
  db.root('select public.service_catalog_video_r2_reconcile_pending($1)', [limit]);
const copies = (version: string) =>
  db.root<{ state: string; requested_by_catalog: string }>(
    'select state,requested_by_catalog from private.catalog_video_r2_copies where source_version=$1',
    [version]
  );
const version = (digit: string) => 'content-v1:' + digit.repeat(64);

it('trashed and missing catalogs ahead in the queue do not starve a new one', async () => {
  // Three older candidates that reconcile never settles fill a sweep of two.
  for (const [digit, lifecycle] of [
    ['1', 'trashed'],
    ['2', 'missing'],
    ['3', 'trashed']
  ] as const) {
    const id = await tickedPublishedCatalog(
      await material('video', 'video/mp4', 4_000_000),
      version(digit)
    );
    await db.root(
      "update private.catalog_video_r2_preferences set updated_at=clock_timestamp()-interval '3 days' where catalog_material_id=$1",
      [id]
    );
    await db.root(
      "update public.team_materials set lifecycle=$2, trashed_at=case when $2='trashed' then clock_timestamp() end, missing_at=case when $2='missing' then clock_timestamp() end where id=$1",
      [id, lifecycle]
    );
  }
  const fresh = await tickedPublishedCatalog(
    await material('video', 'video/mp4', 4_000_000),
    version('4')
  );
  await sweep(2);
  expect(await copies(version('4'))).toMatchObject([
    { state: 'planned', requested_by_catalog: fresh }
  ]);
  for (const digit of ['1', '2', '3']) expect(await copies(version(digit))).toEqual([]);
});

it('a held or legacy-unverified policy does not take a slot either', async () => {
  for (const [digit, patch] of [
    ['5', "mode='held'"],
    ['6', 'legacy_delivery_unverified=true']
  ] as const) {
    const id = await tickedPublishedCatalog(
      await material('video', 'video/mp4', 4_000_000),
      version(digit)
    );
    await db.root(
      "update private.catalog_video_r2_preferences set updated_at=clock_timestamp()-interval '3 days' where catalog_material_id=$1",
      [id]
    );
    await db.root(
      `update private.catalog_video_publication_policies set ${patch} where catalog_material_id=$1`,
      [id]
    );
  }
  const fresh = await tickedPublishedCatalog(
    await material('video', 'video/mp4', 4_000_000),
    version('7')
  );
  // The catalog from the first case is planned and still a candidate (its copy is not ready);
  // three slots cover it and the new one, and only them.
  await sweep(3);
  expect(await copies(version('7'))).toMatchObject([
    { state: 'planned', requested_by_catalog: fresh }
  ]);
  for (const digit of ['5', '6']) expect(await copies(version(digit))).toEqual([]);
});
