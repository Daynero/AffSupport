import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production 2026-11-12 (20261207400500): a deferred catalog publication with
 * "copy video to R2" recorded each video's Drive link at creation, the copy became
 * ready while the job waited, and at due time the resolver answered with the R2
 * URL. The worker refused the different URL as SOURCE_CHANGED every minute and the
 * one-hour rule blocked the job: the catalog never got its links (DreamTeam
 * ZA 1_v8, BD 1 Gen_v7). A job keeps the Drive link it recorded for the same video
 * version; the switch to R2 is the reconcile job's, after publication.
 */
const OWNER = '50000000-0000-4000-8000-000000000b51';
let db: TeamTestDb, team: string, connection: string;
let ordinal = 0;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'keeps-drive@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Keeps Drive')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('keeps-drive','keeps@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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
      [team, connection, `keeps-${ordinal}`, category, mime, sizeBytes, 'a'.repeat(32)]
    )
  )[0]!.id;
}

/** A deferred catalog with the R2 option, waiting for its due time, its video copy ready. */
async function waitingDeferredCatalog(receipt: 'drive' | 'r2' | null) {
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
    "insert into private.catalog_video_publication_policies(catalog_material_id,team_id,actor_id,revision,mode,due_at,time_zone,target_id,legacy_delivery_unverified) values($1,$2,$3,1,'scheduled',clock_timestamp()-interval '1 minute','Europe/Kyiv',$4,false)",
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
      "insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state) values($1,$2,$3,1,$4,$5,'waiting') returning id",
      [id, team, OWNER, command, target]
    )
  )[0]!.id;
  if (receipt)
    await db.root(
      'insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url,link_kind) values($1,$2,$3,$4,$5)',
      [
        job,
        video,
        version,
        receipt === 'drive'
          ? 'https://drive.google.com/file/d/v/view'
          : 'https://videos.test/v1/' + 'b'.repeat(64) + '.mp4',
        receipt
      ]
    );
  await db.root(
    'insert into private.catalog_video_r2_preferences(catalog_material_id,team_id,enabled,configured_by) values($1,$2,true,$3)',
    [id, team, OWNER]
  );
  await db.root(
    "insert into private.catalog_video_r2_copies(team_id,source_material_id,requested_by_catalog,source_version,object_key,state,size_bytes,part_bytes,ready_at) values($1,$2,$3,$4,$5,'ready',9000000,16777216,clock_timestamp())",
    [team, video, id, version, 'v1/' + 'c'.repeat(60) + String(ordinal).padStart(4, '0') + '.mp4']
  );
  return { id, job, video, version };
}
const resolve = async (args: {
  catalog?: string | null;
  video: string;
  version: string;
  job?: string | null;
}) =>
  (
    await db.root<{ v: Record<string, unknown> }>(
      "select public.service_catalog_video_r2_resolve($1,$2,$3,9000000,'video/mp4',$4,$5) v",
      [args.catalog ?? null, args.video, args.version, 'a'.repeat(32), args.job ?? null]
    )
  )[0]!.v;

it('a job that recorded the Drive link keeps it at due time instead of switching to R2', async () => {
  const x = await waitingDeferredCatalog('drive');
  expect(await resolve({ video: x.video, version: x.version, job: x.job })).toEqual({
    enabled: false
  });
});

it('the switch to R2 still happens for the catalog itself (reconcile) and for a fresh job', async () => {
  const x = await waitingDeferredCatalog('drive');
  const byCatalog = await resolve({ catalog: x.id, video: x.video, version: x.version });
  expect(byCatalog).toMatchObject({ enabled: true, state: 'ready' });
  expect(String(byCatalog.url)).toMatch(/^https:\/\/videos\.test\//u);
  const fresh = await waitingDeferredCatalog(null);
  expect(
    await resolve({ video: fresh.video, version: fresh.version, job: fresh.job })
  ).toMatchObject({ enabled: true, state: 'ready' });
});

it('keeps an R2 receipt on R2 and does not hold a Drive link across a new video version', async () => {
  const r2 = await waitingDeferredCatalog('r2');
  expect(await resolve({ video: r2.video, version: r2.version, job: r2.job })).toMatchObject({
    enabled: true,
    state: 'ready'
  });
  const drive = await waitingDeferredCatalog('drive');
  const changed = await resolve({
    video: drive.video,
    version: 'content-v1:' + 'f'.repeat(64),
    job: drive.job
  });
  expect(changed.enabled).toBe(true);
});
