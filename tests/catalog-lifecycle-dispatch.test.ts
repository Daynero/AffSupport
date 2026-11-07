import { getInvestigation } from '../scripts/analytics/investigate';
import { createClient } from '@supabase/supabase-js';
import { resolvePeriod } from '../scripts/analytics/periods';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { getInspect } from '../scripts/analytics/queries';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  materialGroupRequestNonce,
  withOperationFailure
} from '../supabase/functions/_shared/operations';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  applyLibraryGroupMutation,
  parseLibraryGroupIntent
} from '../supabase/functions/_shared/library';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const actor = 'b1510000-0000-4000-8000-000000000001';
const member = 'b1510000-0000-4000-8000-000000000002';
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: actor, email: 'dispatch@test.invalid', displayName: 'Synthetic' });
  await createUser(db, {
    id: member,
    email: 'dispatch-member@test.invalid',
    displayName: 'Synthetic member'
  });
  await db.root('insert into public.admin_users(user_id) values($1)', [actor]);
  await db.root('create role group_diagnostic_reader bypassrls');
  await db.root('grant usage on schema public to group_diagnostic_reader');
  await db.root('grant select on all tables in schema public to group_diagnostic_reader');
}, 60_000);
afterAll(async () => {
  await db?.close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function sqlRpc(name: string, input: Record<string, unknown>) {
  try {
    const calls: Record<string, { sql: string; args: unknown[] }> = {
      service_read_material_group_execution: {
        sql: 'select public.service_read_material_group_execution($1,$2,$3) value',
        args: [input.p_intent, input.p_executor ?? null, input.p_epoch ?? null]
      },
      service_claim_material_group_execution_v2: {
        sql: 'select public.service_claim_material_group_execution_v2($1,$2,$3) value',
        args: [input.p_intent, input.p_executor, input.p_expected_epoch]
      },
      service_begin_material_group_dispatch_v2: {
        sql: 'select public.service_begin_material_group_dispatch_v2($1,$2,$3,$4) value',
        args: [input.p_intent, input.p_executor, input.p_epoch, input.p_material]
      },
      service_checkpoint_material_group_execution_v2: {
        sql: 'select public.service_checkpoint_material_group_execution_v2($1,$2,$3,$4) value',
        args: [input.p_intent, input.p_executor, input.p_epoch, input.p_material]
      },
      service_mark_material_group_execution_reconciling_v2: {
        sql: 'select public.service_mark_material_group_execution_reconciling_v2($1,$2,$3,$4) value',
        args: [input.p_intent, input.p_executor, input.p_epoch, input.p_error_code]
      },
      service_end_material_group_execution_v2: {
        sql: 'select public.service_end_material_group_execution_v2($1,$2,$3,$4,$5) value',
        args: [
          input.p_intent,
          input.p_executor,
          input.p_epoch,
          input.p_not_dispatched,
          input.p_acknowledged
        ]
      },
      service_claim_material_group_execution: {
        sql: 'select public.service_claim_material_group_execution($1,$2) value',
        args: [input.p_intent, input.p_executor]
      },
      service_begin_material_group_dispatch: {
        sql: 'select public.service_begin_material_group_dispatch($1,$2,$3) value',
        args: [input.p_intent, input.p_executor, input.p_material]
      },
      service_checkpoint_material_group_execution: {
        sql: 'select public.service_checkpoint_material_group_execution($1,$2,$3) value',
        args: [input.p_intent, input.p_executor, input.p_material]
      },
      service_end_material_group_execution: {
        sql: 'select public.service_end_material_group_execution($1,$2,$3,$4) value',
        args: [input.p_intent, input.p_executor, input.p_not_dispatched, input.p_acknowledged]
      },
      service_transition_team_operation: {
        sql: 'select public.service_transition_team_operation($1,$2,$3,$4,$5,$6,$7) value',
        args: [
          input.p_operation,
          input.p_state,
          input.p_stage,
          input.p_progress,
          input.p_result_material,
          input.p_error_code,
          input.p_retryable
        ]
      },
      service_mark_material_group_execution_reconciling: {
        sql: 'select public.service_mark_material_group_execution_reconciling($1,$2,$3) value',
        args: [input.p_intent, input.p_executor, input.p_error_code]
      }
    };
    const call = calls[name];
    if (!call) throw new Error('UNEXPECTED_RPC');
    const [reply] = await db.root<{ value: unknown }>(call.sql, call.args);
    return { data: reply.value, error: null };
  } catch (cause) {
    return {
      data: null,
      error: {
        code: 'P0001',
        message: cause instanceof Error ? cause.message : 'Synthetic RPC refusal'
      }
    };
  }
}
const capabilities = {
  canDownload: true,
  canListChildren: true,
  canAddChildren: true,
  canRename: true,
  canMoveItemWithinDrive: true,
  canMoveItemOutOfDrive: true,
  canModifyContent: true,
  canTrash: true,
  canUntrash: true,
  canShare: true
};
function metadata(id: string) {
  return {
    id,
    name: id,
    mimeType: id === 'root' ? 'application/vnd.google-apps.folder' : 'video/mp4',
    size: id === 'root' ? 0 : 10,
    modifiedAt: '2026-11-06T10:00:00Z',
    version: '1',
    checksum: null,
    driveId: null,
    resourceKey: null,
    parents: id === 'root' ? [] : ['root'],
    trashed: false,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities
  };
}
async function fixture(options: { legacy?: boolean; operator?: string } = {}) {
  const operator = options.operator ?? actor;
  const [team] = await db.asUser<{ id: string }>(actor, 'select id from public.create_team($1)', [
    'Synthetic dispatch ' + crypto.randomUUID()
  ]);
  if (operator !== actor)
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
      [team.id, operator]
    );
  const [credential] = await db.root<{ id: string }>(
    "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values($2,'dispatch@test.invalid','https://www.googleapis.com/auth/drive',gen_random_uuid(),$1) returning id",
    [actor, 'dispatch-' + team.id]
  );
  const [connection] = await db.root<{ id: string }>(
    "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Synthetic root','my_drive','connected',now()) returning id",
    [team.id, credential.id]
  );
  const [material] = await db.root<{ id: string }>(
    "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values($1,$2,'source','root','Synthetic.mp4','file','video/mp4') returning id",
    [team.id, connection.id]
  );
  const key = crypto.randomUUID(),
    nonce = options.legacy ? 'request:' + key : await materialGroupRequestNonce(key);
  const start =
    "select * from public.service_start_team_operation($1,$2,'trash',$4,$5,$3,null,null,null,null)";
  const startArgs = [team.id, operator, material.id, key, nonce];
  const [operation] = await db.root<{ operation_id: string }>(start, startArgs);
  await db.root(
    "select public.service_transition_team_operation($1,'running','trashing',25,null,null,false)",
    [operation.operation_id]
  );
  const [replayed] = await db.root(start, startArgs);
  expect(replayed).toMatchObject({
    operation_id: operation.operation_id,
    state: 'running',
    reused: true
  });
  const query =
    "select * from public.service_create_material_lifecycle_intent($1,$2,$3,$4,'trash',null)";
  const args = [team.id, operator, operation.operation_id, material.id];
  const intent = parseLibraryGroupIntent(await db.root(query, args));
  expect(intent).not.toBeNull();
  expect(parseLibraryGroupIntent(await db.root(query, args))).toEqual(intent);
  const drive = {
    getFile: vi.fn(async (id: string) => metadata(id)),
    updateFileMetadata: vi.fn(async (input: { fileId: string; trashed?: boolean }) => ({
      ...metadata(input.fileId),
      trashed: input.trashed ?? false
    }))
  };
  const service = { rpc: sqlRpc };
  const input = { service, drive: drive as never, rootFolderId: 'root', intent: intent! };
  return {
    teamId: team.id,
    materialId: material.id,
    operationId: operation.operation_id,
    intent: intent!,
    key,
    nonce,
    start,
    startArgs,
    drive,
    input
  };
}
async function state(id: string) {
  const [row] = await db.root<{
    execution_protocol: number | null;
    execution_owner: string | null;
    execution_closed: boolean | null;
    dispatch_member: string | null;
    applied_member_ids: string[];
    error_code: string | null;
  }>(
    'select execution_protocol,execution_owner,execution_closed,dispatch_member,applied_member_ids,error_code from private.team_material_group_intents where id=$1',
    [id]
  );
  return row;
}
it('does not dispatch the same SQL-backed lifecycle member twice before its first checkpoint', async () => {
  const f = await fixture(),
    release = deferred(),
    entered = deferred(),
    secondBoundary = deferred();
  f.drive.updateFileMetadata.mockImplementation(async () => {
    entered.resolve();
    if (f.drive.updateFileMetadata.mock.calls.length > 1) secondBoundary.resolve();
    await release.promise;
    return { ...metadata('source'), trashed: true };
  });
  const first = applyLibraryGroupMutation(f.input);
  let second: Promise<void> | undefined;
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error('EXPECTED_DISPATCH');
      })
    ]);
    second = withOperationFailure(f.input.service, f.operationId, () =>
      applyLibraryGroupMutation(f.input)
    );
    void second.then(secondBoundary.resolve, secondBoundary.resolve);
    await secondBoundary.promise;
    expect(f.drive.updateFileMetadata).toHaveBeenCalledTimes(1);
    const [current] = await db.root<{ state: string }>(
      'select state from public.team_operations where id=$1',
      [f.operationId]
    );
    expect(current.state).toBe('running');
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null,
    applied_member_ids: [f.materialId]
  });
});
it('retains uncertain provider dispatch across retries and age without repeating PATCH', async () => {
  const f = await fixture();
  f.drive.updateFileMetadata.mockRejectedValue(new Error('Synthetic lost provider reply'));
  await expect(applyLibraryGroupMutation(f.input)).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: f.materialId,
    applied_member_ids: []
  });
  await db.root(
    "update private.team_material_group_intents set created_at=now()-interval '10 days' where id=$1",
    [f.intent.intentId]
  );
  await expect(applyLibraryGroupMutation(f.input)).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
});
it('can resume the original intent after its own pre-dispatch ACK was lost without issuing an earlier PATCH', async () => {
  const f = await fixture();
  let lost = false;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const reply = await sqlRpc(name, args);
    if (name === 'service_begin_material_group_dispatch_v2' && !lost) {
      lost = true;
      throw new Error('Synthetic reserve ACK loss');
    }
    return reply;
  };
  await expect(applyLibraryGroupMutation({ ...f.input, service: { rpc } })).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(f.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null
  });
  await applyLibraryGroupMutation(f.input);
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
});
it('reconciles a lost checkpoint ACK and completes the same receipt without another provider write', async () => {
  const f = await fixture();
  let lost = false;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const reply = await sqlRpc(name, args);
    if (name === 'service_checkpoint_material_group_execution_v2' && !lost) {
      lost = true;
      throw new Error('Synthetic checkpoint ACK loss');
    }
    return reply;
  };
  await expect(applyLibraryGroupMutation({ ...f.input, service: { rpc } })).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null,
    applied_member_ids: [f.materialId]
  });
  await applyLibraryGroupMutation(f.input);
  const [reply] = await db.root<{ value: { state: string } }>(
    'select public.service_complete_material_group_intent($1) value',
    [f.intent.intentId]
  );
  expect(reply.value.state).toBe('succeeded');
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
});
it('records a known metadata refusal before provider dispatch and permits an explicit retry', async () => {
  const f = await fixture();
  f.drive.getFile.mockRejectedValueOnce(new TeamFunctionError('PERMISSION_DENIED'));
  await expect(applyLibraryGroupMutation(f.input)).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(f.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null
  });
  await applyLibraryGroupMutation(f.input);
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
});
it('does not initialize historical intents as unexecuted and refuses an old executor nonce for a managed operation', async () => {
  const legacy = await fixture({ legacy: true });
  await expect(applyLibraryGroupMutation(legacy.input)).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(legacy.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(await state(legacy.intent.intentId)).toMatchObject({
    execution_protocol: null,
    execution_owner: null,
    execution_closed: null,
    dispatch_member: null
  });
  const managed = await fixture();
  const oldArgs = [...managed.startArgs];
  oldArgs[4] = 'request:' + managed.key;
  await expect(db.root(managed.start, oldArgs)).rejects.toThrow('INVALID_INPUT');
});
it('rechecks the original actor before provider dispatch after a permission change', async () => {
  const f = await fixture({ operator: member });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const reply = await sqlRpc(name, args);
    if (name === 'service_claim_material_group_execution_v2')
      await db.root(
        "update public.team_members set base_role='viewer' where team_id=$1 and user_id=$2",
        [f.teamId, member]
      );
    return reply;
  };
  await expect(applyLibraryGroupMutation({ ...f.input, service: { rpc } })).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(f.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null
  });
});
it('keeps a contradictory provider result uncertain instead of checkpointing it or retrying PATCH', async () => {
  const f = await fixture();
  f.drive.updateFileMetadata.mockResolvedValue(metadata('source'));
  await expect(applyLibraryGroupMutation(f.input)).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(await state(f.intent.intentId)).toMatchObject({
    dispatch_member: f.materialId,
    applied_member_ids: [],
    error_code: 'INVALID_RESPONSE'
  });
  await expect(applyLibraryGroupMutation(f.input)).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
});
it('rejects a mismatched claim response before any provider write', async () => {
  const f = await fixture();
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const reply = await sqlRpc(name, args);
    return name === 'service_claim_material_group_execution_v2' &&
      reply.data &&
      typeof reply.data === 'object'
      ? { ...reply, data: { ...reply.data, intentId: crypto.randomUUID() } }
      : reply;
  };
  await expect(applyLibraryGroupMutation({ ...f.input, service: { rpc } })).rejects.toMatchObject({
    code: 'GROUP_RECONCILING',
    details: { causeCode: 'INVALID_RESPONSE' }
  });
  expect(f.drive.updateFileMetadata).not.toHaveBeenCalled();
});

