import { STITCH_ERROR_CODES } from '@video-compressor/shared';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb, team: string, source: string, connection: string, delegation: string;
const owner = 'c1680000-0000-4000-8000-000000000001',
  executor = 'c1680000-0000-4000-8000-000000000002',
  native = 'c1680000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xaa);
beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261207168000_catalog_video_sets.sql' });
  await createUser(db, { id: owner, email: 'variant-closure@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Closure')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'closure','closure@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
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
}, 180000);
afterAll(async () => {
  await db?.close();
});
async function fixture() {
  const set = crypto.randomUUID(),
    request = crypto.randomUUID(),
    op = crypto.randomUUID();
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, 'closure:' + set, {}, executor]
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
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce)values($1,$2,$3,'process','running',$4,$5,$5)",
    [op, team, owner, source, 'catalog-variant:' + request]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version,expected_source_drive_file_id,expected_source_checksum,expected_name,expected_size,mime_type)values($1,$2,'restitch','1','source',repeat('a',32),'copy.mp4',4,'video/mp4')",
    [op, team]
  );
  await db.root('select public.service_checkpoint_catalog_video_set($1,$2,$3,$4,1,0,$5)', [
    set,
    team,
    owner,
    executor,
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
const cancel = async (f: Awaited<ReturnType<typeof fixture>>) =>
  db.root("update private.catalog_video_sets set state='cancel_requested'where id=$1", [f.set]);
const complete = async (f: Awaited<ReturnType<typeof fixture>>, credential = hash, boot = native) =>
  (
    await db.root<{ v: Record<string, unknown> }>(
      "select public.service_complete_catalog_video_variant($1,$2,$3,1,0,$4,$5,'canceled','PROCESS_CANCELED')v",
      [f.set, credential, boot, f.request, f.op]
    )
  )[0]!.v;
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  await db.root(
    "select private.issue_team_transfer_grant($1,$2,$3,$4,'finalize',$5,null,'restitch',33554432,clock_timestamp()+interval '1 hour',4)",
    [Buffer.from(crypto.getRandomValues(new Uint8Array(32))), f.op, team, owner, source]
  );
  return db.root("select public.service_prepare_process_upload($1,$2,$3,$4,repeat('a',32))", [
    f.op,
    owner,
    connection,
    'output-' + f.op
  ]);
}
it('cancel-before-output locks the original operation terminal and blocks later provider preparation', async () => {
  const f = await fixture();
  await cancel(f);
  expect(await complete(f)).toMatchObject({
    kind: 'terminal',
    state: 'canceled',
    operationId: f.op
  });
  await expect(prepare(f)).rejects.toThrow('WRONG_STATE');
  expect(await complete(f)).toMatchObject({ kind: 'terminal', state: 'canceled' });
});
it('prepared or started upload ownership remains unknown and never gets terminalized or reallocated', async () => {
  const f = await fixture();
  await prepare(f);
  await cancel(f);
  expect(await complete(f)).toMatchObject({ kind: 'unknown' });
  await db.root('select public.service_start_process_upload($1,$2)', [f.op, owner]);
  expect(await complete(f)).toMatchObject({ kind: 'unknown' });
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        f.op
      ])
    )[0]!.state
  ).toBe('running');
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::integer n from private.process_upload_ownership where operation_id=$1',
        [f.op]
      )
    )[0]!.n
  ).toBe(1);
});
it('original finalized registration wins a late cancellation without replacing its operation', async () => {
  const f = await fixture();
  const output = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type)values($1,$2,$3,'Output','file','video','video/mp4')returning id",
      [team, connection, 'final-' + f.op]
    )
  )[0]!.id;
  await db.root(
    "select public.service_transition_team_operation($1,'succeeded','completed',100,$2,null,false)",
    [f.op, output]
  );
  await cancel(f);
  expect(await complete(f)).toMatchObject({
    kind: 'registered',
    operationId: f.op,
    outputId: output
  });
});
it('rejects a different native boot or credential rather than granting closure to another executor', async () => {
  const f = await fixture();
  await cancel(f);
  await expect(complete(f, hash, crypto.randomUUID())).rejects.toThrow('PERMISSION_DENIED');
  await expect(complete(f, Buffer.alloc(32, 0xcc))).rejects.toThrow('PERMISSION_DENIED');
});
it('admits every closed local recovery/stitch code while raw failures stay unknown', async () => {
  const f = await fixture();
  for (const code of STITCH_ERROR_CODES) {
    const result = (
      await db.root<{ v: unknown }>(
        "select public.service_complete_catalog_video_variant($1,$2,$3,1,0,$4,$5,'failed',$6)v",
        [f.set, hash, native, f.request, f.op, code]
      )
    )[0]!.v;
    expect(result).toMatchObject({ kind: 'terminal', state: 'failed' });
  }
  await expect(
    db.root(
      "select public.service_complete_catalog_video_variant($1,$2,$3,1,0,$4,$5,'failed',$6)",
      [f.set, hash, native, f.request, f.op, 'https://provider/token']
    )
  ).rejects.toThrow('INVALID_INPUT');
});
it('original dispatch closure survives credential retirement while every new media grant remains refused', async () => {
  const f = await fixture();
  await cancel(f);
  await db.root('delete from private.team_recovery_credentials where hash=$1', [hash]);
  await db.root(
    'update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1 where id=$1',
    [delegation]
  );
  await expect(
    db.root('select public.service_read_catalog_video_process_context($1,$2,$3,1,0,$4,$5)', [
      f.set,
      hash,
      native,
      f.request,
      f.op
    ])
  ).rejects.toThrow();
  expect(await complete(f)).toMatchObject({
    kind: 'terminal',
    state: 'canceled',
    operationId: f.op
  });
});
