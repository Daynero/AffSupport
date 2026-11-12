import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3 beta click-test (2026-11-11) races and loops in catalog creation:
 * a recovery failure before the paced claim relisted an intent forever (260000),
 * restitch creation's first POST hit SOURCE_CHANGED on a metadata-only Drive
 * version drift (261000), a launch kept LEASE_MISMATCH after succeeding (262000),
 * canceled creations consumed variant numbers so the preview lied (263000), and a
 * ready video set waited out the intent backoff before assembling (264000).
 */
let db: TeamTestDb, team: string, connection: string;
const owner = '79000000-0000-4000-8000-000000000001';
const checksum = 'c'.repeat(32);
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'create-races@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Races')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('races','races@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
}, 180_000);
afterAll(async () => {
  await db?.close();
});

let seq = 0;
const video = async () => {
  const n = ++seq;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum,size_bytes) values($1,$2,$3,$3,'file','video','video/mp4','v1',$4,11) returning id",
      [team, connection, 'races-video-' + n, checksum]
    )
  )[0]!.id;
};
const intent = async (
  source: string,
  state: string,
  extra: { variant?: number; next?: string; lease?: string } = {}
) => {
  const id = crypto.randomUUID(),
    key = 'product-catalog:' + crypto.randomUUID();
  await db.root(
    `insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint,next_attempt_at,lease_expires_at)
     values($1,$2,$3,$4,$5,'digest',$6::jsonb,$7,$8,'{}'::jsonb,${extra.next ?? 'clock_timestamp()'},${extra.lease ?? 'null'})`,
    [
      id,
      team,
      source,
      owner,
      key,
      JSON.stringify({ catalogVideoProtocolVersion: 1, restitchEnabled: false }),
      extra.variant ?? ++seq,
      state
    ]
  );
  return { id, key };
};
const defer = (key: string, code = 'INVALID_INPUT') =>
  db.root<{ value: string }>(
    'select public.service_defer_initial_catalog_recovery($1,$2,$3,$4) value',
    [team, owner, key, code]
  );

it('spends one paced attempt for a registered intent whose recovery failed before the claim', async () => {
  const { id, key } = await intent(await video(), 'registered');
  expect((await defer(key))[0]!.value).toBe('deferred');
  const row = (
    await db.root<{ attempts: number; paced: boolean; last_code: string }>(
      'select attempts,retry_after>clock_timestamp() paced,last_code from private.catalog_initial_publication_reverify where intent_id=$1',
      [id]
    )
  )[0]!;
  expect(row).toEqual({ attempts: 1, paced: true, last_code: 'INVALID_INPUT' });
  await db.root(
    'update private.catalog_initial_publication_reverify set attempts=11 where intent_id=$1',
    [id]
  );
  expect((await defer(key))[0]!.value).toBe('exhausted');
  expect((await defer(key))[0]!.value).toBe('exhausted');
});

it('pushes a due unfinished intent five minutes out but never one with a live lease', async () => {
  const due = await intent(await video(), 'interrupted');
  expect((await defer(due.key))[0]!.value).toBe('deferred');
  expect(
    (
      await db.root<{ later: boolean }>(
        "select next_attempt_at>clock_timestamp()+interval '4 minutes' later from private.catalog_generation_intents where id=$1",
        [due.id]
      )
    )[0]!.later
  ).toBe(true);
  const leased = await intent(await video(), 'interrupted', {
    lease: "clock_timestamp()+interval '2 minutes'"
  });
  expect((await defer(leased.key))[0]!.value).toBe('unchanged');
});

it('production loop: a just-failed intent is pushed out, and one failing for a day is parked', async () => {
  // A failed resume leaves next_attempt_at thirty seconds ahead; the deferral used to answer
  // 'unchanged' and the pass retried the intent every minute, 1200 times (2026-11-12).
  const fresh = await intent(await video(), 'interrupted', {
    next: "clock_timestamp()+interval '30 seconds'"
  });
  expect((await defer(fresh.key, 'WRONG_STATE'))[0]!.value).toBe('deferred');
  expect(
    (
      await db.root<{ later: boolean }>(
        "select next_attempt_at>clock_timestamp()+interval '4 minutes' later from private.catalog_generation_intents where id=$1",
        [fresh.id]
      )
    )[0]!.later
  ).toBe(true);
  const old = await intent(await video(), 'interrupted', {
    next: "clock_timestamp()+interval '30 seconds'"
  });
  await db.root(
    "update private.catalog_generation_intents set created_at=clock_timestamp()-interval '2 days' where id=$1",
    [old.id]
  );
  expect((await defer(old.key, 'WRONG_STATE'))[0]!.value).toBe('parked');
  expect(
    (
      await db.root<{ parked: boolean }>(
        "select next_attempt_at='infinity'::timestamptz parked from private.catalog_generation_intents where id=$1",
        [old.id]
      )
    )[0]!.parked
  ).toBe(true);
});

