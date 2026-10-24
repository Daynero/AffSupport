import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const OWNER = '36000000-0000-4000-8000-000000000139';
const OTHER = '36000000-0000-4000-8000-000000000140';
const CHECKSUM = 'a'.repeat(32);
let db: TeamTestDb;
let team: string;
let connection: string;
let source: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'process-owner@test.invalid' });
  await createUser(db, { id: OTHER, email: 'process-other@test.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Outputs')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('process-owner','process@test.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [OWNER]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'own-root','Own root','my_drive','connected',now()) returning id",
      [team, credential]
    )
  )[0]!.id;
  source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,mime_type,category) values($1,$2,'original-source','original.mp4','file','video/mp4','video') returning id",
      [team, connection]
    )
  )[0]!.id;
}, 60_000);
afterAll(async () => {
  await db?.close();
});

async function operation(overwrite = false) {
  const id = randomUUID();
  await db.root(
    "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce) values($1::uuid,$2,$3,'process','running',$4,$1::uuid::text,gen_random_uuid()::text)",
    [id, team, OWNER, source]
  );
  await db.root(
    "insert into private.team_operation_intents(operation_id,team_id,expected_name,mime_type,expected_size,tool_id,tool_contract_version,version_of_material_id) values($1,$2,$3,'video/mp4',16,'compressor',1,$4)",
    [id, team, `out-${id}.mp4`, overwrite ? source : null]
  );
  await db.root(
    "insert into private.team_transfer_grants(token_hash,operation_id,team_id,actor_id,purpose,tool_id,max_range_bytes,expires_at,max_uses) values(decode(md5($1::uuid::text)||md5($1::uuid::text||':grant'),'hex'),$1::uuid,$2,$3,'finalize','compressor',2097152,now()+interval '1 hour',4)",
    [id, team, OWNER]
  );
  return id;
}
async function prepare(id: string, file = `reserved-${id}`, checksum = CHECKSUM, actor = OWNER) {
  return (
    await db.root<{ binding: { fileId: string; nonce: string; state: string } }>(
      'select public.service_prepare_process_upload($1,$2,$3,$4,$5) as binding',
      [id, actor, connection, file, checksum]
    )
  )[0]!.binding;
}
async function start(id: string) {
  return db.root('select public.service_start_process_upload($1,$2)', [id, OWNER]);
}
async function cancel(id: string) {
  await db.asUser(OWNER, 'select public.cancel_team_operation($1,$2)', [team, id]);
}
type Plan = { operationId: string; fence: string; fileId: string };
async function claim(owner: string) {
  return (
    await db.root<{ plans: Plan[] }>(
      'select public.service_claim_process_output_cleanup($1,3) as plans',
      [owner]
    )
  )[0]!.plans;
}

it('durably reuses one identity and refuses changed bytes, another actor and original IDs', async () => {
  const id = await operation();
  const first = await prepare(id);
  expect(first.fileId).toBe(`reserved-${id}`);
  expect(first.nonce).toMatch(/^[a-f0-9-]{36}$/u);
  expect(await prepare(id, 'unused-second-provider-id')).toEqual(first);
  await expect(prepare(id, 'unused', 'b'.repeat(32))).rejects.toThrow('SOURCE_CHANGED');
  await expect(prepare(id, 'unused', CHECKSUM, OTHER)).rejects.toThrow();
  await expect(prepare(await operation(), 'original-source')).rejects.toThrow('SOURCE_CHANGED');
  await expect(prepare(await operation(true))).rejects.toThrow('WRONG_STATE');
});

it('cancellation before start proves no provider write and permanently refuses a late start', async () => {
  const id = await operation();
  await prepare(id);
  await cancel(id);
  await expect(start(id)).rejects.toThrow('WRONG_STATE');
  expect(
    await db.root(
      'select cleanup_state from private.process_upload_ownership where operation_id=$1',
      [id]
    )
  ).toEqual([{ cleanup_state: 'not_created' }]);
});

