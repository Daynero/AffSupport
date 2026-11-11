import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const OWNER = '50000000-0000-4000-8000-000000000011';
const VIEWER = '50000000-0000-4000-8000-000000000012';
const OUTSIDER = '50000000-0000-4000-8000-000000000013';
const MIGRATION = '20261207193000_catalog_video_r2.sql';
const WORKER = 'catalog-video-r2:test-worker-0001';
let db: TeamTestDb;
let team: string;
let connection: string;
let ordinal = 0;

async function material(category: string, mime: string, sizeBytes: number | null = null) {
  ordinal += 1;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum) values($1,$2,$3,'synthetic-root',$3,'file',$4,$5,$6,$7) returning id",
      [team, connection, `file-${ordinal}`, category, mime, sizeBytes, 'a'.repeat(32)]
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
const rpc = async <T = unknown>(name: string, args: unknown[]) =>
  (
    await db.root<{ v: T }>(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) v`,
      args
    )
  )[0]!.v;
const enableFeature = async (policy = true) =>
  db.root(
    `update private.catalog_video_r2_config set enabled=true,public_origin='https://videos.test',policy_confirmed_at=${policy ? 'clock_timestamp()' : 'null'}`
  );
/** Other tests leave claimable copies behind; the worker picks the oldest due one. */
const park = (except: string) =>
  db.root(
    "update private.catalog_video_r2_copies set next_attempt_at=clock_timestamp()+interval '1 day' where id<>$1 and state in ('planned','uploading','verifying')",
    [except]
  );
async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  await db.root(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.root('reset role');
  }
}
async function readyCopy(catalogId: string, video: string, version: string, size = 10_000_000) {
  const planned = (await rpc('service_catalog_video_r2_resolve', [
    catalogId,
    video,
    version,
    size,
    'video/mp4',
    'b'.repeat(32)
  ])) as { copyId: string; state: string };
  expect(planned.state).toBe('planned');
  await park(planned.copyId);
  const claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<string, unknown>;
  expect(claim.copyId).toBe(planned.copyId);
  const fence = claim.fence as number;
  await rpc('service_catalog_video_r2_begin_upload', [planned.copyId, WORKER, fence, 'upload-1']);
  await rpc('service_catalog_video_r2_part', [
    planned.copyId,
    WORKER,
    fence,
    1,
    size,
    'c'.repeat(64),
    '"etag-1"',
    'readback',
    1200
  ]);
  await rpc('service_catalog_video_r2_verifying', [planned.copyId, WORKER, fence]);
  await rpc('service_catalog_video_r2_ready', [planned.copyId, WORKER, fence, true, 4000]);
  return planned.copyId;
}

beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: MIGRATION });
  await createUser(db, { id: OWNER, email: 'video-r2-owner@example.test' });
  await createUser(db, { id: VIEWER, email: 'video-r2-viewer@example.test' });
  await createUser(db, { id: OUTSIDER, email: 'video-r2-outsider@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('R2 videos')")
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, VIEWER]
  );
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2','video-r2@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [OWNER]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'synthetic-root','Synthetic','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
}, 120_000);
afterAll(async () => {
  await db?.close();
});

describe('catalog video R2 metadata authority', () => {
  it('starts disabled, hides behind the policy gate and keeps browser roles out', async () => {
    const disabled = await rpc('service_catalog_video_r2_availability', [OWNER, team]);
    expect(disabled).toMatchObject({
      available: false,
      reason: 'VIDEO_R2_DISABLED',
      canManage: true
    });
    await enableFeature(false);
    expect(await rpc('service_catalog_video_r2_availability', [VIEWER, team])).toMatchObject({
      available: false,
      reason: 'VIDEO_R2_POLICY_PENDING',
      canManage: false
    });
    await enableFeature(true);
    expect(await rpc('service_catalog_video_r2_availability', [OWNER, team])).toEqual({
      available: true,
      canManage: true,
      contractVersion: 1,
      publicOrigin: 'https://videos.test'
    });
    await expect(rpc('service_catalog_video_r2_availability', [OUTSIDER, team])).rejects.toThrow(
      /PERMISSION_DENIED/u
    );
    await asRole('authenticated', async () => {
      await expect(
        db.asUser(VIEWER, 'select * from private.catalog_video_r2_copies')
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        db.asUser(OWNER, 'select public.service_catalog_video_r2_availability($1,$2)', [
          OWNER,
          team
        ])
      ).rejects.toThrow(/permission denied/iu);
    });
    const privileges = await db.root<{ ok: boolean }>(
      "select not has_function_privilege('authenticated','public.service_catalog_video_r2_claim(text)','EXECUTE') and not has_function_privilege('anon','public.service_catalog_video_r2_set_preference(uuid,uuid,boolean)','EXECUTE') and has_function_privilege('service_role','public.service_catalog_video_r2_resolve(uuid,uuid,text,bigint,text,text,uuid,uuid,boolean)','EXECUTE') ok"
    );
    expect(privileges[0]!.ok).toBe(true);
    const fence = await db.root<{ ok: boolean }>(
      'select private.task_cleanup_coverage_verified() ok'
    );
    expect(fence[0]!.ok).toBe(true);
    const rls = await db.root<{ ok: boolean }>(
      "select count(*)=8 and bool_and(c.relrowsecurity) ok from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname like 'catalog_video_r2_%' and c.relkind='r'"
    );
    expect(rls[0]!.ok).toBe(true);
  });

  it('records the option with its author and mirrors it into the public signal', async () => {
    const video = await material('video', 'video/mp4', 10_000_000);
    const cat = await catalog(video);
    await expect(
      rpc('service_catalog_video_r2_set_preference', [VIEWER, cat, true])
    ).rejects.toThrow(/PERMISSION_DENIED/u);
    await expect(
      rpc('service_catalog_video_r2_set_preference', [OUTSIDER, cat, true])
    ).rejects.toThrow(/PERMISSION_DENIED/u);
    const receipt = (await rpc('service_catalog_video_r2_set_preference', [
      OWNER,
      cat,
      true
    ])) as Record<string, unknown>;
    expect(receipt).toMatchObject({ enabled: true, revision: 1 });
    const again = (await rpc('service_catalog_video_r2_set_preference', [
      OWNER,
      cat,
      false
    ])) as Record<string, unknown>;
    expect(again).toMatchObject({ enabled: false, revision: 2 });
    const signal = await db.asUser<{ enabled: boolean; link_kind: string; revision: number }>(
      VIEWER,
      'select enabled,link_kind,revision from public.team_catalog_video_r2_signals where catalog_material_id=$1',
      [cat]
    );
    expect(signal[0]).toMatchObject({ enabled: false, link_kind: 'drive' });
    await asRole('authenticated', async () => {
      expect(
        await db.asUser(
          OUTSIDER,
          'select 1 from public.team_catalog_video_r2_signals where catalog_material_id=$1',
          [cat]
        )
      ).toEqual([]);
      expect(
        await db.asUser(
          VIEWER,
          'select enabled from public.team_catalog_video_r2_signals where catalog_material_id=$1',
          [cat]
        )
      ).toEqual([{ enabled: false }]);
      await expect(
        db.asUser(
          OWNER,
          'update public.team_catalog_video_r2_signals set enabled=true where catalog_material_id=$1',
          [cat]
        )
      ).rejects.toThrow(/permission denied/iu);
    });
    const journal = await db.root<{ actor_id: string; stage: string; code: string | null }>(
      "select actor_id,stage,code from private.catalog_video_r2_journal where catalog_material_id=$1 and stage='configured' order by seq",
      [cat]
    );
    expect(journal.map(row => [row.actor_id, row.code])).toEqual([
      [OWNER, null],
      [OWNER, 'VIDEO_R2_DISABLED']
    ]);
    const state = (await rpc('service_catalog_video_r2_state', [VIEWER, cat])) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({ enabled: false, link: 'drive', copy: null, canManage: false });
    await expect(rpc('service_catalog_video_r2_state', [OUTSIDER, cat])).rejects.toThrow(
      /PERMISSION_DENIED/u
    );
  });

  it('resolves to Drive without the option and plans one idempotent copy with it', async () => {
    const video = await material('video', 'video/mp4', 10_000_000);
    const cat = await catalog(video);
    expect(
      await rpc('service_catalog_video_r2_resolve', [
        cat,
        video,
        'strict-v1:aaaa',
        10_000_000,
        'video/mp4',
        null
      ])
    ).toEqual({ enabled: false });
    expect(
      await db.root('select 1 from private.catalog_video_r2_copies where source_material_id=$1', [
        video
      ])
    ).toEqual([]);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat, true]);
    const first = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:aaaa',
      10_000_000,
      'video/mp4',
      'B'.repeat(32)
    ])) as Record<string, unknown>;
    expect(first).toMatchObject({ enabled: true, url: null, state: 'planned' });
    const second = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:aaaa',
      10_000_000,
      'video/mp4',
      null
    ])) as Record<string, unknown>;
    expect(second.copyId).toBe(first.copyId);
    expect(
      await db.root(
        'select count(*)::int n from private.catalog_video_r2_copies where source_material_id=$1',
        [video]
      )
    ).toEqual([{ n: 1 }]);
    const unsupported = await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:mov',
      10_000_000,
      'video/quicktime',
      null
    ]);
    expect(unsupported).toMatchObject({
      enabled: true,
      url: null,
      reason: 'VIDEO_R2_UNSUPPORTED_FORMAT'
    });
    const tooLarge = await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:big',
      3 * 1024 * 1024 * 1024,
      'video/mp4',
      null
    ]);
    expect(tooLarge).toMatchObject({ reason: 'TOO_LARGE' });
    await db.root('update private.catalog_video_r2_config set team_quota_bytes=15000000');
    const quota = await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:quota',
      10_000_000,
      'video/mp4',
      null
    ]);
    expect(quota).toMatchObject({ reason: 'VIDEO_R2_QUOTA_EXCEEDED' });
    await db.root('update private.catalog_video_r2_config set team_quota_bytes=53687091200');
    const signal = await db.root<{ reason: string | null; copy_state: string | null }>(
      'select reason,copy_state from public.team_catalog_video_r2_signals where catalog_material_id=$1',
      [cat]
    );
    expect(signal[0]).toEqual({ reason: 'VIDEO_R2_QUOTA_EXCEEDED', copy_state: 'planned' });
  });

  it('drives a copy through the worker states under a fenced lease and then resolves to R2', async () => {
    const video = await material('video', 'video/mp4', 10_000_000);
    const cat = await catalog(video);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat, true]);
    const planned = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:lease',
      10_000_000,
      'video/mp4',
      null
    ])) as { copyId: string };
    await park(planned.copyId);
    const claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<
      string,
      unknown
    >;
    expect(claim).toMatchObject({
      copyId: planned.copyId,
      state: 'planned',
      sizeBytes: 10_000_000,
      partBytes: 16_777_216,
      publicOrigin: 'https://videos.test',
      fileId: expect.stringMatching(/^file-/u),
      catalogMaterialId: cat,
      parts: []
    });
    expect(await rpc('service_catalog_video_r2_claim', [WORKER])).toBeNull();
    const fence = claim.fence as number;
    await expect(
      rpc('service_catalog_video_r2_begin_upload', [planned.copyId, 'other-worker-00', fence, 'u'])
    ).rejects.toThrow(/LEASE_MISMATCH/u);
    await expect(
      rpc('service_catalog_video_r2_begin_upload', [planned.copyId, WORKER, fence + 1, 'u'])
    ).rejects.toThrow(/LEASE_MISMATCH/u);
    expect(await rpc('service_catalog_video_r2_renew', [planned.copyId, WORKER, fence])).toBe(true);
    await rpc('service_catalog_video_r2_begin_upload', [
      planned.copyId,
      WORKER,
      fence,
      'upload-lease'
    ]);
    await rpc('service_catalog_video_r2_part', [
      planned.copyId,
      WORKER,
      fence,
      1,
      4_000_000,
      'd'.repeat(64),
      '"e1"',
      'readback',
      null
    ]);
    await expect(
      rpc('service_catalog_video_r2_verifying', [planned.copyId, WORKER, fence])
    ).rejects.toThrow(/VIDEO_R2_CHECKSUM_MISMATCH/u);
    await rpc('service_catalog_video_r2_part', [
      planned.copyId,
      WORKER,
      fence,
      2,
      6_000_000,
      'e'.repeat(64),
      '"e2"',
      'provider_checksum',
      900
    ]);
    await rpc('service_catalog_video_r2_part', [
      planned.copyId,
      WORKER,
      fence,
      2,
      6_000_000,
      'f'.repeat(64),
      '"e2b"',
      'readback',
      900
    ]);
    await rpc('service_catalog_video_r2_verifying', [planned.copyId, WORKER, fence]);
    expect(
      (
        (await rpc('service_catalog_video_r2_resolve', [
          cat,
          video,
          'strict-v1:lease',
          10_000_000,
          'video/mp4',
          null
        ])) as Record<string, unknown>
      ).state
    ).toBe('verifying');
    await rpc('service_catalog_video_r2_ready', [planned.copyId, WORKER, fence, false, 5000]);
    const resolved = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:lease',
      10_000_000,
      'video/mp4',
      null
    ])) as Record<string, unknown>;
    expect(resolved).toMatchObject({ enabled: true, copyId: planned.copyId, state: 'ready' });
    expect(resolved.url).toMatch(/^https:\/\/videos\.test\/v\/[0-9a-f]{32}\.mp4$/u);
    const parts = await db.root<{ part_number: number; verified_by: string; sha256: string }>(
      'select part_number,verified_by,sha256 from private.catalog_video_r2_parts where copy_id=$1 order by part_number',
      [planned.copyId]
    );
    expect(parts).toEqual([
      { part_number: 1, verified_by: 'readback', sha256: 'd'.repeat(64) },
      { part_number: 2, verified_by: 'readback', sha256: 'f'.repeat(64) }
    ]);
    const stages = await db.root<{
      stage: string;
      part_verification: string | null;
      full_hash_verified: boolean | null;
      link_kind: string | null;
    }>(
      'select stage,part_verification,full_hash_verified,link_kind from private.catalog_video_r2_journal where copy_id=$1 order by seq',
      [planned.copyId]
    );
    expect(stages.map(row => row.stage)).toEqual([
      'planned',
      'uploading',
      'part_verified',
      'part_verified',
      'part_verified',
      'verifying',
      'ready'
    ]);
    expect(stages.at(-1)).toMatchObject({ full_hash_verified: false, link_kind: 'r2' });
    const state = (await rpc('service_catalog_video_r2_state', [OWNER, cat])) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      enabled: true,
      link: 'drive',
      copy: { state: 'ready', fullHashVerified: false }
    });
    expect(state.usedBytes as number).toBeGreaterThanOrEqual(10_000_000);
  });

  it('fails a copy after a transient release backoff and a terminal release tombstones it', async () => {
    const video = await material('video', 'video/mp4', 5_000_000);
    const cat = await catalog(video);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat, true]);
    const planned = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:fail',
      5_000_000,
      'video/mp4',
      null
    ])) as { copyId: string };
    await park(planned.copyId);
    let claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<string, unknown>;
    await rpc('service_catalog_video_r2_release', [
      planned.copyId,
      WORKER,
      claim.fence,
      'VIDEO_R2_PROVIDER_UNAVAILABLE',
      false
    ]);
    expect(await rpc('service_catalog_video_r2_claim', [WORKER])).toBeNull();
    expect(
      (
        (await rpc('service_catalog_video_r2_resolve', [
          cat,
          video,
          'strict-v1:fail',
          5_000_000,
          'video/mp4',
          null
        ])) as Record<string, unknown>
      ).reason
    ).toBe('VIDEO_R2_PROVIDER_UNAVAILABLE');
    await db.root(
      'update private.catalog_video_r2_copies set next_attempt_at=clock_timestamp() where id=$1',
      [planned.copyId]
    );
    claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<string, unknown>;
    await rpc('service_catalog_video_r2_begin_upload', [
      planned.copyId,
      WORKER,
      claim.fence,
      'upload-fail'
    ]);
    await rpc('service_catalog_video_r2_release', [
      planned.copyId,
      WORKER,
      claim.fence,
      'SOURCE_CHANGED',
      true
    ]);
    const copy = await db.root<{ state: string; last_error: string }>(
      'select state,last_error from private.catalog_video_r2_copies where id=$1',
      [planned.copyId]
    );
    expect(copy[0]).toEqual({ state: 'failed', last_error: 'SOURCE_CHANGED' });
    const tombstone = await db.root<{ reason: string; upload_id: string }>(
      'select reason,upload_id from private.catalog_video_r2_purges where copy_ref=$1',
      [planned.copyId]
    );
    expect(tombstone[0]).toEqual({ reason: 'failed_upload', upload_id: 'upload-fail' });
    const replanned = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:fail',
      5_000_000,
      'video/mp4',
      null
    ])) as { copyId: string; state: string };
    expect(replanned.state).toBe('planned');
    expect(replanned.copyId).not.toBe(planned.copyId);
  });

  it('set-replaces uses on confirm, retires the previous version and revives a retiring copy', async () => {
    const video = await material('video', 'video/mp4', 10_000_000);
    const cat = await catalog(video);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat, true]);
    const a = await readyCopy(cat, video, 'strict-v1:va');
    await rpc('service_catalog_video_r2_confirm_use', [
      cat,
      'r2',
      JSON.stringify([{ sourceMaterialId: video, copyId: a }])
    ]);
    expect(
      await db.root(
        'select copy_id from private.catalog_video_r2_uses where catalog_material_id=$1',
        [cat]
      )
    ).toEqual([{ copy_id: a }]);
    const signalA = await db.root<{ link_kind: string; last_successful_update_at: string | null }>(
      'select link_kind,last_successful_update_at from public.team_catalog_video_r2_signals where catalog_material_id=$1',
      [cat]
    );
    expect(signalA[0]!.link_kind).toBe('r2');
    expect(signalA[0]!.last_successful_update_at).not.toBeNull();
    const b = await readyCopy(cat, video, 'strict-v1:vb');
    await rpc('service_catalog_video_r2_confirm_use', [
      cat,
      'r2',
      JSON.stringify([{ sourceMaterialId: video, copyId: b }])
    ]);
    const afterB = await db.root<{ id: string; state: string; retire_reason: string | null }>(
      'select id,state,retire_reason from private.catalog_video_r2_copies where id in ($1,$2) order by created_at',
      [a, b]
    );
    expect(afterB).toEqual([
      { id: a, state: 'retiring', retire_reason: 'replaced' },
      { id: b, state: 'ready', retire_reason: null }
    ]);
    expect(await rpc('service_catalog_video_r2_claim_retire', [WORKER])).toBeNull();
    const revived = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:va',
      10_000_000,
      'video/mp4',
      null
    ])) as Record<string, unknown>;
    expect(revived).toMatchObject({ copyId: a, state: 'ready' });
    await rpc('service_catalog_video_r2_confirm_use', [
      cat,
      'r2',
      JSON.stringify([{ sourceMaterialId: video, copyId: a }])
    ]);
    expect(
      await db.root<{ state: string }>(
        'select state from private.catalog_video_r2_copies where id=$1',
        [b]
      )
    ).toEqual([{ state: 'retiring' }]);
    await rpc('service_catalog_video_r2_confirm_use', [cat, 'drive', '[]']);
    expect(
      await db.root('select 1 from private.catalog_video_r2_uses where catalog_material_id=$1', [
        cat
      ])
    ).toEqual([]);
    expect(
      await db.root<{ state: string; retire_reason: string }>(
        'select state,retire_reason from private.catalog_video_r2_copies where id=$1',
        [a]
      )
    ).toEqual([{ state: 'retiring', retire_reason: 'disabled' }]);
    await expect(
      rpc('service_catalog_video_r2_confirm_use', [
        cat,
        'r2',
        JSON.stringify([
          { sourceMaterialId: video, copyId: '50000000-0000-4000-8000-0000000000ff' }
        ])
      ])
    ).rejects.toThrow(/VIDEO_R2_CATALOG_WRITE_FAILED/u);
  });

  it('deletes retired copies after the window, purges tombstones and keeps shared copies alive', async () => {
    const video = await material('video', 'video/mp4', 10_000_000);
    const cat1 = await catalog(video);
    const cat2 = await catalog(video);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat1, true]);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat2, true]);
    const shared = await readyCopy(cat1, video, 'strict-v1:shared');
    await rpc('service_catalog_video_r2_confirm_use', [
      cat1,
      'r2',
      JSON.stringify([{ sourceMaterialId: video, copyId: shared }])
    ]);
    await rpc('service_catalog_video_r2_confirm_use', [
      cat2,
      'r2',
      JSON.stringify([{ sourceMaterialId: video, copyId: shared }])
    ]);
    await rpc('service_catalog_video_r2_confirm_use', [cat1, 'drive', '[]']);
    expect(
      await db.root<{ state: string }>(
        'select state from private.catalog_video_r2_copies where id=$1',
        [shared]
      )
    ).toEqual([{ state: 'ready' }]);
    await rpc('service_catalog_video_r2_confirm_use', [cat2, 'drive', '[]']);
    expect(
      await db.root<{ state: string }>(
        'select state from private.catalog_video_r2_copies where id=$1',
        [shared]
      )
    ).toEqual([{ state: 'retiring' }]);
    expect(await rpc('service_catalog_video_r2_claim_retire', [WORKER])).toBeNull();
    await db.root(
      "update private.catalog_video_r2_copies set retire_after=clock_timestamp()-interval '1 minute' where id=$1",
      [shared]
    );
    const retire = (await rpc('service_catalog_video_r2_claim_retire', [WORKER])) as Record<
      string,
      unknown
    >;
    expect(retire).toMatchObject({
      copyId: shared,
      reason: 'disabled',
      publicOrigin: 'https://videos.test'
    });
    await rpc('service_catalog_video_r2_mark_deleted', [
      shared,
      WORKER,
      retire.fence,
      false,
      'VIDEO_R2_PROVIDER_UNAVAILABLE'
    ]);
    expect(await rpc('service_catalog_video_r2_claim_retire', [WORKER])).toBeNull();
    await db.root(
      'update private.catalog_video_r2_copies set next_attempt_at=clock_timestamp() where id=$1',
      [shared]
    );
    const again = (await rpc('service_catalog_video_r2_claim_retire', [WORKER])) as Record<
      string,
      unknown
    >;
    await rpc('service_catalog_video_r2_mark_deleted', [shared, WORKER, again.fence, true, null]);
    expect(
      await db.root<{ state: string }>(
        'select state from private.catalog_video_r2_copies where id=$1',
        [shared]
      )
    ).toEqual([{ state: 'deleted' }]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_purges where copy_ref=$1', [shared])
    ).toEqual([]);
    const orphan = await readyCopy(cat1, video, 'strict-v1:orphan');
    expect(await rpc('service_catalog_video_r2_retire_orphans', [])).toBe(0);
    await db.root(
      "update private.catalog_video_r2_copies set ready_at=clock_timestamp()-interval '7 hours' where id=$1",
      [orphan]
    );
    expect(await rpc('service_catalog_video_r2_retire_orphans', [])).toBe(1);
    expect(
      await db.root<{ state: string }>(
        'select state from private.catalog_video_r2_copies where id=$1',
        [orphan]
      )
    ).toEqual([{ state: 'retiring' }]);
  });

  it('keeps copies through trash, loses them only on real deletion, and tombstones survive every cascade', async () => {
    const video = await material('video', 'video/mp4', 10_000_000);
    const cat = await catalog(video);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat, true]);
    const copy = await readyCopy(cat, video, 'strict-v1:life');
    await rpc('service_catalog_video_r2_confirm_use', [
      cat,
      'r2',
      JSON.stringify([{ sourceMaterialId: video, copyId: copy }])
    ]);
    await db.root(
      "update public.team_materials set trashed_at=clock_timestamp(),lifecycle='trashed' where id=$1",
      [cat]
    );
    await db.root(
      "update public.team_materials set trashed_at=null,lifecycle='active' where id=$1",
      [cat]
    );
    expect(
      await db.root<{ state: string }>(
        'select state from private.catalog_video_r2_copies where id=$1',
        [copy]
      )
    ).toEqual([{ state: 'ready' }]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_uses where copy_id=$1', [copy])
    ).toHaveLength(1);
    await db.root('delete from public.team_materials where id=$1', [cat]);
    expect(
      await db.root<{ state: string; retire_reason: string }>(
        'select state,retire_reason from private.catalog_video_r2_copies where id=$1',
        [copy]
      )
    ).toEqual([{ state: 'retiring', retire_reason: 'catalog_deleted' }]);
    await db.root('delete from public.team_materials where id=$1', [video]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_copies where id=$1', [copy])
    ).toEqual([]);
    expect(
      await db.root<{ reason: string }>(
        'select reason from private.catalog_video_r2_purges where copy_ref=$1',
        [copy]
      )
    ).toEqual([{ reason: 'catalog_deleted' }]);
    await db.root(
      "update private.catalog_video_r2_purges set next_attempt_at=clock_timestamp()+interval '1 day' where copy_ref is distinct from $1 and purged_at is null",
      [copy]
    );
    const purge = (await rpc('service_catalog_video_r2_claim_purge', [WORKER])) as Record<
      string,
      unknown
    >;
    expect(purge).toMatchObject({ copyRef: copy, publicOrigin: 'https://videos.test' });
    await rpc('service_catalog_video_r2_mark_purged', [purge.id, purge.fence, true, null]);
    expect(
      await db.root<{ purged: boolean }>(
        'select purged_at is not null purged from private.catalog_video_r2_purges where id=$1',
        [purge.id]
      )
    ).toEqual([{ purged: true }]);
  });

  it('tombstones every live object when the space is deleted', async () => {
    const owner2 = '50000000-0000-4000-8000-000000000021';
    await createUser(db, { id: owner2, email: 'video-r2-owner2@example.test' });
    await db.root('insert into public.admin_users(user_id) values($1)', [owner2]);
    const team2 = (
      await db.asUser<{ id: string }>(
        owner2,
        "select id from public.create_team('R2 videos delete')"
      )
    )[0]!.id;
    const credential = (
      await db.root<{ id: string }>(
        "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2-2','video-r2-2@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
        [owner2]
      )
    )[0]!.id;
    const connection2 = (
      await db.root<{ id: string }>(
        "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'synthetic-root','Synthetic','my_drive','connected') returning id",
        [team2, credential]
      )
    )[0]!.id;
    const video = (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes) values($1,$2,'file-t2','synthetic-root','v','file','video','video/mp4',1000) returning id",
        [team2, connection2]
      )
    )[0]!.id;
    const cat = (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values($1,$2,'sheet-t2','synthetic-root','c','file','other','application/vnd.google-apps.spreadsheet') returning id",
        [team2, connection2]
      )
    )[0]!.id;
    await db.root(
      "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://drive.google.com/file/d/x/view?usp=sharing','{}',$4,1)",
      [cat, team2, video, owner2]
    );
    await rpc('service_catalog_video_r2_set_preference', [owner2, cat, true]);
    const planned = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:t2',
      1000,
      'video/mp4',
      null
    ])) as { copyId: string };
    await park(planned.copyId);
    const claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<
      string,
      unknown
    >;
    await rpc('service_catalog_video_r2_begin_upload', [
      planned.copyId,
      WORKER,
      claim.fence,
      'upload-t2'
    ]);
    await db.root('delete from public.teams where id=$1', [team2]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_copies where team_id=$1', [team2])
    ).toEqual([]);
    expect(
      await db.root('select 1 from private.catalog_video_r2_preferences where team_id=$1', [team2])
    ).toEqual([]);
    const tombstones = await db.root<{ reason: string; upload_id: string | null }>(
      'select reason,upload_id from private.catalog_video_r2_purges where team_ref=$1',
      [team2]
    );
    expect(tombstones).toEqual([{ reason: 'team_deleted', upload_id: 'upload-t2' }]);
  });

  it('resolves for a publication job, in pre-creation team scope, and by stored identity for the legacy updater', async () => {
    const video = await material('video', 'video/mp4', 10_000_000);
    const cat = await catalog(video);
    const preCreation = (await rpc('service_catalog_video_r2_resolve', [
      null,
      video,
      'strict-v1:pre',
      10_000_000,
      'video/mp4',
      null,
      null,
      team,
      true
    ])) as Record<string, unknown>;
    expect(preCreation).toMatchObject({ enabled: true, url: null, state: 'planned' });
    expect(
      await rpc('service_catalog_video_r2_resolve', [
        null,
        video,
        'strict-v1:pre',
        10_000_000,
        'video/mp4',
        null,
        null,
        team,
        false
      ])
    ).toEqual({ enabled: false });
    expect(
      await db.root(
        'select requested_by_catalog r from private.catalog_video_r2_copies where id=$1',
        [preCreation.copyId]
      )
    ).toEqual([{ r: null }]);
    await rpc('service_catalog_video_r2_set_preference', [OWNER, cat, true]);
    const adopted = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:pre',
      10_000_000,
      'video/mp4',
      null
    ])) as Record<string, unknown>;
    expect(adopted.copyId).toBe(preCreation.copyId);
    expect(
      await db.root(
        'select requested_by_catalog r from private.catalog_video_r2_copies where id=$1',
        [preCreation.copyId]
      )
    ).toEqual([{ r: cat }]);
    await expect(
      rpc('service_catalog_video_r2_resolve', [
        null,
        video,
        'strict-v1:pre',
        10_000_000,
        'video/mp4',
        null,
        '50000000-0000-4000-8000-0000000000aa'
      ])
    ).resolves.toEqual({ enabled: false });
    const current = (await rpc('service_catalog_video_r2_resolve_current', [cat, null])) as Record<
      string,
      unknown
    >;
    expect(current).toMatchObject({
      enabled: true,
      url: null,
      state: 'planned',
      sourceMaterialId: video
    });
    expect(current.sourceVersion).toMatch(/^content-v1:[0-9a-f]+$/u);
    const again = (await rpc('service_catalog_video_r2_resolve_current', [cat, null])) as Record<
      string,
      unknown
    >;
    expect(again.copyId).toBe(current.copyId);
    await db.root('update public.team_materials set checksum=null,drive_version=null where id=$1', [
      video
    ]);
    expect(await rpc('service_catalog_video_r2_resolve_current', [cat, null])).toMatchObject({
      reason: 'VIDEO_R2_SOURCE_UNAVAILABLE'
    });
    await db.root('update public.team_materials set drive_version=$2 where id=$1', [
      video,
      'rev-7'
    ]);
    expect(
      (
        (await rpc('service_catalog_video_r2_resolve_current', [cat, null])) as Record<
          string,
          unknown
        >
      ).sourceVersion
    ).toMatch(/^strict-v1:/u);
    const ready = await readyCopy(cat, video, 'strict-v1:byversion');
    await rpc('service_catalog_video_r2_confirm_use', [
      cat,
      'r2',
      JSON.stringify([{ sourceMaterialId: video, sourceVersion: 'strict-v1:byversion' }])
    ]);
    expect(
      await db.root(
        'select copy_id from private.catalog_video_r2_uses where catalog_material_id=$1',
        [cat]
      )
    ).toEqual([{ copy_id: ready }]);
    await expect(
      rpc('service_catalog_video_r2_confirm_use', [
        cat,
        'r2',
        JSON.stringify([{ sourceMaterialId: video, sourceVersion: 'strict-v1:nope' }])
      ])
    ).rejects.toThrow(/VIDEO_R2_CATALOG_WRITE_FAILED/u);
    const planned = (await rpc('service_catalog_video_r2_resolve', [
      cat,
      video,
      'strict-v1:yield',
      10_000_000,
      'video/mp4',
      null
    ])) as { copyId: string };
    await park(planned.copyId);
    const claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<
      string,
      unknown
    >;
    await rpc('service_catalog_video_r2_yield', [planned.copyId, WORKER, claim.fence]);
    expect(
      await db.root<{ lease_owner: string | null; last_error: string | null }>(
        'select lease_owner,last_error from private.catalog_video_r2_copies where id=$1',
        [planned.copyId]
      )
    ).toEqual([{ lease_owner: null, last_error: null }]);
    expect(
      ((await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<string, unknown>).copyId
    ).toBe(planned.copyId);
  });

  it('derives the worker endpoint from the existing catalog-sync vault entry and replaced the receipt RPC with a default', async () => {
    expect(
      await db.root<{ e: string | null }>('select private.catalog_video_r2_worker_endpoint() e')
    ).toEqual([{ e: null }]);
    await db.root(
      "select vault.create_secret('https://project.supabase.co/functions/v1/catalog-sync','wishly_catalog_sync_url','')"
    );
    expect(
      await db.root<{ e: string | null }>('select private.catalog_video_r2_worker_endpoint() e')
    ).toEqual([{ e: 'https://project.supabase.co/functions/v1/catalog-video-r2/worker' }]);
    const signatures = await db.root<{ args: string }>(
      "select pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='service_record_catalog_publication_link'"
    );
    expect(signatures).toEqual([
      {
        args: 'p_job uuid, p_worker uuid, p_material uuid, p_source_version text, p_url text, p_link_kind text'
      }
    ]);
    const defaults = await db.root<{ d: string }>(
      "select pg_get_function_arguments(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='service_record_catalog_publication_link'"
    );
    expect(defaults[0]!.d).toContain("p_link_kind text DEFAULT 'drive'");
    const receipt = await db.root<{ ok: boolean }>(
      "select exists(select 1 from information_schema.columns where table_schema='private' and table_name='catalog_publication_link_receipts' and column_name='link_kind') ok"
    );
    expect(receipt[0]!.ok).toBe(true);
  });
});
