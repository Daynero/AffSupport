import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-12 (DreamTeam, PK 33(адалт)_v6_catalog): a publication dispatched at 08:46
 * stayed 'unknown' for hours because the sheet had grown since and every verification said
 * SOURCE_CHANGED; its update reconciliation kept the catalog «not confirmed».
 */
const OWNER = '50000000-0000-4000-8000-000000000981';
let db: TeamTestDb, team: string, connection: string;
let ordinal = 0;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'unverifiable@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Unverifiable')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('unverifiable','unverifiable@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [OWNER]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'synthetic-root','Synthetic','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
}, 240_000);
afterAll(async () => {
  await db?.close();
});

async function material(category: string, mime: string) {
  ordinal += 1;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum) values($1,$2,$3,'synthetic-root',$3,'file',$4,$5,4,$6) returning id",
      [team, connection, `unverifiable-${ordinal}`, category, mime, 'a'.repeat(32)]
    )
  )[0]!.id;
}
/** A catalog whose dispatched publication is unknown, with its reconciliation open. */
async function unknownPublication(dispatchedAgo: string, code: string | null) {
  const video = await material('video', 'video/mp4');
  const id = await material('other', 'application/vnd.google-apps.spreadsheet');
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://drive.google.com/file/d/x/view','{}',$4,1)",
    [id, team, video, OWNER]
  );
  const target = (
    await db.root<{ id: string }>(
      "insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values($1,'source',$2,'content-v1:x') returning id",
      [team, video]
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
  const fence = crypto.randomUUID();
  const job = (
    await db.root<{ id: string }>(
      `insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state,dispatched_at,writer_fence,preparation_error_code,preparation_error_at)
       values($1,$2,$3,1,$4,$5,'unknown',clock_timestamp()-interval '${dispatchedAgo}',$6,$7,clock_timestamp()) returning id`,
      [id, team, OWNER, command, target, fence, code]
    )
  )[0]!.id;
  await db.root(
    "insert into private.catalog_update_reconciliations(catalog_material_id,marker,expected_count,product_count,settings_snapshot,publication_job_id,publication_revision) values($1,$2,1,3,'{}',$3,1)",
    [id, fence, job]
  );
  return { id, job };
}
const state = async (f: { id: string; job: string }) => ({
  job: (
    await db.root<{ state: string; blocked_reason: string | null }>(
      'select state,blocked_reason from private.catalog_video_publication_jobs where id=$1',
      [f.job]
    )
  )[0]!,
  reconciliations: (
    await db.root<{ n: number }>(
      'select count(*)::integer n from private.catalog_update_reconciliations where catalog_material_id=$1',
      [f.id]
    )
  )[0]!.n
});
const sweep = () => db.root('select private.close_unverifiable_catalog_publications()');

it('PK 33: an unknown publication the changed sheet can no longer verify closes, releasing its update', async () => {
  const f = await unknownPublication('5 hours', 'SOURCE_CHANGED');
  await sweep();
  expect(await state(f)).toEqual({
    job: { state: 'blocked', blocked_reason: 'stale_job' },
    reconciliations: 0
  });
});

it('a recent unknown publication, or one that failed for another reason, is left to verify', async () => {
  const recent = await unknownPublication('30 minutes', 'SOURCE_CHANGED');
  const other = await unknownPublication('5 hours', 'DRIVE_UNAVAILABLE');
  await sweep();
  expect((await state(recent)).job.state).toBe('unknown');
  expect((await state(other)).job.state).toBe('unknown');
  expect((await state(recent)).reconciliations).toBe(1);
});
