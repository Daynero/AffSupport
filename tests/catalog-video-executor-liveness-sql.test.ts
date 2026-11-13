import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';
import { expireBackoff, poisonRows, settleFailure } from './support/poison-rows';

/**
 * 1.4.3 (beta 2026-11-11): a restitch whose agent died hung until the 12-hour
 * abandonment rule, the restarted agent could not take its set over, and
 * cancelled sets stayed 'cancel_requested' forever. The server now records the
 * agent's 30-second variant heartbeat and decides on silence instead of age.
 */
let db: TeamTestDb, team: string, source: string, delegation: string;
const owner = 'c2400000-0000-4000-8000-000000000001',
  executor = 'c2400000-0000-4000-8000-000000000002',
  native = 'c2400000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xac);
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207240000_catalog_video_executor_liveness.sql'
  });
  await createUser(db, { id: owner, email: 'variant-liveness@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Live')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'live','live@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','Source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  delegation = (
    await db.root<{ id: string }>(
      'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,$3,$4)returning id',
      [team, owner, executor, Buffer.alloc(32, 0xbd)]
    )
  )[0]!.id;
  await db.root(
    "insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)values($1,$2,1,'claim',clock_timestamp()+interval '1 hour')",
    [hash, delegation]
  );
}, 240000);
afterAll(async () => {
  await db?.close();
});

const revisionOf = async (set: string) =>
  Number(
    (
      await db.root<{ revision: string }>(
        'select revision from private.catalog_video_sets where id=$1',
        [set]
      )
    )[0]!.revision
  );
const variant = async (set: string) =>
  (
    await db.root<{
      state: string;
      operation_id: string | null;
      retry_count: number;
      heartbeat_at: Date | null;
      silence_observed_at: Date | null;
    }>(
      'select state,operation_id,retry_count,heartbeat_at,silence_observed_at from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
      [set]
    )
  )[0]!;
const setState = async (set: string) =>
  (
    await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
      set
    ])
  )[0]!.state;
const operationState = async (op: string) =>
  (
    await db.root<{ state: string; error_code: string | null }>(
      'select state,error_code from public.team_operations where id=$1',
      [op]
    )
  )[0]!;

async function fixture(options: { admit: boolean } = { admit: true }) {
  const set = crypto.randomUUID(),
    request = crypto.randomUUID(),
    key = 'live:' + set;
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, key, {}, executor]
    )
  )[0]!.v.id;
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', [
    team,
    owner,
    executor,
    {
      setId: set,
      catalogIntentId: intent,
      sourceMaterialId: source,
      sourceVersion: '1',
      settings: { configured: true, operation: 'restitch', sourceMode: 'legacy' },
      settingsDigest: 'a'.repeat(64),
      requestedCount: 1,
      productCount: 1,
      recipeRevision: 1,
      seed: 'b'.repeat(64)
    },
    [{ index: 0, requestId: request }],
    [{ recipeRowId: crypto.randomUUID(), videoVariantIndex: 0 }]
  ]);
  // What the creation flow records before it hands the set to the agent.
  await db.root(
    "update private.catalog_generation_intents set checkpoint=checkpoint||jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',$2::text)),request_payload=request_payload||'{\"catalogVideoProtocolVersion\":1}'::jsonb where id=$1",
    [intent, set]
  );
  if (!options.admit) return { set, request, key, op: null as string | null };
  const op = crypto.randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, owner, source, 'catalog-variant:' + request]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    set,
    team,
    owner,
    executor,
    await revisionOf(set),
    [{ index: 0, requestId: request, operationId: op, state: 'working', outputId: null }]
  ]);
  await db.root('select public.service_dispatch_catalog_video_variant($1,$2,$3,1,0,$4,$5)', [
    set,
    hash,
    native,
    request,
    op
  ]);
  return { set, request, key, op: op as string | null };
}
/** The operations table stamps updated_at on every write; age it past that trigger. */
const silence = async (op: string, minutes: number) => {
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      'update public.team_operations set created_at=clock_timestamp()-make_interval(mins=>$2+1),updated_at=clock_timestamp()-make_interval(mins=>$2) where id=$1',
      [op, minutes]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
};
const heartbeat = async (set: string, request: string, op: string | null) =>
  (
    await db.root<{ v: boolean }>(
      'select public.service_note_catalog_video_variant_heartbeat($1,$2,$3,1,0,$4,$5)v',
      [set, hash, native, request, op]
    )
  )[0]!.v;
const cancelRequested = async (set: string) =>
  db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [set]);
const settle = async () =>
  (
    await db.root<{ v: { settled: number; resolved: number } }>(
      'select public.service_settle_catalog_video_cancellations(10)v'
    )
  )[0]!.v;
