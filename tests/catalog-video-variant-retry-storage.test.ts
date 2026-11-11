import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: a catalog video variant whose operation provably failed without
 * output gets a bounded retry under a new identity instead of staying
 * 'unknown' forever (production 2026-11-10: 9 of 10 videos done, the set and
 * its launch unrecoverable). Anything that may still be running or may have
 * produced output keeps the old answer.
 */
let db: TeamTestDb, team: string, source: string, connection: string, delegation: string;
const owner = 'c1930000-0000-4000-8000-000000000001',
  executor = 'c1930000-0000-4000-8000-000000000002',
  native = 'c1930000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xaa);
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207199000_catalog_video_variant_retry.sql'
  });
  await createUser(db, { id: owner, email: 'variant-retry@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Retry')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'retry','retry@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
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
      [team, owner, executor, Buffer.alloc(32, 0xbb)]
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
      request_id: string;
      original_request_id: string | null;
      operation_id: string | null;
      retry_count: number;
    }>(
      'select state,request_id,original_request_id,operation_id,retry_count from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
      [set]
    )
  )[0]!;
const setState = async (set: string) =>
  (
    await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
      set
    ])
  )[0]!.state;

/** Admits a running restitch operation for the variant's current request. */
async function admit(set: string, request: string) {
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
  return op;
}
const fail = async (set: string, request: string, op: string, code = 'PROCESS_FAILED') =>
  db.root("select public.service_complete_catalog_video_variant($1,$2,$3,1,0,$4,$5,'failed',$6)", [
    set,
    hash,
    native,
    request,
    op,
    code
  ]);
const retry = async (set: string, request: string) =>
  (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_retry_catalog_video_variant($1,$2,$3,$4,1,0,$5)v',
      [set, team, owner, executor, request]
    )
  )[0]!.v;
async function fixture() {
  const set = crypto.randomUUID(),
    request = crypto.randomUUID(),
    row = crypto.randomUUID();
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, 'retry:' + set, {}, executor]
    )
  )[0]!.v.id;
  const acceptance = [
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
    [{ recipeRowId: row, videoVariantIndex: 0 }]
  ];
  await db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', acceptance);
  return { set, request, acceptance, op: await admit(set, request) };
}

it('requeues a variant whose operation failed without output under a new identity', async () => {
  const f = await fixture();
  await fail(f.set, f.request, f.op);
  expect(await variant(f.set)).toMatchObject({ state: 'unknown', operation_id: f.op });
  expect(await setState(f.set)).toBe('unknown');
  const before = await revisionOf(f.set);

  const answer = await retry(f.set, f.request);

  expect(answer).toMatchObject({ kind: 'retry', attempt: 1 });
  expect(answer.requestId).not.toBe(f.request);
  expect(await variant(f.set)).toEqual({
    state: 'queued',
    request_id: answer.requestId,
    original_request_id: f.request,
    operation_id: null,
    retry_count: 1
  });
  expect(await setState(f.set)).toBe('preparing');
  expect(await revisionOf(f.set)).toBe(before + 1);
  // The retired identity is history, and its operation still may not be deleted.
  expect(
    await db.root(
      'select attempt,request_id,operation_id,failure_code from private.catalog_video_variant_attempts where video_set_id=$1',
      [f.set]
    )
  ).toEqual([
    { attempt: 0, request_id: f.request, operation_id: f.op, failure_code: 'PROCESS_FAILED' }
  ]);
  await expect(db.root('delete from public.team_operations where id=$1', [f.op])).rejects.toThrow(
    'WRONG_STATE'
  );
  // The new identity has no operation yet: authoritative absence, so it may be admitted.
  expect(
    (
      await db.root<{ v: unknown }>(
        'select public.service_reconcile_catalog_video_variant($1,$2,$3,$4,1,0,$5)v',
        [f.set, team, owner, executor, answer.requestId]
      )
    )[0]!.v
  ).toEqual({ kind: 'absent' });
  // The frozen plan still names the original child id and is still the same set.
  await expect(
    db.root('select public.service_accept_catalog_video_set($1,$2,$3,$4,$5,$6)', f.acceptance)
  ).resolves.toBeTruthy();
  // The retired request can no longer ask for anything.
  await expect(retry(f.set, f.request)).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});

