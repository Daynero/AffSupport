import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { expireBackoff, poisonRows, settleFailure } from './support/poison-rows';

/**
 * 1.4.3 (20261207396000): the video R2 worker's two minute loops follow the
 * 20261207395000 rule. A row that raises is recorded with a closed code and
 * backed off, the pass settles every other row, and the row is retried and its
 * record cleared once it passes. Before, reconcile_pending swallowed the error
 * and kept the bad catalog at the head of its list every pass, and
 * retire_orphans aborted the whole pass (and the sweep that calls it).
 */
const OWNER = '50000000-0000-4000-8000-000000000a01';
let db: TeamTestDb;
let team: string;
let connection: string;
let ordinal = 0;

const rpc = async <T = unknown>(name: string, args: unknown[]) =>
  (
    await db.root<{ v: T }>(
      `select public.${name}(${args.map((_, i) => '$' + String(i + 1)).join(',')}) v`,
      args
    )
  )[0]!.v;
async function material(category: string, mime: string, sizeBytes: number | null = null) {
  ordinal += 1;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum) values($1,$2,$3,'synthetic-root',$3,'file',$4,$5,$6,$7) returning id",
      [team, connection, `loops-${ordinal}`, category, mime, sizeBytes, 'a'.repeat(32)]
    )
  )[0]!.id;
}
/** A catalog with the R2 option ticked whose verified publication still carries a Drive link. */
async function catalogToReconcile(): Promise<string> {
  const video = await material('video', 'video/mp4', 9_000_000);
  const version = `content-v1:${String(ordinal).padStart(64, '0')}`;
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
    "insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url,link_kind) values($1,$2,$3,'https://drive.google.com/file/d/x/view','drive')",
    [job, video, version]
  );
  await db.root(
    'insert into private.catalog_video_r2_preferences(catalog_material_id,team_id,enabled) values($1,$2,true)',
    [id, team]
  );
  return id;
}
/** A ready copy no catalog uses, past the grace interval. */
async function orphanCopy(): Promise<string> {
  const video = await material('video', 'video/mp4', 9_000_000);
  return (
    await db.root<{ id: string }>(
      "insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,state,size_bytes,part_bytes,ready_at) values($1,$2,$3,'ready',9000000,8388608,clock_timestamp()-interval '30 days') returning id",
      [team, video, `orphan-${String(ordinal)}`]
    )
  )[0]!.id;
}
const copyState = async (id: string) =>
  (
    await db.root<{ state: string }>(
      'select state from private.catalog_video_r2_copies where id=$1',
      [id]
    )
  )[0]!.state;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'video-r2-loops@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('R2 loops')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2-loops','loops@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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

describe('video R2 minute loops', () => {
  it('retire_orphans retires every other orphan when one copy raises, backs it off, then retires it', async () => {
    const bad = await orphanCopy();
    const good = await orphanCopy();
    const cure = await poisonRows(db, 'private.catalog_video_r2_copies', 'id', [bad]);

    expect(await rpc('service_catalog_video_r2_retire_orphans', [])).toBe(1);
    expect(await copyState(good)).toBe('retiring');
    expect(await copyState(bad)).toBe('ready');
    expect(await settleFailure(db, 'video_r2_retire_orphan', bad)).toEqual({
      attempts: 1,
      last_code: 'SETTLE_TEST_POISON',
      deferred: true
    });

    // Backed off: the next pass does not even try it.
    expect(await rpc('service_catalog_video_r2_retire_orphans', [])).toBe(0);
    expect((await settleFailure(db, 'video_r2_retire_orphan', bad))?.attempts).toBe(1);

    await cure();
    await expireBackoff(db, 'video_r2_retire_orphan', bad);
    expect(await rpc('service_catalog_video_r2_retire_orphans', [])).toBe(1);
    expect(await copyState(bad)).toBe('retiring');
    expect(await settleFailure(db, 'video_r2_retire_orphan', bad)).toBeUndefined();
  });

  it('reconcile_pending records and skips a catalog that raises instead of retrying it at the head every pass', async () => {
    const bad = await catalogToReconcile();
    const good = await catalogToReconcile();
    // Stand in for whatever makes one catalog's reconciliation raise in production.
    const original = (
      await db.root<{ d: string }>(
        "select pg_get_functiondef('private.catalog_video_r2_reconcile(uuid,boolean)'::regprocedure) d"
      )
    )[0]!.d;
    await db.root('create table private.test_reconcile_poison(id uuid primary key)');
    await db.root('insert into private.test_reconcile_poison values($1)', [bad]);
    await db.root(
      `create or replace function private.catalog_video_r2_reconcile(p_catalog uuid,p_plan boolean default false) returns text
       language plpgsql security definer set search_path='' as $$
       begin
        if exists(select 1 from private.test_reconcile_poison where id=p_catalog) then raise exception 'SETTLE_TEST_POISON'; end if;
        return 'republished';
       end $$`
    );
    try {
      expect(await rpc('service_catalog_video_r2_reconcile_pending', [50])).toBe(1);
      expect(await settleFailure(db, 'video_r2_reconcile', bad)).toEqual({
        attempts: 1,
        last_code: 'SETTLE_TEST_POISON',
        deferred: true
      });
      expect(await settleFailure(db, 'video_r2_reconcile', good)).toBeUndefined();

      // Backed off: the bad catalog no longer takes a slot; the good one still runs.
      expect(await rpc('service_catalog_video_r2_reconcile_pending', [50])).toBe(1);
      expect((await settleFailure(db, 'video_r2_reconcile', bad))?.attempts).toBe(1);
      expect(await rpc('service_catalog_video_r2_reconcile_pending', [1])).toBe(1);

      await db.root('delete from private.test_reconcile_poison');
      await expireBackoff(db, 'video_r2_reconcile', bad);
      expect(await rpc('service_catalog_video_r2_reconcile_pending', [50])).toBe(2);
      expect(await settleFailure(db, 'video_r2_reconcile', bad)).toBeUndefined();
    } finally {
      await db.root(original);
      await db.root('drop table if exists private.test_reconcile_poison');
    }
  });
});