const release = async (set: string) =>
  (
    await db.root<{ n: number }>(
      "select private.release_silent_catalog_video_variants($1,interval '2 minutes')n",
      [set]
    )
  )[0]!.n;
const resolve = async (set: string) =>
  (
    await db.root<{ v: Record<string, unknown> }>(
      'select private.retry_failed_catalog_video_variant($1,0)v',
      [set]
    )
  )[0]!.v;

it('records the heartbeat of the executor that owns the working variant', async () => {
  const f = await fixture();
  expect(await heartbeat(f.set, f.request, f.op)).toBe(true);
  expect((await variant(f.set)).heartbeat_at).not.toBeNull();
  // Another identity is not this variant's heartbeat.
  expect(await heartbeat(f.set, crypto.randomUUID(), f.op)).toBe(false);
  await expect(
    db.root('select public.service_note_catalog_video_variant_heartbeat($1,$2,$3,1,0,$4,$5)', [
      f.set,
      Buffer.alloc(32, 0x01),
      native,
      f.request,
      f.op
    ])
  ).rejects.toThrow();
});

it('takes over a variant whose agent stopped heartbeating two minutes ago', async () => {
  // Beta 2026-11-11, set 5a2d8619: agent killed mid-run, takeover refused.
  const f = await fixture();
  await silence(f.op!, 3);
  expect(await release(f.set)).toBe(1);
  expect(await operationState(f.op!)).toEqual({
    state: 'failed',
    error_code: 'PROCESS_RESULT_UNCERTAIN'
  });
  expect(await variant(f.set)).toMatchObject({
    state: 'queued',
    operation_id: null,
    retry_count: 1
  });
  expect(await setState(f.set)).toBe('preparing');
});

it('never takes over a variant whose agent is still heartbeating', async () => {
  const f = await fixture();
  await silence(f.op!, 30);
  await heartbeat(f.set, f.request, f.op);
  expect(await release(f.set)).toBe(0);
  expect((await operationState(f.op!)).state).toBe('running');
  expect((await variant(f.set)).state).toBe('working');
});

it('never takes over a variant that may have produced output', async () => {
  const f = await fixture();
  await silence(f.op!, 30);
  await db.root(
    "update private.team_operation_intents set provider_result_id='drive-file' where operation_id=$1",
    [f.op]
  );
  expect(await release(f.set)).toBe(0);
  expect((await operationState(f.op!)).state).toBe('running');
});

it('asks for the takeover when a restarted agent rebinds its set', async () => {
  const body = (
    await db.root<{ d: string }>(
      "select pg_get_functiondef('public.service_redeem_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid,uuid)'::regprocedure)d"
    )
  )[0]!.d;
  const release = body.indexOf("release_silent_catalog_video_variants(s.id,interval '2 minutes')");
  expect(release).toBeGreaterThan(body.indexOf("'REQUEST_REUSE_CONFLICT'"));
  expect(release).toBeLessThan(body.indexOf("'PROCESS_RESULT_UNCERTAIN'"));
});

it('abandons a variant after 15 minutes of silence confirmed by a second look', async () => {
  const f = await fixture();
  await silence(f.op!, 20);
  // First look records the silence and keeps the answer.
  expect(await resolve(f.set)).toEqual({ kind: 'unknown' });
  expect((await variant(f.set)).silence_observed_at).not.toBeNull();
  expect((await operationState(f.op!)).state).toBe('running');
  // An immediate second look is not a confirmation: a database outage looks like silence.
  expect(await resolve(f.set)).toEqual({ kind: 'unknown' });
  await db.root(
    "update private.catalog_video_variants set silence_observed_at=clock_timestamp()-interval '3 minutes' where video_set_id=$1",
    [f.set]
  );
  expect(await resolve(f.set)).toMatchObject({ kind: 'retry', attempt: 1 });
  expect(await operationState(f.op!)).toEqual({
    state: 'failed',
    error_code: 'PROCESS_RESULT_UNCERTAIN'
  });
});

it('forgets an observed silence once the agent answers again', async () => {
  const f = await fixture();
  await silence(f.op!, 20);
  await resolve(f.set);
  await db.root(
    "update private.catalog_video_variants set silence_observed_at=clock_timestamp()-interval '3 minutes' where video_set_id=$1",
    [f.set]
  );
  await heartbeat(f.set, f.request, f.op);
  expect(await resolve(f.set)).toEqual({ kind: 'unknown' });
  expect(await variant(f.set)).toMatchObject({ state: 'working', silence_observed_at: null });
  expect((await operationState(f.op!)).state).toBe('running');
});