it('still records a definite operation failure while retaining uncertain results', async () => {
  const f = await fixture();
  const failure = new TeamFunctionError('PERMISSION_DENIED');
  await expect(
    withOperationFailure(f.input.service, f.operationId, async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  const [current] = await db.root<{ state: string; error_code: string }>(
    'select state,error_code from public.team_operations where id=$1',
    [f.operationId]
  );
  expect(current).toMatchObject({ state: 'failed', error_code: 'PERMISSION_DENIED' });
});

it.each([false, true])(
  'settles through the actual lazy Supabase RPC builder (provider failure=%s)',
  async fails => {
    const f = await fixture();
    const calls: string[] = [];
    const service = createClient('http://127.0.0.1:54321', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (url, init) => {
          const name = new URL(String(url)).pathname.split('/').at(-1)!;
          calls.push(name);
          const reply = await sqlRpc(name, JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(reply.error ?? reply.data), {
            status: reply.error ? 400 : 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    });
    if (fails) f.drive.updateFileMetadata.mockRejectedValue(new Error('Synthetic lost reply'));
    const work = applyLibraryGroupMutation({
      ...f.input,
      service
    });
    if (fails) await expect(work).rejects.toMatchObject({ code: 'GROUP_RECONCILING' });
    else await expect(work).resolves.toBeUndefined();
    expect(calls).toContain('service_end_material_group_execution_v2');
    if (fails) expect(calls).toContain('service_mark_material_group_execution_reconciling_v2');
    expect(await state(f.intent.intentId)).toMatchObject({ execution_closed: true });
  }
);

it('reconciles an acknowledged running group without another provider write or a terminal-generation replay', async () => {
  const f = await fixture();
  await applyLibraryGroupMutation({
    ...f.input,
    service: {
      rpc: async (name, args) =>
        name === 'service_end_material_group_execution_v2'
          ? { data: null, error: { code: 'P0001', message: 'Synthetic lost close reply' } }
          : sqlRpc(name, args)
    }
  });
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: false,
    applied_member_ids: [f.materialId]
  });
  // A real catalog sync can observe the provider result before DB completion.
  await db.root(
    "update public.team_materials set lifecycle='trashed',trashed_at=now() where id=$1",
    [f.materialId]
  );
  const args = [f.teamId, actor, f.operationId, f.materialId, 'trash', null];
  const call = 'select public.service_reconcile_confirmed_material_group($1,$2,$3,$4,$5,$6) value';
  const [result] = await db.root<{ value: unknown }>(call, args);
  expect(result.value).toMatchObject({
    operationId: f.operationId,
    materialId: f.materialId,
    state: 'succeeded'
  });
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null
  });
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
  const [late] = await db.root<{ value: boolean }>(
    "select public.service_mark_material_group_reconciling($1,'DRIVE_UNAVAILABLE') value",
    [f.intent.intentId]
  );
  expect(late.value).toBe(false);
  const [material] = await db.root<{ placement_state: string }>(
    'select placement_state from public.team_materials where id=$1',
    [f.materialId]
  );
  expect(material.placement_state).toBe('ready');
  await expect(db.root(call, args)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});

it('finishes the original restore when catalog sync already observed the active file', async () => {
  const f = await fixture();
  await applyLibraryGroupMutation(f.input);
  await db.root('select public.service_complete_material_group_intent($1)', [f.intent.intentId]);
  const key = crypto.randomUUID(),
    nonce = await materialGroupRequestNonce(key);
  const [op] = await db.root<{ operation_id: string }>(
    "select * from public.service_start_team_operation($1,$2,'restore',$4,$5,$3,null,null,null,null)",
    [f.teamId, actor, f.materialId, key, nonce]
  );
  await db.root(
    "select public.service_transition_team_operation($1,'running','restoring',25,null,null,false)",
    [op.operation_id]
  );
  const intent = parseLibraryGroupIntent(
    await db.root(
      "select * from public.service_create_material_lifecycle_intent($1,$2,$3,$4,'restore',null)",
      [f.teamId, actor, op.operation_id, f.materialId]
    )
  );
  expect(intent).not.toBeNull();
  f.drive.getFile.mockImplementation(async id => ({ ...metadata(id), trashed: id === 'source' }));
  await applyLibraryGroupMutation({ ...f.input, intent: intent! });
  await db.root("update public.team_materials set lifecycle='active',trashed_at=null where id=$1", [
    f.materialId
  ]);
  const [result] = await db.root<{ value: unknown }>(
    "select public.service_reconcile_confirmed_material_group($1,$2,$3,$4,'restore',null) value",
    [f.teamId, actor, op.operation_id, f.materialId]
  );
  expect(result.value).toMatchObject({
    operationId: op.operation_id,
    materialId: f.materialId,
    state: 'succeeded'
  });
  expect(f.drive.updateFileMetadata).toHaveBeenCalledTimes(2);
});

it('explains an unconfirmed dispatch through SELECT-only inspect without requiring browser events', async () => {
  const f = await fixture();
  f.drive.updateFileMetadata.mockRejectedValue(new Error('Synthetic lost provider reply'));
  await expect(applyLibraryGroupMutation(f.input)).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  let serial: Promise<unknown> = Promise.resolve();
  setQueryExecutor((sql, args) => {
    const work = serial.then(async () => {
      assertReadOnlySql(sql);
      await db.db.exec('begin read only; set local role group_diagnostic_reader');
      try {
        const result = await db.db.query(sql, args);
        await db.db.exec('commit');
        return result.rows as Record<string, unknown>[];
      } catch (cause) {
        await db.db.exec('rollback');
        throw cause;
      }
    });
    serial = work.catch(() => {});
    return work;
  });
  try {
    const detail = await getInspect(f.operationId, new Date(Date.now() + 60000).toISOString());
    expect(detail).toMatchObject({
      found: true,
      capability: 'team.material_group',
      terminal: null,
      last_proven_stage: 'dispatch_reserved',
      material_groups: {
        supported: true,
        records: [
          expect.objectContaining({
            operation_id: f.operationId,
            state: 'dispatch_unconfirmed',
            claim_protocol: 2,
            execution_epoch: 1,
            member_count: 1,
            confirmed_count: 0,
            has_unconfirmed_dispatch: true
          })
        ]
      }
    });
    const investigation = await getInvestigation(
      actor,
      resolvePeriod('7d', undefined, new Date(Date.now() + 60000).toISOString())
    );
    expect(investigation.findings).toContainEqual(
      expect.objectContaining({
        kind: 'fact',
        evidence: ['material_group:' + f.intent.intentId],
        code_locations: expect.arrayContaining([
          expect.objectContaining({ fingerprint: 'material:group:execution' })
        ])
      })
    );
    expect(investigateOutputIsPrivate(investigation)).toBe(true);
    const encoded = JSON.stringify(detail);
    expect(encoded).not.toContain('Synthetic.mp4');
    expect(encoded).not.toContain('dispatch@test.invalid');
  } finally {
    setQueryExecutor(null);
    await serial;
  }
});

it('does not reactivate a historical executor identity after two positively closed attempts', async () => {
  const f = await fixture(),
    first = crypto.randomUUID(),
    second = crypto.randomUUID(),
    third = crypto.randomUUID(),
    current = crypto.randomUUID();
  const legacy = await sqlRpc('service_claim_material_group_execution', {
    p_intent: f.intent.intentId,
    p_executor: first
  });
  expect(legacy.data).toMatchObject({ acquired: true });
  expect(
    (
      await sqlRpc('service_end_material_group_execution', {
        p_intent: f.intent.intentId,
        p_executor: first,
        p_not_dispatched: null,
        p_acknowledged: null
      })
    ).data
  ).toBe(true);
  const claim = async (executor: string, epoch: number) =>
    sqlRpc('service_claim_material_group_execution_v2', {
      p_intent: f.intent.intentId,
      p_executor: executor,
      p_expected_epoch: epoch
    });
  const close = async (executor: string, epoch: number) =>
    sqlRpc('service_end_material_group_execution_v2', {
      p_intent: f.intent.intentId,
      p_executor: executor,
      p_epoch: epoch,
      p_not_dispatched: null,
      p_acknowledged: null
    });
  expect((await claim(second, 0)).data).toMatchObject({ acquired: true, epoch: 1 });
  expect((await close(second, 1)).data).toBe(true);
  expect((await claim(third, 1)).data).toMatchObject({ acquired: true, epoch: 2 });
  expect((await close(third, 2)).data).toBe(true);
  expect((await claim(second, 0)).data).toMatchObject({ acquired: false });
  expect(
    (
      await sqlRpc('service_claim_material_group_execution', {
        p_intent: f.intent.intentId,
        p_executor: first
      })
    ).data
  ).toMatchObject({ acquired: false });
  expect((await claim(current, 2)).data).toMatchObject({ acquired: true, epoch: 3 });
  expect((await close(second, 1)).data).toBe(false);
  expect(
    (
      await sqlRpc('service_end_material_group_execution', {
        p_intent: f.intent.intentId,
        p_executor: first,
        p_not_dispatched: null,
        p_acknowledged: null
      })
    ).data
  ).toBe(false);
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_owner: current,
    execution_closed: false
  });
  expect(f.drive.updateFileMetadata).not.toHaveBeenCalled();
});

