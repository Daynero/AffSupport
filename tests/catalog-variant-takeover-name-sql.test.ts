import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11, set f91fc4c9: the agent was killed mid-restitch, the silence
 * takeover failed its operation and requeued the variant, and the retry was
 * refused NAME_CONFLICT because the retired operation never released the
 * variant's fixed output name. The set stayed 'unknown' for good.
 */
let db: TeamTestDb, team: string, source: string, folder: string, delegation: string;
const owner = 'c3200000-0000-4000-8000-000000000001',
  executor = 'c3200000-0000-4000-8000-000000000002',
  native = 'c3200000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xac);
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207320000_catalog_variant_takeover_releases_name.sql'
  });
  await createUser(db, { id: owner, email: 'variant-takeover-name@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Name')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'name','name@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
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
  folder = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind)values($1,$2,'restitched','Restitched','folder')returning id",
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
    await db.root<{ state: string; request_id: string; operation_id: string | null }>(
      'select state,request_id,operation_id from private.catalog_video_variants where video_set_id=$1 and video_variant_index=0',
      [set]
    )
  )[0]!;
const setState = async (set: string) =>
  (
    await db.root<{ state: string }>('select state from private.catalog_video_sets where id=$1', [
      set
    ])
  )[0]!.state;
const released = async (op: string) =>
  (
    await db.root<{ released: boolean }>(
      'select reservation_released_at is not null released from public.team_operations where id=$1',
      [op]
    )
  )[0]!.released;
const nameOf = (set: string) => `catalog_variant_${set}_0.mp4`;
/** What service_start_team_operation does for a variant admission: reserve the fixed name. */
const startVariant = async (set: string, request: string) => {
  const op = crypto.randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,destination_folder_id,reserved_name_key,reservation_expires_at)values($1,$2,$3,'process','running',$4,$5,$5,$6,$7,clock_timestamp()+interval '30 minutes')",
    [op, team, owner, source, 'catalog-variant:' + request, folder, nameOf(set)]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
  return op;
};

async function fixture() {
  const set = crypto.randomUUID(),
    request = crypto.randomUUID();
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, 'name:' + set, {}, executor]
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
  const op = await startVariant(set, request);
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
  return { set, request, op };
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

it('releases the dead operation name on takeover, so the requeued variant can start', async () => {
  const f = await fixture();
  // Before the fix: the retry collided with the retired operation's reservation.
  await expect(startVariant(f.set, crypto.randomUUID())).rejects.toThrow();
  await silence(f.op, 3);
  const n = (
    await db.root<{ n: number }>(
      "select private.release_silent_catalog_video_variants($1,interval '2 minutes')n",
      [f.set]
    )
  )[0]!.n;
  expect(n).toBe(1);
  expect(await released(f.op)).toBe(true);
  const requeued = await variant(f.set);
  expect(requeued).toMatchObject({ state: 'queued', operation_id: null });
  expect(requeued.request_id).not.toBe(f.request);
  // The retry reserves the same fixed name: no NAME_CONFLICT any more.
  await expect(startVariant(f.set, requeued.request_id)).resolves.toBeTypeOf('string');
});

it('releases the name when the 15-minute sweep abandons a silent operation', async () => {
  const f = await fixture();
  await silence(f.op, 20);
  await db.root('select private.retry_failed_catalog_video_variant($1,0)', [f.set]);
  await db.root(
    "update private.catalog_video_variants set silence_observed_at=clock_timestamp()-interval '3 minutes' where video_set_id=$1",
    [f.set]
  );
  const answer = (
    await db.root<{ v: { kind: string } }>(
      'select private.retry_failed_catalog_video_variant($1,0)v',
      [f.set]
    )
  )[0]!.v;
  expect(answer.kind).toBe('retry');
  expect(await released(f.op)).toBe(true);
  await expect(startVariant(f.set, (await variant(f.set)).request_id)).resolves.toBeTypeOf(
    'string'
  );
});

