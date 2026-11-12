import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-12: a launch with "copy video to R2" ticked (MY_1_v5_catalog) published
 * its re-stitched variant with a Drive link and never got a copy of it. The option was written
 * before the first publication, so only the source video was copied, and the planning that
 * follows a verified publication did not happen. The minute sweep saw the catalog every minute
 * and never planned anything, so the catalog stayed on Drive for good.
 */
const OWNER = '50000000-0000-4000-8000-000000000951';
let db: TeamTestDb, team: string, connection: string;
let ordinal = 0;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'video-r2-missed@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('R2 missed copies')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2-missed','missed@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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
      [team, connection, `missed-${ordinal}`, category, mime, sizeBytes, 'a'.repeat(32)]
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
const sweep = () => db.root('select public.service_catalog_video_r2_reconcile_pending(50)');
const copies = (version: string) =>
  db.root<{ state: string; requested_by_catalog: string }>(
    'select state,requested_by_catalog from private.catalog_video_r2_copies where source_version=$1',
    [version]
  );

it('MY_1_v5: the minute sweep plans a copy that nothing ever attempted', async () => {
  const version = 'content-v1:' + '7'.repeat(64);
  const video = await material('video', 'video/mp4', 4_000_000);
  const id = await tickedPublishedCatalog(video, version);
  await sweep();
  expect(await copies(version)).toMatchObject([{ state: 'planned', requested_by_catalog: id }]);
  // Planned once: the next sweep does not plan a second copy of the same video.
  await sweep();
  expect(await copies(version)).toHaveLength(1);
});

it('a refused copy is still never retried by the minute sweep', async () => {
  const version = 'content-v1:' + '6'.repeat(64);
  const video = await material('video', 'video/mp4', 4_000_000);
  const id = await tickedPublishedCatalog(video, version);
  await db.root(
    "insert into private.catalog_video_r2_journal(team_id,catalog_material_id,source_material_id,stage,code,link_kind) values($1,$2,$3,'failed','VIDEO_R2_QUOTA_EXCEEDED','drive')",
    [team, id, video]
  );
  await sweep();
  expect(await copies(version)).toEqual([]);
});

it('a video already being copied is left to its copy', async () => {
  const version = 'content-v1:' + '5'.repeat(64);
  const video = await material('video', 'video/mp4', 4_000_000);
  const id = await tickedPublishedCatalog(video, version);
  await db.root(
    'insert into private.catalog_video_r2_copies(team_id,source_material_id,requested_by_catalog,source_version,size_bytes,part_bytes) values($1,$2,$3,$4,4000000,16777216)',
    [team, video, id, version]
  );
  await sweep();
  expect(await copies(version)).toMatchObject([{ state: 'planned' }]);
});