const reserve = async (set: string, request: string, op: string) =>
  (
    await db.root<{ v: { sourceTicketId: string; acquisition: number } }>(
      'select public.service_reserve_catalog_video_grants($1,$2,$3,1,0,$4,$5)v',
      [set, hash, native, request, op]
    )
  )[0]!.v;
it('grants two retries and then leaves the set unknown for good', async () => {
  const f = await fixture();
  let request: string = f.request,
    op: string = f.op;
  const tickets = new Set([(await reserve(f.set, request, op)).sourceTicketId]);
  for (const attempt of [1, 2]) {
    await fail(f.set, request, op);
    const answer = await retry(f.set, request);
    expect(answer).toMatchObject({ kind: 'retry', attempt });
    request = answer.requestId as string;
    op = await admit(f.set, request);
    // The retired operation's grant round is gone: the new one starts its own.
    const round = await reserve(f.set, request, op);
    expect(round.acquisition).toBe(1);
    expect(tickets.has(round.sourceTicketId)).toBe(false);
    tickets.add(round.sourceTicketId);
  }
  await fail(f.set, request, op);

  expect(await retry(f.set, request)).toMatchObject({ kind: 'terminal', attempt: 2 });
  expect(await variant(f.set)).toMatchObject({
    state: 'unknown',
    request_id: request,
    operation_id: op,
    retry_count: 2
  });
  expect(await setState(f.set)).toBe('unknown');
  const settled = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_retry_failed_catalog_video_variants($1,$2,$3)v',
      [f.set, team, owner]
    )
  )[0]!.v;
  expect(settled).toMatchObject({
    retried: 0,
    terminal: 1,
    uncertain: 0,
    code: 'PROCESS_FAILED',
    parentState: 'unknown'
  });
});