it('persists pending cleanup after cancel and rejects stale cleanup leases after restart', async () => {
  const id = await operation();
  await prepare(id);
  await start(id);
  await cancel(id);
  const oldOwner = randomUUID();
  const first = (await claim(oldOwner)).find(p => p.operationId === id)!;
  expect(first.fileId).toBe(`reserved-${id}`);
  await db.root(
    "update private.process_upload_ownership set lease_expires_at=now()-interval '1 second' where operation_id=$1",
    [id]
  );
  const newOwner = randomUUID();
  const second = (await claim(newOwner)).find(p => p.operationId === id)!;
  expect(second.fence).not.toBe(first.fence);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        'select public.service_authorize_process_output_cleanup($1,$2,$3) as allowed',
        [id, oldOwner, first.fence]
      )
    )[0]!.allowed
  ).toBe(false);
  await expect(
    db.root("select public.service_settle_process_output_cleanup($1,$2,$3,'trashed',null)", [
      id,
      oldOwner,
      first.fence
    ])
  ).rejects.toThrow('WRONG_STATE');
  expect(
    (
      await db.root<{ allowed: boolean }>(
        'select public.service_authorize_process_output_cleanup($1,$2,$3) as allowed',
        [id, newOwner, second.fence]
      )
    )[0]!.allowed
  ).toBe(true);
  await db.root("select public.service_settle_process_output_cleanup($1,$2,$3,'trashed',null)", [
    id,
    newOwner,
    second.fence
  ]);
  expect(
    (
      await db.root('select state,result_material_id from public.team_operations where id=$1', [id])
    )[0]
  ).toEqual({ state: 'canceled', result_material_id: null });
});

it('does not turn a pending provider 404 into cleaned and bounds retries with explicit uncertainty', async () => {
  const id = await operation();
  await prepare(id);
  await start(id);
  await cancel(id);
  const owner = randomUUID();
  const plan = (await claim(owner)).find(p => p.operationId === id)!;
  await db.root(
    "select public.service_settle_process_output_cleanup($1,$2,$3,'pending','PROCESS_RESULT_UNCERTAIN')",
    [id, owner, plan.fence]
  );
  expect(
    (
      await db.root(
        'select cleanup_state from private.process_upload_ownership where operation_id=$1',
        [id]
      )
    )[0]
  ).toEqual({ cleanup_state: 'waiting' });
  await db.root(
    "update private.process_upload_ownership set attempts=24,next_attempt_at=now()-interval '1 second' where operation_id=$1",
    [id]
  );
  expect((await claim(randomUUID())).some(p => p.operationId === id)).toBe(false);
  expect(
    (
      await db.root(
        'select cleanup_state,last_code from private.process_upload_ownership where operation_id=$1',
        [id]
      )
    )[0]
  ).toEqual({ cleanup_state: 'attention', last_code: 'PROCESS_RESULT_UNCERTAIN' });
});

it('keeps unpublished outputs out of catalog indexing and permits atomic successful publication', async () => {
  const id = await operation();
  const binding = await prepare(id);
  await start(id);
  const file = {
    drive_file_id: binding.fileId,
    name: `out-${id}.mp4`,
    kind: 'file',
    mime_type: 'video/mp4',
    category: 'video',
    size_bytes: 16,
    checksum: CHECKSUM
  };
  await db.root('select private.upsert_catalog_snapshot($1,null,$2::jsonb,pg_current_snapshot())', [
    connection,
    JSON.stringify([file])
  ]);
  expect(
    await db.root('select id from public.team_materials where drive_file_id=$1', [binding.fileId])
  ).toEqual([]);
  const material = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,category,size_bytes,checksum) values($1,$2,$3,'own-root',$4,'file','video/mp4','video',16,$5) returning id",
      [team, connection, binding.fileId, `out-${id}.mp4`, CHECKSUM]
    )
  )[0]!.id;
  await expect(
    db.root(
      "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
      [id, source]
    )
  ).rejects.toThrow('SOURCE_CHANGED');
  await db.root('update public.team_materials set checksum=$2 where id=$1', [
    material,
    'b'.repeat(32)
  ]);
  await expect(
    db.root(
      "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
      [id, material]
    )
  ).rejects.toThrow('SOURCE_CHANGED');
  await db.root('update public.team_materials set checksum=$2 where id=$1', [material, CHECKSUM]);
  await db.root(
    "update public.team_operations set state='succeeded',finished_at=now(),result_material_id=$2 where id=$1",
    [id, material]
  );
  expect(
    (
      await db.root(
        'select upload_state from private.process_upload_ownership where operation_id=$1',
        [id]
      )
    )[0]
  ).toEqual({ upload_state: 'published' });
  await cancel(id);
  expect((await claim(randomUUID())).some(p => p.operationId === id)).toBe(false);
});