it('lets the per-minute settlement resolve an active set whose agent went silent', async () => {
  const f = await fixture();
  await silence(f.op!, 20);
  expect((await settle()).resolved).toBeGreaterThanOrEqual(1);
  expect((await variant(f.set)).silence_observed_at).not.toBeNull();
  expect((await operationState(f.op!)).state).toBe('running');
  await db.root(
    "update private.catalog_video_variants set silence_observed_at=clock_timestamp()-interval '3 minutes' where video_set_id=$1",
    [f.set]
  );
  await settle();
  expect(await variant(f.set)).toMatchObject({ state: 'queued', retry_count: 1 });
  expect((await operationState(f.op!)).state).toBe('failed');
});

it('settles a cancellation whose variant was marked working but never got an operation', async () => {
  // Beta 2026-11-11, sets 564326ac, c8f1f143, 63c5cefd, 6bdf6c71.
  const f = await fixture({ admit: false });
  await db.root("update private.catalog_video_variants set state='working' where video_set_id=$1", [
    f.set
  ]);
  await cancelRequested(f.set);
  // The admission trigger already refuses an operation from here on.
  await expect(
    db.root(
      "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,'process','running',$3,$4,$4)",
      [team, owner, source, 'catalog-variant:' + f.request]
    )
  ).rejects.toThrow('WRONG_STATE');
  await settle();
  expect(await setState(f.set)).toBe('canceled');
});

it('settles a cancellation whose executor went silent mid-run', async () => {
  // Beta 2026-11-11, set 5a2d8619: dispatched, granted, then the agent was killed.
  const f = await fixture();
  await db.root('select public.service_reserve_catalog_video_grants($1,$2,$3,1,0,$4,$5)', [
    f.set,
    hash,
    native,
    f.request,
    f.op
  ]);
  // The round was reserved five minutes ago.
  await db.root(
    "update private.catalog_video_grant_rounds set expires_at=expires_at-interval '5 minutes' where video_set_id=$1",
    [f.set]
  );
  await silence(f.op!, 5);
  await cancelRequested(f.set);
  await settle();
  // The same transition the metadata-only cancellation path uses.
  expect((await operationState(f.op!)).state).toBe('canceled');
  expect(await setState(f.set)).toBe('canceled');
});

it('keeps a cancellation open while the executor is still heartbeating', async () => {
  const f = await fixture();
  await silence(f.op!, 5);
  await heartbeat(f.set, f.request, f.op);
  await cancelRequested(f.set);
  await settle();
  expect((await operationState(f.op!)).state).toBe('running');
  expect(await setState(f.set)).toBe('cancel_requested');
});

it('tells the creation read that the agent stopped answering', async () => {
  const f = await fixture();
  const read = async () =>
    (
      await db.root<{ v: Record<string, unknown> }>(
        'select public.service_read_initial_catalog_video($1,$2,$3)v',
        [team, owner, f.key]
      )
    )[0]!.v;
  await heartbeat(f.set, f.request, f.op);
  expect(await read()).toMatchObject({ outcome: 'preparing_video', state: 'preparing' });
  expect((await read()).agentSilent).toBeUndefined();
  await silence(f.op!, 3);
  await db.root(
    "update private.catalog_video_variants set heartbeat_at=clock_timestamp()-interval '3 minutes' where video_set_id=$1",
    [f.set]
  );
  expect(await read()).toMatchObject({ outcome: 'preparing_video', agentSilent: true });
});

it('one silent set whose observation cannot be written does not stop the others', async () => {
  // This suite pins 240000; the row isolation lands later in the release.
  await applyMigrationsAfter(db, '20261207240000_catalog_video_executor_liveness.sql');
  const healthy = await fixture();
  const poisoned = await fixture();
  await silence(healthy.op!, 20);
  await silence(poisoned.op!, 20);
  const cure = await poisonRows(db, 'private.catalog_video_variants', 'video_set_id', [
    poisoned.set
  ]);
  try {
    await settle();
    expect((await variant(healthy.set)).silence_observed_at).not.toBeNull();
    expect((await variant(poisoned.set)).silence_observed_at).toBeNull();
    expect(await settleFailure(db, 'catalog_video_silent_retry', poisoned.set)).toEqual({
      attempts: 1,
      last_code: 'SETTLE_TEST_POISON',
      deferred: true
    });
  } finally {
    await cure();
  }
  await expireBackoff(db, 'catalog_video_silent_retry', poisoned.set);
  await settle();
  expect((await variant(poisoned.set)).silence_observed_at).not.toBeNull();
  expect(await settleFailure(db, 'catalog_video_silent_retry', poisoned.set)).toBeUndefined();
});
