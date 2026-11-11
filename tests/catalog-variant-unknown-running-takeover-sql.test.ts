import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11, set a0f1fd63: one heartbeat lost under load made the agent
 * abort its own stitch and record the variant 'unknown' while its operation
 * stayed 'running'. The takeover and the 15-minute sweep only looked at
 * 'working' variants, so the set waited for the 12-hour rule.
 */
let db: TeamTestDb, team: string, source: string, delegation: string;
const owner = 'c3400000-0000-4000-8000-000000000001',
  executor = 'c3400000-0000-4000-8000-000000000002',
  native = 'c3400000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xac);
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207340000_catalog_variant_unknown_running_takeover.sql'
  });
  await createUser(db, { id: owner, email: 'variant-unknown-running@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Unknown')")
  )[0]!.id;
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
    "update private.catalog_generation_intents set checkpoint=jsonb_build_object('initialVideoPlan',jsonb_build_object('setId',$2::text)),request_payload=request_payload||'{\"catalogVideoProtocolVersion\":1}'::jsonb where id=$1",
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
/** What the agent records after it drained its own stitch without closing the operation. */
const abortedByAgent = async (set: string) => {
  await db.root(
    "update private.catalog_video_variants set state='unknown' where video_set_id=$1 and video_variant_index=0",
    [set]
  );
  await db.root(
    "update private.catalog_video_sets set state='unknown',revision=revision+1 where id=$1",
    [set]
  );
};

it('a restarted agent takes over an unknown variant whose operation was left running', async () => {
  const f = await fixture();
  await abortedByAgent(f.set);
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

it('leaves an unknown variant alone while its operation still shows life', async () => {
  const f = await fixture();
  await abortedByAgent(f.set);
  expect(await release(f.set)).toBe(0);
  expect((await operationState(f.op!)).state).toBe('running');
  expect((await variant(f.set)).state).toBe('unknown');
});

it('never takes over an unknown variant that may have produced output', async () => {
  const f = await fixture();
  await abortedByAgent(f.set);
  await silence(f.op!, 30);
  await db.root(
    "update private.team_operation_intents set provider_result_id='drive-file' where operation_id=$1",
    [f.op]
  );
  expect(await release(f.set)).toBe(0);
  expect((await operationState(f.op!)).state).toBe('running');
});

it('the per-minute sweep requeues an unknown variant after confirmed silence', async () => {
  const f = await fixture();
  await abortedByAgent(f.set);
  await silence(f.op!, 20);
  // First pass records the silence; the operation keeps running.
  await settle();
  expect((await variant(f.set)).silence_observed_at).not.toBeNull();
  expect((await operationState(f.op!)).state).toBe('running');
  await db.root(
    "update private.catalog_video_variants set silence_observed_at=clock_timestamp()-interval '3 minutes' where video_set_id=$1",
    [f.set]
  );
  expect((await settle()).resolved).toBeGreaterThanOrEqual(1);
  expect(await operationState(f.op!)).toEqual({
    state: 'failed',
    error_code: 'PROCESS_RESULT_UNCERTAIN'
  });
  expect(await variant(f.set)).toMatchObject({ state: 'queued', retry_count: 1 });
  expect(await setState(f.set)).toBe('preparing');
});