it('refuses cleanup after the connected root changes and exposes no direct client authority', async () => {
  const id = await operation();
  await prepare(id);
  await start(id);
  await cancel(id);
  const owner = randomUUID();
  const plan = (await claim(owner)).find(p => p.operationId === id)!;
  await db.root(
    "update public.team_drive_connections set root_folder_id='different-root' where id=$1",
    [connection]
  );
  expect(
    (
      await db.root<{ allowed: boolean }>(
        'select public.service_authorize_process_output_cleanup($1,$2,$3) as allowed',
        [id, owner, plan.fence]
      )
    )[0]!.allowed
  ).toBe(false);
  await db.root("update public.team_drive_connections set root_folder_id='own-root' where id=$1", [
    connection
  ]);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.service_prepare_process_upload(uuid,uuid,uuid,text,text)','EXECUTE') as allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_table_privilege('authenticated','private.process_upload_ownership','SELECT') as allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  expect(
    (
      await db.root<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relrowsecurity,relforcerowsecurity from pg_class where oid='private.process_upload_ownership'::regclass"
      )
    )[0]
  ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
});

it('headless recovery settles an abandoned upload only after its handoff and grants expire', async () => {
  const id = await operation();
  await prepare(id);
  await start(id);
  expect((await claim(randomUUID())).some(p => p.operationId === id)).toBe(false);
  await db.root(
    "update private.process_upload_ownership set created_at=now()-interval '2 hours',handoff_expires_at=now()-interval '1 second' where operation_id=$1",
    [id]
  );
  // A renewed valid grant still prevents an abandonment decision.
  expect((await claim(randomUUID())).some(p => p.operationId === id)).toBe(false);
  await db.root(
    "update private.team_transfer_grants set created_at=now()-interval '2 hours',expires_at=now()-interval '1 second' where operation_id=$1",
    [id]
  );
  expect((await claim(randomUUID())).some(p => p.operationId === id)).toBe(true);
  expect(
    (
      await db.root(
        'select state,error_code,result_material_id from public.team_operations where id=$1',
        [id]
      )
    )[0]
  ).toEqual({ state: 'failed', error_code: 'PROCESS_RESULT_UNCERTAIN', result_material_id: null });
  expect(
    (
      await db.root<{ revoked: boolean }>(
        'select bool_and(revoked_at is not null) as revoked from private.team_transfer_grants where operation_id=$1',
        [id]
      )
    )[0]!.revoked
  ).toBe(true);
});

it('explains cleanup through the real CLI reader without exposing provider identity or content', async () => {
  const { setQueryExecutor } = await import('../scripts/analytics/db');
  const { getWorkspaceEvidence } = await import('../scripts/analytics/workspace');
  setQueryExecutor((sql, parameters) => db.root(sql, parameters));
  try {
    const evidence = await getWorkspaceEvidence(
      OWNER,
      null,
      new Date(Date.now() + 60000).toISOString()
    );
    expect(evidence.supported).toBe(true);
    expect(
      evidence.operations.some(
        op =>
          op.action === 'process_output_cleanup' &&
          op.state === 'attention' &&
          op.code === 'PROCESS_RESULT_UNCERTAIN'
      )
    ).toBe(true);
    expect(
      evidence.operations.find(
        op => op.action === 'process_output_cleanup' && op.state === 'attention'
      )?.cleanup
    ).toMatchObject({
      upload_state: 'started',
      state: 'attention',
      attempts: 24,
      max_attempts: 24
    });
    const serialized = JSON.stringify(evidence);
    for (const privateValue of ['reserved-', 'original-source', 'own-root', 'out-', CHECKSUM])
      expect(serialized).not.toContain(privateValue);
    await db.root('set role authenticated');
    await expect(db.root('select * from public.analytics_workspace_operations')).rejects.toThrow(
      'permission denied'
    );
  } finally {
    await db.root('reset role');
    setQueryExecutor(null);
  }
});