it('accepts a restitch source version drift only when the bytes are unchanged', async () => {
  const source = await video();
  const fileId = (
    await db.root<{ f: string }>('select drive_file_id f from public.team_materials where id=$1', [
      source
    ])
  )[0]!.f;
  // Sharing advanced the Drive version; the sync stored it.
  await db.root("update public.team_materials set drive_version='v2' where id=$1", [source]);
  const capture = (observedChecksum: string, version = 'v3') =>
    db.root<{ value: { version: string } }>(
      'select public.service_capture_catalog_video_source($1,$2,$3,$4,$5,$6,$7::jsonb) value',
      [
        source,
        team,
        owner,
        connection,
        fileId,
        'v1',
        JSON.stringify({
          fileId,
          version,
          checksum: observedChecksum,
          sizeBytes: 11,
          mimeType: 'video/mp4'
        })
      ]
    );
  await expect(capture('d'.repeat(32))).rejects.toThrow('SOURCE_CHANGED');
  expect((await capture(checksum))[0]!.value.version).toBe('v3');
});

it('refreshes a stale material row from the live observation instead of failing', async () => {
  const source = await video();
  const fileId = 'races-video-' + seq;
  const value = (
    await db.root<{ value: { version: string } }>(
      'select public.service_capture_catalog_video_source($1,$2,$3,$4,$5,$6,$7::jsonb) value',
      [
        source,
        team,
        owner,
        connection,
        fileId,
        'v1',
        JSON.stringify({
          fileId,
          version: 'v2',
          checksum: checksum.toUpperCase(),
          sizeBytes: 11,
          mimeType: 'video/mp4'
        })
      ]
    )
  )[0]!.value;
  expect(value.version).toBe('v2');
  expect(
    (
      await db.root<{ drive_version: string; checksum: string }>(
        'select drive_version,checksum from public.team_materials where id=$1',
        [source]
      )
    )[0]
  ).toEqual({ drive_version: 'v2', checksum });
});

it('clears a stale lease error and settles running steps when a launch is published', async () => {
  const source = (
    await db.root<{ d: string }>(
      "select pg_get_functiondef('public.service_publish_launch_generation(uuid,uuid,uuid,text)'::regprocedure) d"
    )
  )[0]!.d;
  expect(source).toContain(
    "state='succeeded',stage='result_committed',safe_error_code=null,state_version=state_version+1"
  );
  expect(source).toContain(
    "update public.team_launch_generation_steps set state='succeeded',updated_at=clock_timestamp() where generation_id=g.id and state='running';"
  );
});

it('gives a canceled creation number back so the preview equals the created name', async () => {
  const source = await video();
  const next = async () =>
    (
      await db.root<{ n: number }>('select public.service_next_product_catalog_variant($1,$2) n', [
        team,
        source
      ])
    )[0]!.n;
  await intent(source, 'canceled', { variant: 1 });
  await intent(source, 'canceled', { variant: 2 });
  expect(await next()).toBe(1);
  const begun = (
    await db.root<{ value: { variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5::jsonb,$6) value',
      [team, source, owner, 'product-catalog:' + crypto.randomUUID(), '{}', crypto.randomUUID()]
    )
  )[0]!.value;
  expect(begun.variant).toBe(1);
  // A live creation keeps its number reserved for the preview and the next begin.
  expect(await next()).toBe(2);
});

it('makes the creation due at once when its video set becomes ready', async () => {
  const source = await video();
  const { id } = await intent(source, 'interrupted', {
    next: "clock_timestamp()+interval '2 minutes'"
  });
  const set = crypto.randomUUID();
  await db.root(
    "insert into private.catalog_video_sets(id,team_id,actor_id,catalog_intent_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version) values($1,$2,$3,$4,$5,'v1',$6::jsonb,repeat('a',64),1,3,1,repeat('b',64),1)",
    [
      set,
      team,
      owner,
      id,
      source,
      JSON.stringify({ configured: true, operation: 'restitch', sourceMode: 'legacy' })
    ]
  );
  const due = async () =>
    (
      await db.root<{ due: boolean }>(
        'select next_attempt_at<=clock_timestamp() due from private.catalog_generation_intents where id=$1',
        [id]
      )
    )[0]!.due;
  expect(await due()).toBe(false);
  await db.root("update private.catalog_video_sets set state='ready' where id=$1", [set]);
  expect(await due()).toBe(true);
});
