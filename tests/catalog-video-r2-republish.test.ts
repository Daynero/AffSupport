import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 050: since 047 only a publication job writes the video column of a catalog
 * with a publication policy. The option therefore moves the cells to R2 (and
 * back to Drive) by queueing one more job for the same target — found on beta,
 * where a ticked catalog kept its Drive link through an update.
 */
const OWNER = '50000000-0000-4000-8000-000000000901';
const WORKER = 'catalog-video-r2:republish-worker-1';
const VERSION = 'content-v1:' + 'a'.repeat(64);
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
      [team, connection, `republish-${ordinal}`, category, mime, sizeBytes, 'a'.repeat(32)]
    )
  )[0]!.id;
}
async function catalog(video: string) {
  const id = await material('other', 'application/vnd.google-apps.spreadsheet');
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://drive.google.com/file/d/x/view?usp=sharing','{}',$4,1)",
    [id, team, video, OWNER]
  );
  return id;
}
/** A catalog whose first publication (a Drive link for one source) is verified. */
async function publishedCatalog(video: string, version: string) {
  const id = await catalog(video);
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
  await insertJob(
    id,
    1,
    target,
    'published',
    'https://drive.google.com/file/d/x/view',
    null,
    video,
    version
  );
  return { id, target };
}
async function insertJob(
  catalogId: string,
  revision: number,
  target: string,
  state: string,
  url: string | null,
  kind: string | null,
  video: string,
  version: string
) {
  const command = (
    await db.root<{ id: string }>(
      "insert into private.catalog_publication_commands(request_id,team_id,actor_id,payload,receipt) values(gen_random_uuid(),$1,$2,'{}','{}') returning request_id id",
      [team, OWNER]
    )
  )[0]!.id;
  const job = (
    await db.root<{ id: string }>(
      "insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state,verified_at) values($1,$2,$3,$4,$5,$6,$7,case when $7='published' then clock_timestamp() end) returning id",
      [catalogId, team, OWNER, revision, command, target, state]
    )
  )[0]!.id;
  if (url)
    await db.root(
      'insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url,link_kind) values($1,$2,$3,$4,$5)',
      [job, video, version, url, kind]
    );
  return job;
}
const jobs = (catalogId: string) =>
  db.root<{ revision: string; state: string; target_id: string; origin: string | null }>(
    "select j.revision::text,j.state,j.target_id,c.payload->>'origin' origin from private.catalog_video_publication_jobs j join private.catalog_publication_commands c on c.request_id=j.command_id where j.catalog_material_id=$1 order by j.revision",
    [catalogId]
  );
/** What the publication worker does when a job's cells are verified. */
async function settle(
  catalogId: string,
  revision: number,
  url: string,
  kind: 'drive' | 'r2',
  video: string,
  version: string
) {
  const job = (
    await db.root<{ id: string }>(
      'select id from private.catalog_video_publication_jobs where catalog_material_id=$1 and revision=$2',
      [catalogId, revision]
    )
  )[0]!.id;
  await db.root(
    'insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url,link_kind) values($1,$2,$3,$4,$5)',
    [job, video, version, url, kind]
  );
  await rpc('service_catalog_video_r2_confirm_use', [
    null,
    kind,
    JSON.stringify(kind === 'r2' ? [{ sourceMaterialId: video, sourceVersion: version }] : []),
    job
  ]);
  await db.root(
    "update private.catalog_video_publication_jobs set state='published',verified_at=clock_timestamp() where id=$1",
    [job]
  );
}
async function finishCopy(copyId: string, size: number) {
  await db.root(
    "update private.catalog_video_r2_copies set next_attempt_at=clock_timestamp()+interval '1 day' where id<>$1 and state in ('planned','uploading','verifying')",
    [copyId]
  );
  const claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<string, unknown>;
  expect(claim.copyId).toBe(copyId);
  const fence = claim.fence as number;
  await rpc('service_catalog_video_r2_begin_upload', [copyId, WORKER, fence, 'upload-1']);
  await rpc('service_catalog_video_r2_part', [
    copyId,
    WORKER,
    fence,
    1,
    size,
    'c'.repeat(64),
    '"e"',
    'readback',
    900
  ]);
  await rpc('service_catalog_video_r2_verifying', [copyId, WORKER, fence]);
  await rpc('service_catalog_video_r2_ready', [copyId, WORKER, fence, true, 3000]);
}

beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207195500_catalog_video_r2_gone_catalogs.sql'
  });
  await createUser(db, { id: OWNER, email: 'video-r2-republish@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('R2 republish')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2-republish','republish@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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
}, 120_000);
afterAll(async () => {
  await db?.close();
});

describe('catalog video R2 link reconciliation', () => {
  it('plans the copy when the option is ticked and republishes the same target once it is ready', async () => {
    const video = await material('video', 'video/mp4', 9_000_000);
    const { id, target } = await publishedCatalog(video, VERSION);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, id, true]);
    const copies = await db.root<{ id: string; state: string }>(
      'select id,state from private.catalog_video_r2_copies where team_id=$1 and source_version=$2',
      [team, VERSION]
    );
    expect(copies).toMatchObject([{ state: 'planned' }]);
    // Not ready yet: the catalog keeps the working Drive link and no job is queued.
    expect(await jobs(id)).toHaveLength(1);

    await finishCopy(copies[0]!.id, 9_000_000);
    expect(await jobs(id)).toMatchObject([
      { revision: '1', state: 'published' },
      { revision: '2', state: 'waiting', target_id: target, origin: 'video_r2' }
    ]);
    expect(
      await db.root(
        'select revision::text,mode from private.catalog_video_publication_policies where catalog_material_id=$1',
        [id]
      )
    ).toEqual([{ revision: '2', mode: 'immediate' }]);

    // The job publishes the R2 link: nothing is left to reconcile, so no third job.
    await settle(id, 2, 'https://videos.test/v/' + '1'.repeat(32) + '.mp4', 'r2', video, VERSION);
    expect(await jobs(id)).toHaveLength(2);
    expect(await rpc('service_catalog_video_r2_reconcile_pending', [50])).toBe(0);
    expect(
      await db.root(
        'select link_kind from public.team_catalog_video_r2_signals where catalog_material_id=$1',
        [id]
      )
    ).toEqual([{ link_kind: 'r2' }]);

    // Unticking returns the cells to Drive through one more job; the copy retires once
    // that job confirmed the Drive links, never before.
    await rpc('service_catalog_video_r2_set_preference', [OWNER, id, false]);
    expect((await jobs(id)).at(-1)).toMatchObject({
      revision: '3',
      state: 'waiting',
      target_id: target,
      origin: 'video_r2'
    });
    expect(
      await db.root('select state from private.catalog_video_r2_copies where id=$1', [
        copies[0]!.id
      ])
    ).toEqual([{ state: 'ready' }]);
    await settle(id, 3, 'https://drive.google.com/file/d/x/view', 'drive', video, VERSION);
    expect(
      await db.root('select state,retire_reason from private.catalog_video_r2_copies where id=$1', [
        copies[0]!.id
      ])
    ).toEqual([{ state: 'retiring', retire_reason: 'disabled' }]);
    expect(await jobs(id)).toHaveLength(3);
  });

  it('waits behind an active job and throttles itself; the minute sweep finishes the work', async () => {
    const version = 'content-v1:' + 'b'.repeat(64);
    const video = await material('video', 'video/mp4', 5_000_000);
    const { id, target } = await publishedCatalog(video, version);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, id, true]);
    const copy = (
      await db.root<{ id: string }>(
        'select id from private.catalog_video_r2_copies where source_version=$1',
        [version]
      )
    )[0]!.id;
    // The owner's own publication is in flight when the copy becomes ready.
    await db.root(
      'update private.catalog_video_publication_policies set revision=2 where catalog_material_id=$1',
      [id]
    );
    await insertJob(id, 2, target, 'waiting', null, null, video, version);
    await finishCopy(copy, 5_000_000);
    expect(await jobs(id)).toHaveLength(2);
    // It publishes the Drive link it had prepared; the settlement itself queues the R2 job.
    await settle(id, 2, 'https://drive.google.com/file/d/x/view', 'drive', video, version);
    expect((await jobs(id)).at(-1)).toMatchObject({
      revision: '3',
      state: 'waiting',
      origin: 'video_r2'
    });

    // A reconciliation job that keeps publishing Drive (say the copy vanished and came
    // back) is not followed by another one for ten minutes.
    await settle(id, 3, 'https://drive.google.com/file/d/x/view', 'drive', video, version);
    expect(await jobs(id)).toHaveLength(3);
    expect(await rpc('service_catalog_video_r2_reconcile_pending', [50])).toBe(0);
    await db.root(
      "update private.catalog_video_publication_jobs set created_at=created_at-interval '15 minutes' where catalog_material_id=$1",
      [id]
    );
    expect(await rpc('service_catalog_video_r2_reconcile_pending', [50])).toBe(1);
    expect((await jobs(id)).at(-1)).toMatchObject({
      revision: '4',
      state: 'waiting',
      origin: 'video_r2'
    });
  });

  it('never touches a catalog without the option, a held policy or an unverified legacy delivery', async () => {
    const version = 'content-v1:' + 'c'.repeat(64);
    const video = await material('video', 'video/mp4', 5_000_000);
    const plain = await publishedCatalog(video, version);
    await db.root(
      'update private.catalog_video_publication_policies set revision=2 where catalog_material_id=$1',
      [plain.id]
    );
    await insertJob(plain.id, 2, plain.target, 'waiting', null, null, video, version);
    await db.root(
      "update private.catalog_video_publication_jobs set state='published',verified_at=clock_timestamp() where catalog_material_id=$1 and revision=2",
      [plain.id]
    );
    expect(await jobs(plain.id)).toHaveLength(2);
    expect(
      await db.root(
        'select 1 from public.team_catalog_video_r2_signals where catalog_material_id=$1',
        [plain.id]
      )
    ).toEqual([]);

    const heldVersion = 'content-v1:' + 'd'.repeat(64);
    const heldVideo = await material('video', 'video/mp4', 5_000_000);
    const held = await publishedCatalog(heldVideo, heldVersion);
    await db.root(
      "update private.catalog_video_publication_policies set mode='held' where catalog_material_id=$1",
      [held.id]
    );
    await rpc('service_catalog_video_r2_set_preference', [OWNER, held.id, true]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_copies where source_version=$1', [
        heldVersion
      ])
    ).toEqual([]);
    expect(await jobs(held.id)).toHaveLength(1);

    const legacyVersion = 'content-v1:' + 'e'.repeat(64);
    const legacyVideo = await material('video', 'video/mp4', 5_000_000);
    const unverified = await publishedCatalog(legacyVideo, legacyVersion);
    await db.root(
      'update private.catalog_video_publication_policies set legacy_delivery_unverified=true where catalog_material_id=$1',
      [unverified.id]
    );
    await rpc('service_catalog_video_r2_set_preference', [OWNER, unverified.id, true]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_copies where source_version=$1', [
        legacyVersion
      ])
    ).toEqual([]);
    expect(await jobs(unverified.id)).toHaveLength(1);
  });

  it('plans the current video of a catalog without a policy so its next update can use the copy', async () => {
    const video = await material('video', 'video/mp4', 7_000_000);
    const legacy = await catalog(video);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, legacy, true]);
    expect(
      await db.root(
        'select state,source_material_id from private.catalog_video_r2_copies where requested_by_catalog=$1',
        [legacy]
      )
    ).toEqual([{ state: 'planned', source_material_id: video }]);
    expect(
      await db.root(
        'select 1 from private.catalog_video_publication_jobs where catalog_material_id=$1',
        [legacy]
      )
    ).toEqual([]);
  });

  it('copies nothing for a creation that never reached a verified publication', async () => {
    // Registration writes the option while the first publication is still open:
    // no copy yet. A creation that fails here (or is abandoned) leaves R2 untouched.
    const version = 'content-v1:' + 'f'.repeat(64);
    const video = await material('video', 'video/mp4', 6_000_000);
    const id = await catalog(video);
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
    await insertJob(id, 1, target, 'waiting', null, null, video, version);
    await rpc('service_catalog_video_r2_apply_create_option', [OWNER, id, true]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_copies where source_version=$1', [
        version
      ])
    ).toEqual([]);
    // The first publication is verified with the Drive link: now the copy is planned,
    // and the catalog moves to R2 once it is ready.
    await settle(id, 1, 'https://drive.google.com/file/d/f/view', 'drive', video, version);
    const planned = await db.root<{ id: string; state: string; requested_by_catalog: string }>(
      'select id,state,requested_by_catalog from private.catalog_video_r2_copies where source_version=$1',
      [version]
    );
    expect(planned).toMatchObject([{ state: 'planned', requested_by_catalog: id }]);
    await finishCopy(planned[0]!.id, 6_000_000);
    expect((await jobs(id)).at(-1)).toMatchObject({
      revision: '2',
      state: 'waiting',
      origin: 'video_r2'
    });
  });

  it('cancels copies nobody waits for instead of uploading them, and tombstones them', async () => {
    // A copy planned without a catalog (the pre-migration creation path) that no
    // catalog took within an hour, and one whose catalog turned the option off.
    const lonelyVideo = await material('video', 'video/mp4', 4_000_000);
    const lonely = (
      await db.root<{ id: string }>(
        "insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,size_bytes,part_bytes,created_at) values($1,$2,'content-v1:'||repeat('1',64),4000000,16777216,clock_timestamp()-interval '2 hours') returning id",
        [team, lonelyVideo]
      )
    )[0]!.id;
    const fresh = (
      await db.root<{ id: string }>(
        "insert into private.catalog_video_r2_copies(team_id,source_material_id,source_version,size_bytes,part_bytes) values($1,$2,'content-v1:'||repeat('2',64),4000000,16777216) returning id",
        [team, lonelyVideo]
      )
    )[0]!.id;
    const offVideo = await material('video', 'video/mp4', 4_000_000);
    const offCatalog = await catalog(offVideo);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, offCatalog, true]);
    const off = (
      (await rpc('service_catalog_video_r2_resolve', [
        offCatalog,
        offVideo,
        'content-v1:' + '3'.repeat(64),
        4_000_000,
        'video/mp4',
        null
      ])) as {
        copyId: string;
      }
    ).copyId;
    await rpc('service_catalog_video_r2_set_preference', [OWNER, offCatalog, false]);
    await db.root(
      "update private.catalog_video_r2_copies set next_attempt_at=clock_timestamp()+interval '1 day' where id<>all($1::uuid[]) and state in ('planned','uploading','verifying')",
      [[lonely, fresh, off]]
    );
    await db.root(
      "update private.catalog_video_r2_copies set next_attempt_at=clock_timestamp()-interval '1 minute' where id=any($1::uuid[])",
      [[lonely, off]]
    );
    await db.root(
      'update private.catalog_video_r2_copies set next_attempt_at=clock_timestamp() where id=$1',
      [fresh]
    );
    const claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<
      string,
      unknown
    > | null;
    // The fresh catalog-less copy may still be taken by a creation in progress.
    expect(claim?.copyId).toBe(fresh);
    expect(
      await db.root<{ id: string; state: string; last_error: string }>(
        'select id,state,last_error from private.catalog_video_r2_copies where id=any($1::uuid[]) order by id',
        [[lonely, off]]
      )
    ).toEqual(
      [lonely, off].sort().map(id => ({ id, state: 'failed', last_error: 'VIDEO_R2_CANCELED' }))
    );
    expect(
      await db.root(
        'select reason from private.catalog_video_r2_purges where copy_ref=any($1::uuid[])',
        [[lonely, off]]
      )
    ).toEqual([{ reason: 'failed_upload' }, { reason: 'failed_upload' }]);
  });

  it('lets launch defaults keep the R2 choice of the catalog, as a boolean only', async () => {
    const catalog = {
      productCount: 20,
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    };
    await db.root(
      'insert into public.team_launch_defaults(team_id,config,updated_by) values($1,$2,$3)',
      [team, JSON.stringify({ catalog: { ...catalog, copyVideoToR2: true } }), OWNER]
    );
    expect(
      await db.root(
        "select config->'catalog'->'copyVideoToR2' v from public.team_launch_defaults where team_id=$1",
        [team]
      )
    ).toEqual([{ v: true }]);
    await expect(
      db.root('update public.team_launch_defaults set config=$2 where team_id=$1', [
        team,
        JSON.stringify({ catalog: { ...catalog, copyVideoToR2: 'yes' } })
      ])
    ).rejects.toThrow(/INVALID_INPUT/u);
  });

  it('reads the videos of a first publication from its target when it left no link receipts', async () => {
    // The first publication of a new catalog writes no link receipts; ticking the
    // option on such a catalog planned nothing and the icon waited for ever (beta).
    const version = 'content-v1:' + '9'.repeat(64);
    const video = await material('video', 'video/mp4', 3_000_000);
    const id = await catalog(video);
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
    await insertJob(id, 1, target, 'published', null, null, video, version);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, id, true]);
    const copy = await db.root<{ id: string; state: string }>(
      'select id,state from private.catalog_video_r2_copies where source_version=$1',
      [version]
    );
    expect(copy).toMatchObject([{ state: 'planned' }]);
    await finishCopy(copy[0]!.id, 3_000_000);
    expect((await jobs(id)).at(-1)).toMatchObject({
      revision: '2',
      state: 'waiting',
      origin: 'video_r2'
    });
  });

  it('lets a catalog deleted for good release its copy, but keeps it for one in the trash', async () => {
    /** A catalog on R2 for its own source version; returns the catalog and its copy. */
    async function onR2(version: string) {
      const video = await material('video', 'video/mp4', 5_000_000);
      const { id } = await publishedCatalog(video, version);
      await rpc('service_catalog_video_r2_set_preference', [OWNER, id, true]);
      const copy = (
        await db.root<{ id: string }>(
          'select id from private.catalog_video_r2_copies where team_id=$1 and source_version=$2',
          [team, version]
        )
      )[0]!.id;
      await finishCopy(copy, 5_000_000);
      await settle(
        id,
        2,
        'https://videos.test/v/' + version.slice(-32) + '.mp4',
        'r2',
        video,
        version
      );
      return { id, copy };
    }
    const copyState = async (copy: string) =>
      (
        await db.root<{ state: string; retire_reason: string | null }>(
          'select state,retire_reason from private.catalog_video_r2_copies where id=$1',
          [copy]
        )
      )[0];
    const uses = async (catalogId: string) =>
      (
        await db.root<{ n: string }>(
          'select count(*)::text n from private.catalog_video_r2_uses where catalog_material_id=$1',
          [catalogId]
        )
      )[0]!.n;

    const moved = await onR2('content-v1:' + 'de'.repeat(32));
    const trashed = await onR2('content-v1:' + 'ef'.repeat(32));
    const removed = await onR2('content-v1:' + 'fa'.repeat(32));
    const expired = await onR2('content-v1:' + '9b'.repeat(32));
    await db.root(
      "update public.team_materials set lifecycle='missing',missing_reason='out_of_root',missing_at=clock_timestamp() where id=$1",
      [moved.id]
    );
    await db.root(
      "update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp()-interval '29 days' where id=$1",
      [trashed.id]
    );
    await db.root(
      "update public.team_materials set lifecycle='missing',missing_reason='removed',missing_at=clock_timestamp() where id=$1",
      [removed.id]
    );
    await db.root(
      "update public.team_materials set lifecycle='trashed',trashed_at=clock_timestamp()-interval '31 days' where id=$1",
      [expired.id]
    );

    await rpc('service_catalog_video_r2_retire_orphans', []);
    // Moved out of the watched folder or still restorable from the trash: the sheet
    // still points at the copy, so it stays.
    expect(await uses(moved.id)).toBe('1');
    expect(await copyState(moved.copy)).toEqual({ state: 'ready', retire_reason: null });
    expect(await uses(trashed.id)).toBe('1');
    expect(await copyState(trashed.copy)).toEqual({ state: 'ready', retire_reason: null });
    // Deleted for good, or left in the trash past Drive's 30 days: released and retired.
    expect(await uses(removed.id)).toBe('0');
    expect(await copyState(removed.copy)).toEqual({
      state: 'retiring',
      retire_reason: 'catalog_deleted'
    });
    // Nothing to return to: no grace window, the same sweep deletes them.
    expect(
      await db.root<{ due: boolean }>(
        'select retire_after<=clock_timestamp() due from private.catalog_video_r2_copies where id=any($1::uuid[]) order by id',
        [[removed.copy, expired.copy]]
      )
    ).toEqual([{ due: true }, { due: true }]);
    expect(
      await db.root<{ due: boolean }>(
        'select retire_after is null due from private.catalog_video_r2_copies where id=$1',
        [trashed.copy]
      )
    ).toEqual([{ due: true }]);
    expect(await uses(expired.id)).toBe('0');
    expect(await copyState(expired.copy)).toEqual({
      state: 'retiring',
      retire_reason: 'catalog_deleted'
    });
  });
});