it('retains explicitly registered output and continues catalog readback for that material', async () => {
  const id = await operation();
  const binding = await prepare(id);
  await start(id);
  await cancel(id);
  // A separate explicit publication can adopt the same provider file. Its
  // material must defeat cleanup, without freezing subsequent catalog updates.
  await db.root(
    "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type,category,size_bytes,checksum) values($1,$2,$3,'own-root','adopted.mp4','file','video/mp4','video',16,$4)",
    [team, connection, binding.fileId, CHECKSUM]
  );
  const owner = randomUUID();
  const plan = (await claim(owner)).find(item => item.operationId === id)!;
  expect(
    (
      await db.root<{ allowed: boolean }>(
        'select public.service_authorize_process_output_cleanup($1,$2,$3) as allowed',
        [id, owner, plan.fence]
      )
    )[0]!.allowed
  ).toBe(false);
  await db.root('select private.upsert_catalog_snapshot($1,null,$2::jsonb,pg_current_snapshot())', [
    connection,
    JSON.stringify([
      {
        drive_file_id: binding.fileId,
        parent_folder_id: 'own-root',
        name: 'adopted-renamed.mp4',
        kind: 'file',
        mime_type: 'video/mp4',
        category: 'video',
        size_bytes: 16,
        checksum: CHECKSUM
      }
    ])
  ]);
  expect(
    (
      await db.root('select name from public.team_materials where drive_file_id=$1', [
        binding.fileId
      ])
    )[0]
  ).toEqual({ name: 'adopted-renamed.mp4' });
});

