import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-12 (DreamTeam, GR 2_v2_catalog): «Потрібна перевірка» with nothing to
 * review. The catalog had left auto-update, so the only pass that clears the flag — freeing a
 * quarantined updater item — never reached it.
 */
const OWNER = '50000000-0000-4000-8000-000000000971';
let db: TeamTestDb, team: string, connection: string;
let ordinal = 0;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'stale-review@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Stale review')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('stale-review','stale@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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
    'insert into public.team_catalog_updaters(team_id) values($1) on conflict do nothing',
    [team]
  );
}, 240_000);
afterAll(async () => {
  await db?.close();
});

async function flaggedCatalog() {
  const material = async (category: string, mime: string) => {
    ordinal += 1;
    return (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum) values($1,$2,$3,'synthetic-root',$3,'file',$4,$5,4,$6) returning id",
        [team, connection, `stale-${ordinal}`, category, mime, 'a'.repeat(32)]
      )
    )[0]!.id;
  };
  const video = await material('video', 'video/mp4');
  const id = await material('other', 'application/vnd.google-apps.spreadsheet');
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant,last_update_error,last_update_error_at) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://drive.google.com/file/d/x/view','{}',$4,1,'CATALOG_ATTEMPT_STATE_INCONSISTENT',clock_timestamp())",
    [id, team, video, OWNER]
  );
  return id;
}
const flag = async (id: string) =>
  (
    await db.root<{ e: string | null }>(
      'select last_update_error e from public.team_product_catalogs where material_id=$1',
      [id]
    )
  )[0]!.e;
const sweep = () => db.root('select private.clear_stale_catalog_review_flags()');

it('GR 2_v2: a review flag with no item, reconciliation or running attempt clears', async () => {
  const id = await flaggedCatalog();
  await sweep();
  expect(await flag(id)).toBeNull();
});

it('a flag backed by an item waiting for reconciliation stays', async () => {
  const id = await flaggedCatalog();
  await db.root(
    'insert into public.team_catalog_updater_items(catalog_material_id,team_id,round_due_at,reconciliation_required) values($1,$2,clock_timestamp(),true)',
    [id, team]
  );
  await sweep();
  expect(await flag(id)).toBe('CATALOG_ATTEMPT_STATE_INCONSISTENT');
});
