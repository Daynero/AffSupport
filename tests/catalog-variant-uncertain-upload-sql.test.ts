import { createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11 (gateway paused mid-upload): a catalog variant whose operation
 * owns a started upload waited for the 12-hour rule. It is now reconciled by its
 * generated Drive id within minutes: registered, proven absent, mismatched (left
 * in place) or retried with a bounded backoff and then given up as 'attention'.
 */
let db: TeamTestDb, team: string, source: string, connection: string, credential: string;
const owner = 'c3470000-0000-4000-8000-000000000001',
  executor = 'c3470000-0000-4000-8000-000000000002',
  native = 'c3470000-0000-4000-8000-000000000003',
  hash = Buffer.alloc(32, 0xac);
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261207347000_catalog_variant_uncertain_upload_reconcile.sql'
  });
  await createUser(db, { id: owner, email: 'uncertain-upload@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Uncertain')")
  )[0]!.id;
  credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'live','live@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, credential]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,'source','Source','file','video','video/mp4',4,repeat('a',32),'1')returning id",
      [team, connection]
    )
  )[0]!.id;
  const delegation = (
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
/** A variant whose operation started uploading its output to a generated id. */
async function uploading(uploadState: 'prepared' | 'started' = 'started') {
  const set = crypto.randomUUID(),
    request = crypto.randomUUID(),
    op = crypto.randomUUID(),
    fileId = 'gen' + crypto.randomUUID().replaceAll('-', ''),
    ticket = crypto.randomUUID() + crypto.randomUUID();
  const intent = (
    await db.root<{ v: { id: string } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, source, owner, 'live:' + set, {}, executor]
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
  await db.root(
    "insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses)values($1,$2,$3,$4,'finalize','restitch',4,clock_timestamp()+interval '6 hours',4)",
    [createHash('sha256').update(ticket).digest(), op, team, owner]
  );
  await db.root(
    "insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at,upload_state)values($1,$2,$3,$4,$5,'root','root',$6,'source','copy.mp4','video/mp4',4,repeat('c',32),clock_timestamp()+interval '6 hours',$7)",
    [op, team, owner, connection, credential, fileId, uploadState]
  );
  return { set, op, fileId, ticket };
}
/** The operations table stamps updated_at on every write; age it past that trigger. */
const silence = async (op: string, minutes: number) => {
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      'update public.team_operations set created_at=clock_timestamp()-make_interval(mins=>$2+1),updated_at=clock_timestamp()-make_interval(mins=>$2) where id=$1',
      [op, minutes]
    );
    await db.root(
      'update private.catalog_video_variants set heartbeat_at=clock_timestamp()-make_interval(mins=>$2) where operation_id=$1',
      [op, minutes]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
};
const claim = async (operation?: string) =>
  (
    await db.root<{ v: Array<Record<string, unknown>> }>(
      'select public.service_claim_uncertain_process_uploads($1,3,$2)v',
      [executor, operation ?? null]
    )
  )[0]!.v;
const settle = async (op: string, fence: unknown, result: string, code: string | null = null) =>
  (
    await db.root<{ v: string }>(
      'select public.service_settle_uncertain_process_upload($1,$2,$3,$4,$5)v',
      [op, executor, fence, result, code]
    )
  )[0]!.v;
const state = async (f: { set: string; op: string }) =>
  (
    await db.root<{
      operation: string;
      cleanup: string;
      code: string | null;
      released: boolean;
      variant: string;
      retry: number;
      set: string;
    }>(
      `select o.state operation,u.cleanup_state cleanup,u.last_code code,o.reservation_released_at is not null released,
        v.state variant,v.retry_count retry,s.state set
       from public.team_operations o join private.process_upload_ownership u on u.operation_id=o.id,
        private.catalog_video_variants v join private.catalog_video_sets s on s.id=v.video_set_id
       where o.id=$1 and v.video_set_id=$2 and v.video_variant_index=0`,
      [f.op, f.set]
    )
  )[0]!;
const grantRevoked = async (op: string) =>
  (
    await db.root<{ revoked: boolean }>(
      "select bool_and(revoked_at is not null) revoked from private.team_transfer_grants where operation_id=$1 and purpose='finalize'",
      [op]
    )
  )[0]!.revoked;

it('claims a silent uncertain upload under a lease and revokes the agent finalize', async () => {
  const f = await uploading();
  await silence(f.op, 3);
  const plans = await claim(f.op);
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({
    operationId: f.op,
    fileId: f.fileId,
    state: 'started',
    setId: f.set
  });
  expect(await grantRevoked(f.op)).toBe(true);
  // The lease keeps a second reconciler out.
  expect(await claim(f.op)).toHaveLength(0);
});

it('leaves an upload alone while its executor still shows life', async () => {
  const f = await uploading();
  await silence(f.op, 1);
  expect(await claim(f.op)).toHaveLength(0);
  expect(await grantRevoked(f.op)).toBe(false);
});

it('the agent’s own word that its uploader quiesced starts the reconcile at once', async () => {
  const f = await uploading();
  const requested = await db.root<{ v: boolean }>(
    'select public.service_request_process_upload_reconcile($1,$2)v',
    [f.op, createHash('sha256').update(f.ticket).digest()]
  );
  expect(requested[0]!.v).toBe(true);
  expect(await claim(f.op)).toHaveLength(1);
});

it('a wrong ticket cannot request a reconcile', async () => {
  const f = await uploading();
  const requested = await db.root<{ v: boolean }>(
    'select public.service_request_process_upload_reconcile($1,$2)v',
    [f.op, Buffer.alloc(32, 1)]
  );
  expect(requested[0]!.v).toBe(false);
});

it('proven absent: failed as not_created, name released, variant requeued', async () => {
  const f = await uploading();
  await silence(f.op, 3);
  const [plan] = await claim(f.op);
  expect(await settle(f.op, plan!.fence, 'absent')).toBe('not_created');
  expect(await state(f)).toMatchObject({
    operation: 'failed',
    cleanup: 'not_created',
    code: null,
    released: true,
    variant: 'queued',
    retry: 1
  });
});

it('a mismatched file is left in place as attention and the variant requeued', async () => {
  const f = await uploading();
  await silence(f.op, 3);
  const [plan] = await claim(f.op);
  expect(await settle(f.op, plan!.fence, 'mismatch', 'SOURCE_CHANGED')).toBe('attention');
  expect(await state(f)).toMatchObject({
    operation: 'failed',
    cleanup: 'attention',
    code: 'SOURCE_CHANGED',
    variant: 'queued',
    retry: 1
  });
});

it('an undecided lookup backs off in minutes and gives up as attention after eight', async () => {
  const f = await uploading();
  await silence(f.op, 3);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const [plan] = await claim(f.op);
    expect(plan).toMatchObject({ attempt });
    const outcome = await settle(f.op, plan!.fence, 'unknown', 'DRIVE_UNAVAILABLE');
    if (attempt < 8) {
      expect(outcome).toBe('waiting');
      // Not due again before its backoff …
      expect(await claim(f.op)).toHaveLength(0);
      const next = (
        await db.root<{ seconds: number }>(
          'select extract(epoch from reconcile_next_at-clock_timestamp())::integer seconds from private.process_upload_ownership where operation_id=$1',
          [f.op]
        )
      )[0]!.seconds;
      expect(next).toBeLessThanOrEqual(600);
      // … which the test skips.
      await db.root(
        'update private.process_upload_ownership set reconcile_next_at=null where operation_id=$1',
        [f.op]
      );
    } else expect(outcome).toBe('attention');
  }
  expect(await state(f)).toMatchObject({
    operation: 'failed',
    cleanup: 'attention',
    code: 'DRIVE_UNAVAILABLE',
    variant: 'queued'
  });
});

it('a verified file becomes the variant output', async () => {
  const f = await uploading();
  await silence(f.op, 3);
  const [plan] = await claim(f.op);
  // What service_finalize_uploaded_material commits for the verified file.
  const material = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,$3,'root','copy.mp4','file','video','video/mp4',4,repeat('c',32),'1')returning id",
      [team, connection, f.fileId]
    )
  )[0]!.id;
  await db.root(
    "update public.team_operations set state='succeeded',result_material_id=$2,finished_at=clock_timestamp() where id=$1",
    [f.op, material]
  );
  expect(await settle(f.op, plan!.fence, 'registered')).toBe('registered');
  expect(await state(f)).toMatchObject({
    operation: 'succeeded',
    variant: 'registered',
    set: 'ready'
  });
});

it('an upload that never started is failed at once without a Drive lookup', async () => {
  const f = await uploading('prepared');
  await silence(f.op, 3);
  expect(await claim(f.op)).toHaveLength(0);
  expect(await state(f)).toMatchObject({
    operation: 'failed',
    cleanup: 'not_created',
    variant: 'queued',
    retry: 1
  });
});

it('a stale fence cannot settle', async () => {
  const f = await uploading();
  await silence(f.op, 3);
  const [plan] = await claim(f.op);
  await expect(settle(f.op, String(Number(plan!.fence) + 1), 'absent')).rejects.toThrow(
    'WRONG_STATE'
  );
});

it('wakes the per-minute dispatcher for a due uncertain upload', async () => {
  const f = await uploading();
  await silence(f.op, 3);
  const due = await db.root<{ v: boolean }>('select private.process_output_cleanup_due()v');
  expect(due[0]!.v).toBe(true);
  await claim(f.op);
});