it('reads back a committed lifecycle claim after lost acknowledgement without another mutation', async () => {
  const f = await fixture();
  let loseReply = true;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const reply = await sqlRpc(name, args);
    if (name === 'service_claim_material_group_execution_v2' && loseReply && reply.error === null) {
      loseReply = false;
      return {
        data: null,
        error: { code: 'P0001', message: 'Synthetic lost claim acknowledgement' }
      };
    }
    return reply;
  });
  await expect(
    applyLibraryGroupMutation({ ...f.input, service: { rpc } })
  ).resolves.toBeUndefined();
  expect(
    rpc.mock.calls.filter(([name]) => name === 'service_claim_material_group_execution_v2')
  ).toHaveLength(1);
  expect(
    rpc.mock.calls.filter(([name]) => name === 'service_read_material_group_execution')
  ).toHaveLength(2);
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null,
    applied_member_ids: [f.materialId]
  });
});

async function epochClaim(f: Awaited<ReturnType<typeof fixture>>, executor: string, epoch: number) {
  return sqlRpc('service_claim_material_group_execution_v2', {
    p_intent: f.intent.intentId,
    p_executor: executor,
    p_expected_epoch: epoch
  });
}
it('does not clear an unconfirmed PATCH when the owner closes or another claim arrives', async () => {
  const f = await fixture(),
    executor = crypto.randomUUID();
  expect((await epochClaim(f, executor, 0)).data).toMatchObject({ acquired: true, epoch: 1 });
  expect(
    (
      await sqlRpc('service_begin_material_group_dispatch_v2', {
        p_intent: f.intent.intentId,
        p_executor: executor,
        p_epoch: 1,
        p_material: f.materialId
      })
    ).data
  ).toBe(true);
  expect(
    (
      await sqlRpc('service_end_material_group_execution_v2', {
        p_intent: f.intent.intentId,
        p_executor: executor,
        p_epoch: 1,
        p_not_dispatched: null,
        p_acknowledged: null
      })
    ).data
  ).toBe(true);
  expect((await epochClaim(f, crypto.randomUUID(), 1)).data).toMatchObject({
    acquired: false,
    hasPendingDispatch: true
  });
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_owner: executor,
    execution_closed: true,
    dispatch_member: f.materialId,
    applied_member_ids: []
  });
});
it('fences every old callback even when the executor UUID is reused in a newer epoch', async () => {
  const f = await fixture(),
    executor = crypto.randomUUID();
  expect((await epochClaim(f, executor, 0)).data).toMatchObject({ acquired: true });
  expect((await epochClaim(f, executor, 1)).data).toMatchObject({ acquired: true, epoch: 2 });
  expect(
    (
      await sqlRpc('service_begin_material_group_dispatch_v2', {
        p_intent: f.intent.intentId,
        p_executor: executor,
        p_epoch: 2,
        p_material: f.materialId
      })
    ).data
  ).toBe(true);
  for (const [name, extra] of [
    [
      'service_end_material_group_execution_v2',
      { p_not_dispatched: f.materialId, p_acknowledged: null }
    ],
    ['service_checkpoint_material_group_execution_v2', { p_material: f.materialId }],
    ['service_mark_material_group_execution_reconciling_v2', { p_error_code: 'DRIVE_UNAVAILABLE' }]
  ] as const)
    expect(
      (
        await sqlRpc(name, {
          p_intent: f.intent.intentId,
          p_executor: executor,
          p_epoch: 1,
          ...extra
        })
      ).data
    ).toBe(false);
  expect(
    (
      await sqlRpc('service_end_material_group_execution', {
        p_intent: f.intent.intentId,
        p_executor: executor,
        p_not_dispatched: f.materialId,
        p_acknowledged: null
      })
    ).data
  ).toBe(false);
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: false,
    dispatch_member: f.materialId,
    error_code: null
  });
});
it('can close already issued work after cancellation without reviving its parent', async () => {
  const f = await fixture(),
    executor = crypto.randomUUID();
  expect((await epochClaim(f, executor, 0)).data).toMatchObject({ acquired: true });
  expect(
    (
      await sqlRpc('service_begin_material_group_dispatch_v2', {
        p_intent: f.intent.intentId,
        p_executor: executor,
        p_epoch: 1,
        p_material: f.materialId
      })
    ).data
  ).toBe(true);
  await db.root(
    "update public.team_operations set state='canceled',stage='canceled',finished_at=now() where id=$1",
    [f.operationId]
  );
  expect(
    (
      await sqlRpc('service_checkpoint_material_group_execution_v2', {
        p_intent: f.intent.intentId,
        p_executor: executor,
        p_epoch: 1,
        p_material: f.materialId
      })
    ).data
  ).toBe(true);
  expect(
    (
      await sqlRpc('service_end_material_group_execution_v2', {
        p_intent: f.intent.intentId,
        p_executor: executor,
        p_epoch: 1,
        p_not_dispatched: null,
        p_acknowledged: null
      })
    ).data
  ).toBe(true);
  expect((await epochClaim(f, crypto.randomUUID(), 1)).error).not.toBeNull();
  expect(
    (
      await db.root<{ state: string }>('select state from public.team_operations where id=$1', [
        f.operationId
      ])
    )[0]?.state
  ).toBe('canceled');
});
it('never repeats claim mutation when both its acknowledgement and exact readback are lost', async () => {
  const f = await fixture();
  let lost = false;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'service_read_material_group_execution' && args.p_executor)
      throw Error('Synthetic readback loss');
    const reply = await sqlRpc(name, args);
    if (name === 'service_claim_material_group_execution_v2' && !lost) {
      lost = true;
      throw Error('Synthetic claim acknowledgement loss');
    }
    return reply;
  });
  await expect(applyLibraryGroupMutation({ ...f.input, service: { rpc } })).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(
    rpc.mock.calls.filter(([name]) => name === 'service_claim_material_group_execution_v2')
  ).toHaveLength(1);
  expect(f.drive.getFile).not.toHaveBeenCalled();
  expect(f.drive.updateFileMetadata).not.toHaveBeenCalled();
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_closed: true,
    dispatch_member: null
  });
});
it('does not borrow a competing epoch after its context read', async () => {
  const f = await fixture(),
    other = crypto.randomUUID();
  let changed = false;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const reply = await sqlRpc(name, args);
    if (name === 'service_read_material_group_execution' && !args.p_executor && !changed) {
      changed = true;
      expect((await epochClaim(f, other, 0)).data).toMatchObject({ acquired: true });
    }
    return reply;
  };
  await expect(applyLibraryGroupMutation({ ...f.input, service: { rpc } })).rejects.toMatchObject({
    code: 'GROUP_RECONCILING'
  });
  expect(f.drive.getFile).not.toHaveBeenCalled();
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_owner: other,
    execution_closed: false
  });
});
it('keeps versioned execution RPCs and internal cores inaccessible to browser roles', async () => {
  const publicFunctions = await db.root<{ browser: boolean; service: boolean }>(
    `select has_function_privilege('authenticated',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('service_read_material_group_execution','service_claim_material_group_execution_v2','service_begin_material_group_dispatch_v2','service_checkpoint_material_group_execution_v2','service_mark_material_group_execution_reconciling_v2','service_end_material_group_execution_v2')`
  );
  expect(publicFunctions).toHaveLength(6);
  expect(publicFunctions.every(r => !r.browser && r.service)).toBe(true);
  const privateFunctions = await db.root<{ allowed: boolean }>(
    `select has_function_privilege('service_role',p.oid,'execute') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and (p.proname like '%_epoch_core' or p.proname in('lock_material_group_claim','material_group_claim_receipt','material_group_epoch_matches','guard_material_group_claim_epoch','claim_material_group_execution_legacy_core'))`
  );
  expect(privateFunctions).toHaveLength(9);
  expect(privateFunctions.every(r => !r.allowed)).toBe(true);
});