it('releases the name when a silent cancelled operation is closed', async () => {
  const f = await fixture();
  await db.root('select public.service_reserve_catalog_video_grants($1,$2,$3,1,0,$4,$5)', [
    f.set,
    hash,
    native,
    f.request,
    f.op
  ]);
  await db.root(
    "update private.catalog_video_grant_rounds set expires_at=expires_at-interval '5 minutes' where video_set_id=$1",
    [f.set]
  );
  await silence(f.op, 5);
  await db.root("update private.catalog_video_sets set state='cancel_requested' where id=$1", [
    f.set
  ]);
  await db.root('select public.service_settle_catalog_video_cancellations(10)');
  expect(await setState(f.set)).toBe('canceled');
  expect(await released(f.op)).toBe(true);
});

it('revokes the transfer grants of an operation failed by a direct update', async () => {
  const f = await fixture();
  await db.root(
    "insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,max_range_bytes,expires_at)values($1,$2,$3,$4,'process_output',1024,clock_timestamp()+interval '1 hour')",
    [Buffer.alloc(32, 0x5e), f.op, team, owner]
  );
  await db.root(
    "update public.team_operations set state='failed',error_code='PROCESS_RESULT_UNCERTAIN',finished_at=clock_timestamp() where id=$1",
    [f.op]
  );
  expect(await released(f.op)).toBe(true);
  const open = (
    await db.root<{ n: string }>(
      'select count(*) n from private.team_transfer_grants where operation_id=$1 and revoked_at is null',
      [f.op]
    )
  )[0]!.n;
  expect(Number(open)).toBe(0);
});

it('requeues a variant whose admission was refused before any operation existed', async () => {
  // The state f91fc4c9 was left in: unknown, no operation of its request.
  const f = await fixture();
  await silence(f.op, 3);
  await db.root("select private.release_silent_catalog_video_variants($1,interval '2 minutes')", [
    f.set
  ]);
  const retried = await variant(f.set);
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,$5,$6)', [
    f.set,
    team,
    owner,
    executor,
    await revisionOf(f.set),
    [
      {
        index: 0,
        requestId: retried.request_id,
        operationId: null,
        state: 'unknown',
        outputId: null
      }
    ]
  ]);
  expect(await setState(f.set)).toBe('unknown');
  const answer = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_retry_failed_catalog_video_variants($1,$2,$3)v',
      [f.set, team, owner]
    )
  )[0]!.v;
  expect(answer).toMatchObject({ retried: 1, uncertain: 0, parentState: 'preparing' });
  // Same identity: a late operation of that request is still this variant.
  expect(await variant(f.set)).toMatchObject({
    state: 'queued',
    request_id: retried.request_id,
    operation_id: null
  });
});

it('keeps a terminal operation immutable apart from releasing its name', async () => {
  const f = await fixture();
  await db.root(
    "update public.team_operations set state='failed',error_code='X',finished_at=clock_timestamp() where id=$1",
    [f.op]
  );
  await expect(
    db.root("update public.team_operations set error_code='Y' where id=$1", [f.op])
  ).rejects.toThrow('TERMINAL_OPERATION_IMMUTABLE');
  await expect(
    db.root('update public.team_operations set reservation_released_at=null where id=$1', [f.op])
  ).rejects.toThrow('TERMINAL_OPERATION_IMMUTABLE');
});

it('lets a failed operation that still holds its name be released, as the repair does', async () => {
  // How 240000's takeover left the operation of f91fc4c9: failed, name held.
  const f = await fixture();
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      "update public.team_operations set state='failed',error_code='PROCESS_RESULT_UNCERTAIN',finished_at=clock_timestamp() where id=$1",
      [f.op]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  expect(await released(f.op)).toBe(false);
  await db.root(
    'update public.team_operations set reservation_released_at=coalesce(finished_at,clock_timestamp()) where id=$1',
    [f.op]
  );
  expect(await released(f.op)).toBe(true);
});