it('requeues through the owner-scoped settle used by creation, launch and recovery', async () => {
  const f = await fixture();
  await fail(f.set, f.request, f.op, 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  const settled = (
    await db.root<{ v: { snapshot: { children: Array<Record<string, unknown>> } } }>(
      'select public.service_retry_failed_catalog_video_variants($1,$2,$3)v',
      [f.set, team, owner]
    )
  )[0]!.v;
  expect(settled).toMatchObject({
    retried: 1,
    terminal: 0,
    uncertain: 0,
    parentState: 'preparing'
  });
  expect(settled.snapshot.children[0]).toMatchObject({ state: 'queued', operationId: null });
  await expect(
    db.root('select public.service_retry_failed_catalog_video_variants($1,$2,$3)', [
      f.set,
      team,
      crypto.randomUUID()
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
});

it('never retries an operation that may still be running', async () => {
  const f = await fixture();
  expect(await retry(f.set, f.request)).toEqual({ kind: 'unknown' });
  expect(await variant(f.set)).toMatchObject({
    state: 'working',
    request_id: f.request,
    operation_id: f.op,
    retry_count: 0
  });
});

it('never retries a failed operation that may have produced output', async () => {
  const f = await fixture();
  await fail(f.set, f.request, f.op);
  await db.root(
    "update private.team_operation_intents set provider_result_id='drive-file' where operation_id=$1",
    [f.op]
  );
  expect(await retry(f.set, f.request)).toEqual({ kind: 'unknown' });
  expect(await variant(f.set)).toMatchObject({ state: 'unknown', retry_count: 0 });
});

it('does not spend retries on a failure the same input will repeat', async () => {
  const f = await fixture();
  await fail(f.set, f.request, f.op, 'SOURCE_CHANGED');
  expect(await retry(f.set, f.request)).toMatchObject({ kind: 'terminal', code: 'SOURCE_CHANGED' });
  expect(await variant(f.set)).toMatchObject({ state: 'unknown', retry_count: 0 });
});

it('stops a launch whose video set cannot move as non-retryable', async () => {
  const source = (
    await db.root<{ d: string }>(
      "select pg_get_functiondef('public.service_fail_launch_catalog_video(uuid,uuid,uuid,text,text,text)'::regprocedure) d"
    )
  )[0]!.d;
  expect(source).toContain("state='interrupted',safe_error_code=p_code,retryable=false");
  expect(source).toContain('next_attempt_at=null');
  expect(source).toContain("raise exception 'LEASE_MISMATCH'");
});

it('lets a retried variant own a second restitch alias root', async () => {
  // One alias per root operation stays; one per variant would refuse the retry's new root.
  expect(
    await db.root(
      "select conname from pg_constraint where conrelid='private.restitch_process_aliases'::regclass and contype='u' and pg_get_constraintdef(oid) ilike '%(video_set_id, video_variant_index)%'"
    )
  ).toEqual([]);
  expect(
    (
      await db.root<{ n: number }>(
        "select count(*)::integer n from pg_constraint where conrelid='private.restitch_process_aliases'::regclass and contype='p'"
      )
    )[0]!.n
  ).toBe(1);
});

const settle = async (set: string) =>
  (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_retry_failed_catalog_video_variants($1,$2,$3)v',
      [set, team, owner]
    )
  )[0]!.v;
const operationState = async (op: string) =>
  (
    await db.root<{ state: string; error_code: string | null }>(
      'select state,error_code from public.team_operations where id=$1',
      [op]
    )
  )[0]!;
// The operations table stamps updated_at on every write; age it past that trigger.
const ageOperation = async (op: string) => {
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      "update public.team_operations set created_at=clock_timestamp()-interval '14 hours',updated_at=clock_timestamp()-interval '13 hours' where id=$1",
      [op]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
};

it('registers a variant whose operation succeeded but whose confirmation was lost', async () => {
  // Production 2026-11-10 (set 52c28131): the upload finished on the server, the
  // agent never heard back, and the variant stayed unknown.
  const f = await fixture();
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'output','Output','file','video','video/mp4',4,repeat('c',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  await db.root(
    "update public.team_operations set state='succeeded',result_material_id=$2,finished_at=clock_timestamp() where id=$1",
    [f.op, output]
  );
  expect(await settle(f.set)).toMatchObject({ registered: 1, retried: 0, parentState: 'ready' });
  expect(await variant(f.set)).toMatchObject({
    state: 'registered',
    operation_id: f.op,
    retry_count: 0
  });
});

it('keeps unknown a succeeded operation without a live output material', async () => {
  const f = await fixture();
  await db.root(
    "update public.team_operations set state='succeeded',finished_at=clock_timestamp() where id=$1",
    [f.op]
  );
  expect(await settle(f.set)).toMatchObject({ registered: 0, retried: 0, uncertain: 1 });
  expect(await variant(f.set)).toMatchObject({ state: 'working', retry_count: 0 });
});

it('fails and retries an operation abandoned for 12 hours without output', async () => {
  // Production 2026-11-10 (set fa708f8e): the agent died in a database outage;
  // the operation stayed running and every reconcile answered unknown.
  const f = await fixture();
  await reserve(f.set, f.request, f.op);
  await db.root(
    "update private.catalog_video_grant_rounds set expires_at=clock_timestamp()-interval '7 hours' where video_set_id=$1",
    [f.set]
  );
  await ageOperation(f.op);
  expect(await settle(f.set)).toMatchObject({ retried: 1, parentState: 'preparing' });
  expect(await operationState(f.op)).toEqual({
    state: 'failed',
    error_code: 'PROCESS_RESULT_UNCERTAIN'
  });
  expect(await variant(f.set)).toMatchObject({
    state: 'queued',
    operation_id: null,
    retry_count: 1
  });
});

it('keeps a running operation with a recent grant unknown', async () => {
  const f = await fixture();
  await reserve(f.set, f.request, f.op);
  // The operation row looks old, but a grant was reserved an hour ago.
  await db.root(
    "update private.catalog_video_grant_rounds set expires_at=clock_timestamp()+interval '5 hours' where video_set_id=$1",
    [f.set]
  );
  await ageOperation(f.op);
  expect(await settle(f.set)).toMatchObject({ retried: 0, uncertain: 1 });
  expect((await operationState(f.op)).state).toBe('running');
});

it('keeps an abandoned operation that may have produced output unknown', async () => {
  const f = await fixture();
  await ageOperation(f.op);
  await db.root(
    "update private.team_operation_intents set provider_result_id='drive-file' where operation_id=$1",
    [f.op]
  );
  expect(await settle(f.set)).toMatchObject({ retried: 0, uncertain: 1 });
  expect((await operationState(f.op)).state).toBe('running');
});