it('reserves adoption before provider mutation and keeps that fence across expired/uncertain cleanup', async () => {
  const id = await operation();
  const binding = await prepare(id);
  await start(id);
  await cancel(id);
  const owner = randomUUID();
  const plan = (await claim(owner)).find(item => item.operationId === id)!;
  expect(
    (
      await db.root<{ allowed: boolean }>(
        'select public.service_begin_process_output_trash($1,$2,$3) as allowed',
        [id, owner, plan.fence]
      )
    )[0]!.allowed
  ).toBe(true);
  const adopt = () =>
    db.root(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,mime_type) values($1,$2,$3,'late-adoption.mp4','file','video/mp4')",
      [team, connection, binding.fileId]
    );
  await expect(adopt()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await db.root(
    "update private.process_upload_ownership set lease_expires_at=now()-interval '1 second' where operation_id=$1",
    [id]
  );
  await expect(adopt()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await db.root(
    "update private.process_upload_ownership set cleanup_state='waiting',lease_owner=null,lease_expires_at=null where operation_id=$1",
    [id]
  );
  await expect(adopt()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await db.root(
    "update private.process_upload_ownership set cleanup_state='attention' where operation_id=$1",
    [id]
  );
  await expect(adopt()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  // Changing another material's provider ID cannot bypass the insert fence.
  await expect(
    db.root('update public.team_materials set drive_file_id=$2 where id=$1', [
      source,
      binding.fileId
    ])
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});

it('serves actor-scoped ownership and a content-free durable reservation diagnostic', async () => {
  const id = await operation();
  const binding = await prepare(id);
  expect(
    (
      await db.root<{ binding: unknown }>(
        'select public.service_get_process_upload($1,$2) as binding',
        [id, OTHER]
      )
    )[0]!.binding
  ).toBeNull();
  expect(
    (
      await db.root<{ binding: { fileId: string } }>(
        'select public.service_get_process_upload($1,$2) as binding',
        [id, OWNER]
      )
    )[0]!.binding.fileId
  ).toBe(binding.fileId);
  expect(
    (
      await db.root(
        'select provider_mutation_reserved from public.analytics_process_output_cleanup where id=$1',
        [id]
      )
    )[0]
  ).toEqual({ provider_mutation_reserved: false });
  await start(id);
  await cancel(id);
  const owner = randomUUID();
  const plan = (await claim(owner)).find(p => p.operationId === id)!;
  await db.root('select public.service_begin_process_output_trash($1,$2,$3)', [
    id,
    owner,
    plan.fence
  ]);
  expect(
    (
      await db.root(
        'select provider_mutation_reserved from public.analytics_process_output_cleanup where id=$1',
        [id]
      )
    )[0]
  ).toEqual({ provider_mutation_reserved: true });
});

it('dispatches cleanup without catalog work and stops dispatch after a durable terminal outcome', async () => {
  const due = async () =>
    (await db.root<{ due: boolean }>('select private.process_output_cleanup_due() as due'))[0]!.due;
  expect(await due()).toBe(false);
  const id = await operation();
  await prepare(id);
  await start(id);
  await cancel(id);
  expect(await due()).toBe(true);
  const owner = randomUUID();
  expect((await claim(owner)).some(p => p.operationId === id)).toBe(true);
  expect(await due()).toBe(false);
  await db.root(
    "update private.process_upload_ownership set lease_expires_at=clock_timestamp()-interval '1 second',attempts=24 where operation_id=$1",
    [id]
  );
  expect(await due()).toBe(true);
  await claim(owner);
  expect(await due()).toBe(false);
  const abandoned = await operation();
  await prepare(abandoned);
  await db.root(
    'update private.team_transfer_grants set revoked_at=clock_timestamp() where operation_id=$1',
    [abandoned]
  );
  await db.root(
    "update private.process_upload_ownership set created_at=clock_timestamp()-interval '2 hours',handoff_expires_at=clock_timestamp()-interval '1 hour' where operation_id=$1",
    [abandoned]
  );
  expect(await due()).toBe(true);
  await claim(owner);
  expect(await due()).toBe(false);
});

it('keeps unpublished outputs out of the incremental replay path used by catalog-sync', async () => {
  const id = await operation();
  const binding = await prepare(id);
  await start(id);
  await cancel(id);
  const file = {
    drive_file_id: binding.fileId,
    name: `out-${id}.mp4`,
    kind: 'file',
    mime_type: 'video/mp4',
    category: 'video',
    size_bytes: 16,
    checksum: CHECKSUM
  };
  await db.root('select public.service_upsert_catalog_page($1,null,$2::jsonb)', [
    connection,
    JSON.stringify([file])
  ]);
  expect(
    await db.root('select id from public.team_materials where drive_file_id=$1', [binding.fileId])
  ).toEqual([]);
  const adopted = await db.root<{ id: string }>(
    "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,mime_type) values($1,$2,$3,'explicit-adoption.mp4','file','video/mp4') returning id",
    [team, connection, binding.fileId]
  );
  expect(adopted).toHaveLength(1);
});

it('does not count a hidden output as added in a leased incremental replay', async () => {
  const id = await operation();
  const binding = await prepare(id);
  await start(id);
  await cancel(id);
  const job = (
    await db.root<{ id: string }>(
      "insert into private.catalog_sync_jobs(connection_id,job_kind,phase,cursor,folder_queue,requested_folder_id,next_attempt_at) values($1,'user_subtree','initial_scan','{\"changePageToken\":\"test\"}','[\"own-root\"]','own-root',now()) returning id",
      [connection]
    )
  )[0]!;
  await db.root(
    "update private.catalog_sync_jobs set next_attempt_at=now()+interval '1 day' where id<>$1",
    [job.id]
  );
  const lease = (
    await db.root<{ job_id: string; lease_epoch: number }>(
      "select job_id,lease_epoch from public.service_claim_catalog_sync_work('output-fence',1,60)"
    )
  )[0]!;
  expect(lease.job_id).toBe(job.id);
  const rows = [binding.fileId, `ordinary-${randomUUID()}`].map(drive_file_id => ({
    drive_file_id,
    parent_folder_id: 'own-root',
    name: `${drive_file_id}.mp4`,
    kind: 'file',
    mime_type: 'video/mp4',
    category: 'video',
    size_bytes: 16,
    checksum: CHECKSUM
  }));
  await db.root(
    "select public.service_upsert_catalog_page($1,'output-fence',$2,$3,'own-root',$4::jsonb)",
    [lease.job_id, lease.lease_epoch, connection, JSON.stringify(rows)]
  );
  expect(
    (
      await db.root('select files_added,files_updated from private.catalog_sync_jobs where id=$1', [
        job.id
      ])
    )[0]
  ).toEqual({ files_added: 1, files_updated: 0 });
  expect(
    await db.root('select id from public.team_materials where drive_file_id=$1', [binding.fileId])
  ).toEqual([]);
  await db.root(
    "select public.service_upsert_catalog_page($1,'output-fence',$2,$3,'own-root',$4::jsonb)",
    [lease.job_id, lease.lease_epoch, connection, JSON.stringify([rows[0]])]
  );
  expect(
    (
      await db.root('select files_added,files_updated from private.catalog_sync_jobs where id=$1', [
        job.id
      ])
    )[0]
  ).toEqual({ files_added: 1, files_updated: 0 });
});