it('retains the original target snapshot while context read is awaiting', async () => {
  const f = await fixture();
  const mutable = { ...f.input, intent: structuredClone(f.intent) };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const reply = await sqlRpc(name, args);
    if (name === 'service_read_material_group_execution' && !args.p_executor) {
      mutable.intent.intentId = crypto.randomUUID();
      mutable.intent.sourceMaterialId = crypto.randomUUID();
      mutable.intent.members[0]!.driveFileId = 'foreign-provider-target';
      mutable.rootFolderId = 'foreign-root';
    }
    return reply;
  };
  await expect(
    applyLibraryGroupMutation({ ...mutable, service: { rpc } })
  ).resolves.toBeUndefined();
  expect(f.drive.updateFileMetadata).toHaveBeenCalledOnce();
  expect(f.drive.updateFileMetadata.mock.calls[0]?.[0].fileId).toBe('source');
  expect(
    f.drive.getFile.mock.calls.some(
      ([id]) => id === 'foreign-provider-target' || id === 'foreign-root'
    )
  ).toBe(false);
});
it('never downgrades or resets an adopted execution epoch', async () => {
  const f = await fixture(),
    executor = crypto.randomUUID();
  expect((await epochClaim(f, executor, 0)).data).toMatchObject({ acquired: true });
  await expect(
    db.root('update private.team_material_group_intents set execution_epoch=0 where id=$1', [
      f.intent.intentId
    ])
  ).rejects.toThrow('GROUP_RECONCILING');
  await expect(
    db.root(
      'update private.team_material_group_intents set execution_claim_protocol=1 where id=$1',
      [f.intent.intentId]
    )
  ).rejects.toThrow('GROUP_RECONCILING');
  await expect(
    db.root('update private.team_material_group_intents set execution_owner=$2 where id=$1', [
      f.intent.intentId,
      crypto.randomUUID()
    ])
  ).rejects.toThrow('GROUP_RECONCILING');
  expect(
    (await epochClaim(f, crypto.randomUUID(), Number.MAX_SAFE_INTEGER)).error?.message
  ).toContain('INVALID_INPUT');
  expect(await state(f.intent.intentId)).toMatchObject({
    execution_owner: executor,
    execution_closed: false
  });
});
