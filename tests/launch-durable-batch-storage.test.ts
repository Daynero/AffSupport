import { getInspect } from '../scripts/analytics/queries';
import { getDurableLaunchBatchEvidence } from '../scripts/analytics/launch-batches';
import { setQueryExecutor, assertReadOnlySql } from '../scripts/analytics/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { assignLaunchFixture } from './support/launch-assignment';
import { launchConfig } from './fixtures/launches';
import {
  acceptLaunchBatch,
  recoverLaunchBatchOther,
  recoverLaunchBatchAdmission
} from '../supabase/functions/drive-ops/launch-batch';
import {
  parseDurableLaunchBatch,
  parseDurableLaunchBatchList,
  type LaunchBatchCommand,
  type DurableLaunchBatchList
} from '../packages/shared/src/team/launch-batch';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import type { ServiceRpcClient } from '../supabase/functions/_shared/credentials';
const id = (n: number) => 'c0530000-0000-4000-8000-' + String(n).padStart(12, '0');
const actor = id(1),
  other = id(2),
  material = id(3);
let db: TeamTestDb, team: string, agent: string, buyer: string, offer: string;
const names = new Set([
  'service_claim_launch_batch_admission_recovery',
  'service_retry_launch_batch_admission',
  'service_launch_batch_context',
  'service_accept_launch_batch',
  'service_settle_launch_batch_cancellations',
  'service_list_launch_batch_other_recovery',
  'service_claim_launch_generation',
  'service_publish_launch_batch_other_generation',
  'service_record_launch_batch_other_failure',
  'service_continue_launch_batch_recovery'
]);
const service: ServiceRpcClient = {
  rpc: async (name, args) => {
    if (!names.has(name)) throw Error('Unexpected RPC ' + name);
    const keys = Object.keys(args);
    if (keys.some(key => !/^p_[a-z_]+$/u.test(key))) throw Error('Unexpected argument');
    try {
      return {
        data: (
          await db.root<{ v: unknown }>(
            `select public.${name}(${keys.map((key, index) => `${key}=>$${index + 1}`).join(',')}) v`,
            keys.map(key => args[key])
          )
        )[0]!.v,
        error: null
      };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  }
};
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: actor, email: 'durable-batch@synthetic.invalid' });
  await createUser(db, { id: other, email: 'durable-batch-other@synthetic.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [actor]);
  team = (
    await db.asUser<{ id: string }>(actor, "select id from public.create_team('Synthetic batch')")
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role)values($1,$2,'editor')",
    [team, other]
  );
  const account = (
    await db.root<{ id: string }>(
      "insert into public.team_accounts(team_id,created_by,name)values($1,$2,'g1')returning id",
      [team, actor]
    )
  )[0]!.id;
  agent = (
    await db.root<{ id: string }>(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id)values($1,$2,$3,'1234567892')returning id",
      [team, account, actor]
    )
  )[0]!.id;
  buyer = (
    await db.asUser<{ v: { id: string } }>(
      actor,
      "select public.create_launch_dictionary($1,'buyers','Synthetic buyer','batch-buyer')v",
      [team]
    )
  )[0]!.v.id;
  offer = (
    await db.asUser<{ v: { id: string } }>(
      actor,
      "select public.create_launch_dictionary($1,'offers','Synthetic offer','batch-offer')v",
      [team]
    )
  )[0]!.v.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'batch-google','batch@synthetic.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [actor]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, credential]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,$3,'synthetic-video','root','Video.mp4','file','video','video/mp4',100,repeat('a',32),'1')",
    [material, team, connection]
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});
async function draft() {
  const config = launchConfig({
    agentRowId: agent,
    materialId: material,
    buyerId: buyer,
    offerId: offer
  });
  const key = crypto.randomUUID();
  const saved = (
    await db.asUser<{ v: { id: string } }>(
      actor,
      'select public.save_launch_draft($1,null,null,$2,$3,null)v',
      [team, key, config]
    )
  )[0]!.v;
  const version = await assignLaunchFixture(db, actor, team, saved.id, agent);
  const sources = (
    await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_sources($1,$2)v', [
      team,
      saved.id
    ])
  )[0]!.v;
  const complete = (
    await db.asUser<{ v: { version: string } }>(
      actor,
      'select public.save_launch_draft($1,$2,$3,$4,$5,$6)v',
      [team, saved.id, version, crypto.randomUUID(), config, sources]
    )
  )[0]!.v;
  return {
    launchId: saved.id,
    expectedVersion: complete.version,
    childRequestKey: crypto.randomUUID()
  };
}
const command = (items: LaunchBatchCommand['items']): LaunchBatchCommand => ({
  teamId: team,
  expectedActorId: actor,
  requestKey: crypto.randomUUID(),
  items
});
async function read(key: string) {
  return (
    await db.asUser<{ v: unknown }>(actor, 'select public.get_launch_batch($1,$2)v', [team, key])
  )[0]!.v;
}
async function cancel(key: string) {
  return parseDurableLaunchBatch(
    (
      await db.asUser<{ v: unknown }>(actor, 'select public.cancel_launch_batch($1,$2,$3,$4)v', [
        team,
        key,
        crypto.randomUUID(),
        actor
      ])
    )[0]!.v
  )!;
}
it('atomically persists accepted and refused members and replays the exact intent after edits', async () => {
  const first = await draft(),
    second = await draft();
  const input = command([first, { ...second, expectedVersion: '999999' }]);
  const batch = await acceptLaunchBatch(service, actor, input);
  expect(batch.items.map(item => item.admission)).toEqual(['accepted', 'refused']);
  expect(batch.items[1]!.errorCode).toBe('LAUNCH_VERSION_CONFLICT');
  expect(batch.items[0]!.generation).toMatchObject({
    attemptNo: 1,
    state: 'accepted',
    inputVersion: first.expectedVersion
  });
  expect(batch.items[0]!.generation!.startedAt).toBeTruthy();
  expect(batch.items[0]).toMatchObject({
    offer: 'Synthetic offer',
    social: 'g1',
    agentSuffix: '892'
  });
  expect(parseDurableLaunchBatch(await read(input.requestKey))).toEqual(batch);
  expect(await acceptLaunchBatch(service, actor, input)).toEqual(batch);
  await expect(
    acceptLaunchBatch(service, actor, { ...input, items: [second] })
  ).rejects.toMatchObject({ code: 'REQUEST_REUSE_CONFLICT' });
  expect(
    (
      await db.asUser<{ v: unknown }>(other, 'select public.get_launch_batch($1,$2)v', [
        team,
        input.requestKey
      ])
    )[0]!.v
  ).toBeNull();
  await expect(acceptLaunchBatch(service, other, input)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  await cancel(input.requestKey);
});
it('recovers the same durable batch when acceptance committed but the HTTP reply was lost', async () => {
  const input = command([await draft()]);
  let loseReply = true;
  const ambiguous: ServiceRpcClient = {
    rpc: async (name, args) => {
      const result = await service.rpc(name, args);
      if (name === 'service_accept_launch_batch' && loseReply) {
        loseReply = false;
        return { data: null, error: { message: 'synthetic gateway timeout' } };
      }
      return result;
    }
  };
  await expect(acceptLaunchBatch(ambiguous, actor, input)).rejects.toMatchObject({
    code: 'TEAM_TRANSPORT_UNAVAILABLE'
  });
  const restored = await acceptLaunchBatch(ambiguous, actor, input);
  expect(restored.items[0]!.admission).toBe('accepted');
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from public.team_launch_generations where launch_id=$1',
        [input.items[0]!.launchId]
      )
    )[0]!.n
  ).toBe(1);
  await cancel(input.requestKey);
});
it('continues bounded healthy slices without waking a delayed, leased or unchanged queue', async () => {
  const items: LaunchBatchCommand['items'] = [];
  for (let index = 0; index < 7; index++) items.push(await draft());
  const input = command(items);
  await acceptLaunchBatch(service, actor, input);
  const definition = (
    await db.root<{ body: string }>(
      "select pg_get_functiondef('private.invoke_catalog_updater_worker()'::regprocedure)body"
    )
  )[0]!.body;
  await db.db.exec(`
    create table private.synthetic_batch_wakeups(id bigint generated always as identity);
    create or replace function private.invoke_catalog_updater_worker()returns bigint
    language plpgsql security definer set search_path=''as $$declare result bigint;begin
      insert into private.synthetic_batch_wakeups default values returning id into result;
      return result;
    end$$;
  `);
  const wakeCount = async () =>
    (
      await db.root<{ n: number }>('select count(*)::int n from private.synthetic_batch_wakeups')
    )[0]!.n;
  try {
    // Claim transport failure has made no progress: do not re-dispatch a hot loop.
    const unavailable: ServiceRpcClient = {
      rpc: (name, args) =>
        name === 'service_claim_launch_generation'
          ? Promise.resolve({ data: null, error: { message: 'DRIVE_UNAVAILABLE' } })
          : service.rpc(name, args)
    };
    expect(await recoverLaunchBatchOther(unavailable, async () => {})).toEqual({
      completed: 0,
      pending: 3
    });
    expect(await wakeCount()).toBe(0);
    expect(await recoverLaunchBatchOther(service, async () => {})).toEqual({
      completed: 3,
      pending: 0
    });
    expect(await wakeCount()).toBe(1);
    expect(await recoverLaunchBatchOther(service, async () => {})).toEqual({
      completed: 3,
      pending: 0
    });
    expect(await wakeCount()).toBe(2);
    const last = parseDurableLaunchBatch(await read(input.requestKey))!.items.find(
      item => item.generation!.state === 'accepted'
    )!;
    await db.root(
      "update public.team_launch_generations set next_attempt_at=clock_timestamp()+interval '1 minute'where id=$1",
      [last.generationId]
    );
    expect((await service.rpc('service_continue_launch_batch_recovery', {})).data).toBeNull();
    await db.root(
      "update public.team_launch_generations set next_attempt_at=null,lease_expires_at=clock_timestamp()+interval '1 minute'where id=$1",
      [last.generationId]
    );
    expect((await service.rpc('service_continue_launch_batch_recovery', {})).data).toBeNull();
    expect(await wakeCount()).toBe(2);
    await db.root('update public.team_launch_generations set lease_expires_at=null where id=$1', [
      last.generationId
    ]);
    expect(await recoverLaunchBatchOther(service, async () => {})).toEqual({
      completed: 1,
      pending: 0
    });
    expect(await recoverLaunchBatchOther(service, async () => {})).toEqual({
      completed: 0,
      pending: 0
    });
    expect(await wakeCount()).toBe(2);
  } finally {
    await db.db.exec(definition);
    await cancel(input.requestKey);
  }
});
async function pendingInput(count = 1) {
  const items: LaunchBatchCommand['items'] = [];
  for (let index = 0; index < count; index++) items.push(await draft());
  const input = command(items);
  const unavailable: ServiceRpcClient = {
    rpc: async (name, args) => {
      const result = await service.rpc(name, args);
      if (name === 'service_launch_batch_context' && result.data) {
        const value = result.data as { items: Record<string, unknown>[] };
        return {
          ...result,
          data: { items: value.items.map(item => ({ ...item, errorCode: 'DRIVE_UNAVAILABLE' })) }
        };
      }
      return result;
    }
  };
  return { input, batch: await acceptLaunchBatch(unavailable, actor, input) };
}
async function due(batchId: string) {
  await db.root(
    "update private.launch_batch_items set admission_next_attempt_at=clock_timestamp()-interval '1 second'where batch_id=$1 and admission_pending",
    [batchId]
  );
}
it('isolates SQL preparation outages and automatically admits the original pending child later', async () => {
  const first = await draft(),
    second = await draft();
  await db.db.exec(
    "create table private.synthetic_batch_faults(launch_id uuid primary key);create function private.synthetic_batch_admission_fault()returns trigger language plpgsql as $$begin if exists(select 1 from private.synthetic_batch_faults where launch_id=new.launch_id)then raise exception 'DRIVE_UNAVAILABLE';end if;return new;end$$;create trigger synthetic_batch_admission_fault before insert on public.team_launch_generations for each row execute function private.synthetic_batch_admission_fault();"
  );
  await db.root('insert into private.synthetic_batch_faults values($1)', [first.launchId]);
  const input = command([first, second]),
    batch = await acceptLaunchBatch(service, actor, input);
  expect(batch.items.map(item => item.admission)).toEqual(['pending', 'accepted']);
  expect(batch.items[0]).toMatchObject({
    generation: null,
    errorCode: 'DRIVE_UNAVAILABLE',
    admissionAttempts: 1
  });
  expect(await acceptLaunchBatch(service, actor, input)).toEqual(batch);
  expect(await recoverLaunchBatchOther(service, async () => {})).toEqual({
    completed: 1,
    pending: 0
  });
  await due(batch.id);
  const waiting = await recoverLaunchBatchAdmission(service);
  expect(waiting!.items[0]).toMatchObject({ admission: 'pending', admissionAttempts: 2 });
  expect(Date.parse(waiting!.items[0]!.admissionNextAttemptAt!) - Date.now()).toBeGreaterThan(
    55_000
  );
  await db.root('delete from private.synthetic_batch_faults');
  await due(batch.id);
  const recovered = await recoverLaunchBatchAdmission(service);
  expect(recovered!.items.map(item => item.admission)).toEqual(['accepted', 'accepted']);
  expect(recovered!.items[0]!.generation).toMatchObject({
    requestKey: first.childRequestKey,
    inputVersion: first.expectedVersion
  });
  await cancel(input.requestKey);
});
it('claims at most three pending members and preserves the others for another pass', async () => {
  const { input, batch } = await pendingInput(5);
  await due(batch.id);
  const first = await recoverLaunchBatchAdmission(service);
  expect(first!.items.filter(item => item.admission === 'accepted')).toHaveLength(3);
  expect(first!.items.filter(item => item.admission === 'pending')).toHaveLength(2);
  const second = await recoverLaunchBatchAdmission(service);
  expect(second!.items.every(item => item.admission === 'accepted')).toBe(true);
  await cancel(input.requestKey);
});
it('cancellation during pending preparation fences the late admission reply', async () => {
  const { input, batch } = await pendingInput();
  await due(batch.id);
  const delayed: ServiceRpcClient = {
    rpc: async (name, args) => {
      const result = await service.rpc(name, args);
      if (name === 'service_claim_launch_batch_admission_recovery' && result.data)
        await cancel(input.requestKey);
      return result;
    }
  };
  const canceled = await recoverLaunchBatchAdmission(delayed);
  expect(canceled!.items[0]).toMatchObject({
    admission: 'refused',
    errorCode: 'PROCESS_CANCELED',
    generation: null
  });
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from public.team_launch_generations where launch_id=$1',
        [input.items[0]!.launchId]
      )
    )[0]!.n
  ).toBe(0);
});
it('refuses only the edited or deleted pending member instead of accepting a new version', async () => {
  const { batch } = await pendingInput(2);
  await due(batch.id);
  await db.root(
    'update public.team_launches set aggregate_version=aggregate_version+1 where id=$1',
    [batch.items[0]!.launchId]
  );
  await db.root('update public.team_launches set archived_at=clock_timestamp()where id=$1', [
    batch.items[1]!.launchId
  ]);
  const restored = await recoverLaunchBatchAdmission(service);
  expect(restored!.items.map(item => item.errorCode)).toEqual([
    'LAUNCH_VERSION_CONFLICT',
    'NOT_FOUND'
  ]);
  expect(
    restored!.items.every(item => item.admission === 'refused' && item.generation === null)
  ).toBe(true);
});
it('expires a crashed admission lease and rejects an obsolete worker owner', async () => {
  const { input, batch } = await pendingInput();
  await due(batch.id);
  const first = (await service.rpc('service_claim_launch_batch_admission_recovery', { p_limit: 3 }))
    .data as { owner: string };
  expect(
    (await service.rpc('service_claim_launch_batch_admission_recovery', { p_limit: 3 })).data
  ).toBeNull();
  await db.root(
    "update private.launch_batch_items set admission_lease_expires_at=clock_timestamp()-interval '1 second'where batch_id=$1",
    [batch.id]
  );
  const second = (
    await service.rpc('service_claim_launch_batch_admission_recovery', { p_limit: 3 })
  ).data as { owner: string };
  expect(second.owner).not.toBe(first.owner);
  const stale = await service.rpc('service_retry_launch_batch_admission', {
    p_team: team,
    p_actor: actor,
    p_key: input.requestKey,
    p_intent: input,
    p_owner: first.owner,
    p_prepared: [{ ...input.items[0], errorCode: 'NOT_FOUND' }]
  });
  expect(parseDurableLaunchBatch(stale.data)!.items[0]!.admission).toBe('pending');
  expect(
    (
      await db.root<{ admission_lease_owner: string }>(
        'select admission_lease_owner from private.launch_batch_items where batch_id=$1',
        [batch.id]
      )
    )[0]!.admission_lease_owner
  ).toBe(second.owner);
  await cancel(input.requestKey);
});
it('requires fresh leased source proof and continues siblings after a Google outage', async () => {
  const input = command([await draft(), await draft()]);
  const batch = await acceptLaunchBatch(service, actor, input);
  const first = batch.items[0]!.generationId!,
    second = batch.items[1]!.generationId!;
  const owner = crypto.randomUUID();
  const initial = (
    await service.rpc('service_claim_launch_generation', {
      p_team: team,
      p_actor: actor,
      p_generation: first,
      p_owner: owner
    })
  ).data as { fence: string };
  await db.root('update public.team_launch_generations set lease_expires_at=null where id=$1', [
    first
  ]);
  expect(
    (
      await service.rpc('service_record_launch_batch_other_failure', {
        p_team: team,
        p_actor: actor,
        p_generation: first,
        p_owner: owner,
        p_fence: initial.fence,
        p_code: 'DRIVE_UNAVAILABLE',
        p_transient: true
      })
    ).error?.message
  ).toBe('LEASE_MISMATCH');
  await db.root('update public.team_launch_generations set next_attempt_at=null where id=$1', [
    first
  ]);
  const settled = (
    await db.root<{ v: { completed: number } }>('select public.service_settle_launch_batch(10)v')
  )[0]!.v;
  expect(settled.completed).toBe(0);
  await expect(
    db.root('select public.service_publish_launch_generation($1,$2,$3,$4)', [
      team,
      first,
      actor,
      '1'
    ])
  ).rejects.toThrow('WRONG_STATE');
  let calls = 0;
  const result = await recoverLaunchBatchOther(service, async () => {
    if (calls++ === 0) throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  });
  expect(result).toEqual({ completed: 1, pending: 1 });
  const after = parseDurableLaunchBatch(await read(input.requestKey))!;
  expect(after.items.map(item => item.generation!.state).sort()).toEqual([
    'interrupted',
    'succeeded'
  ]);
  const failed = after.items.find(item => item.generation!.state === 'interrupted')!;
  expect(failed.generation!.errorCode).toBe('DRIVE_UNAVAILABLE');
  await db.root(
    "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 second'where id=$1",
    [failed.generationId]
  );
  expect(await recoverLaunchBatchOther(service, async () => {})).toEqual({
    completed: 1,
    pending: 0
  });
  expect(
    parseDurableLaunchBatch(await read(input.requestKey))!.items.every(
      item => item.generation!.state === 'succeeded'
    )
  ).toBe(true);
  expect([first, second]).toContain(failed.generationId);
});
it('persists a long Google Retry-After across workers while healthy siblings finish', async () => {
  const input = command([await draft(), await draft()]);
  await acceptLaunchBatch(service, actor, input);
  let calls = 0;
  expect(
    await recoverLaunchBatchOther(service, async () => {
      if (calls++ === 0)
        throw new TeamFunctionError('RATE_LIMITED', {
          retryable: true,
          details: { retryAfterMs: 3_600_000 }
        });
    })
  ).toEqual({ completed: 1, pending: 1 });
  const after = parseDurableLaunchBatch(await read(input.requestKey))!;
  const waiting = after.items.find(item => item.generation!.state === 'interrupted')!;
  const remaining = (
    await db.root<{ seconds: number }>(
      'select extract(epoch from next_attempt_at-clock_timestamp())::float8 seconds from public.team_launch_generations where id=$1',
      [waiting.generationId]
    )
  )[0]!.seconds;
  expect(remaining).toBeGreaterThan(3590);
  expect(remaining).toBeLessThanOrEqual(3600);
  // Another scheduled pass and a previously selected stale row both respect the floor.
  expect(
    await recoverLaunchBatchOther(service, async () => {
      calls++;
    })
  ).toEqual({
    completed: 0,
    pending: 0
  });
  expect(calls).toBe(2);
  expect(
    (
      await service.rpc('service_claim_launch_generation', {
        p_team: team,
        p_actor: actor,
        p_generation: waiting.generationId,
        p_owner: crypto.randomUUID()
      })
    ).error?.message
  ).toBe('NO_WORK');
  await db.root(
    "update public.team_launch_generations set next_attempt_at=clock_timestamp()-interval '1 minute'where id=$1",
    [waiting.generationId]
  );
  expect(await recoverLaunchBatchOther(service, async () => {})).toEqual({
    completed: 1,
    pending: 0
  });
});

it('persists isolated terminal source failure while unrelated work completes', async () => {
  const input = command([await draft(), await draft()]);
  await acceptLaunchBatch(service, actor, input);
  let calls = 0;
  expect(
    await recoverLaunchBatchOther(service, async () => {
      if (calls++ === 0) throw new TeamFunctionError('SOURCE_CHANGED');
    })
  ).toEqual({ completed: 1, pending: 1 });
  const after = parseDurableLaunchBatch(await read(input.requestKey))!;
  expect(after.items.map(item => item.generation!.state).sort()).toEqual(['failed', 'succeeded']);
  expect(after.items.find(item => item.generation!.state === 'failed')!.generation!.errorCode).toBe(
    'SOURCE_CHANGED'
  );
  expect(
    await recoverLaunchBatchOther(service, async () => {
      throw Error('Must not retry terminal source');
    })
  ).toEqual({ completed: 0, pending: 0 });
});
it('cancels an archived child and siblings idempotently with the exact actor fence', async () => {
  const input = command([await draft(), await draft()]);
  await acceptLaunchBatch(service, actor, input);
  await db.root('update public.team_launches set archived_at=clock_timestamp()where id=$1', [
    input.items[0]!.launchId
  ]);
  await expect(
    db.asUser(other, 'select public.cancel_launch_batch($1,$2,$3,$4)', [
      team,
      input.requestKey,
      crypto.randomUUID(),
      actor
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
  const canceled = await cancel(input.requestKey);
  expect(canceled.cancelRequestedAt).toBeTruthy();
  expect(canceled.items.every(item => !item.cancelPending && item.cancelErrorCode === null)).toBe(
    true
  );
  expect(
    canceled.items.every(item => ['canceled', 'cancel_requested'].includes(item.generation!.state))
  ).toBe(true);
  expect(await cancel(input.requestKey)).toEqual(canceled);
});
it('uses stable timestamp/id keyset pagination and never exposes another actor batches', async () => {
  const expected = (
    await db.root<{ id: string }>('select id from private.launch_batches order by id desc')
  ).map(row => row.id);
  await db.root("update private.launch_batches set created_at='2026-11-13T10:00:00Z'");
  const ids: string[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  do {
    const value: unknown = (
      await db.asUser<{ v: unknown }>(actor, 'select public.list_launch_batches($1,2,$2,$3)v', [
        team,
        cursor?.createdAt ?? null,
        cursor?.id ?? null
      ])
    )[0]!.v;
    const page: DurableLaunchBatchList = parseDurableLaunchBatchList(value)!;
    expect(page).not.toBeNull();
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toEqual(expected);
  expect(
    (
      await db.asUser<{ v: { items: unknown[] } }>(
        other,
        'select public.list_launch_batches($1)v',
        [team]
      )
    )[0]!.v.items
  ).toEqual([]);
});
it('keeps command payload private while exporting only bounded diagnostic columns', async () => {
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_table_privilege('authenticated','private.launch_batches','SELECT')allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  expect(
    (
      await db.root<{ allowed: boolean }>(
        "select has_table_privilege('authenticated','public.analytics_launch_batches','SELECT')allowed"
      )
    )[0]!.allowed
  ).toBe(false);
  const rows = await db.root<Record<string, unknown>>(
    'select * from public.analytics_launch_batches'
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(Object.keys(rows[0]!)).toEqual([
    'batch_id',
    'team_id',
    'actor_id',
    'request_key',
    'created_at',
    'cancel_requested_at',
    'ordinal',
    'launch_id',
    'child_request_key',
    'generation_id',
    'admission',
    'error_code',
    'cancel_pending',
    'cancel_error_code',
    'cancel_next_attempt_at',
    'admission_attempts',
    'admission_next_attempt_at',
    'member_updated_at',
    'member_count',
    'generation_state',
    'generation_stage',
    'generation_error_code',
    'generation_updated_at',
    'video_set_id',
    'video_state',
    'video_requested_count',
    'video_registered_count',
    'video_updated_at'
  ]);
  const text = JSON.stringify(rows);
  expect(text).not.toContain('Synthetic offer');
  expect(text).not.toContain('example.invalid');
});

it('diagnoses durable pending, refusal and completion through actual SQL receipts and a SELECT-only CLI role', async () => {
  const { input, batch } = await pendingInput(2);
  await db.root(
    'update public.team_launches set aggregate_version=aggregate_version+1 where id=$1',
    [input.items[1]!.launchId]
  );
  await due(batch.id);
  await recoverLaunchBatchAdmission(service);
  await recoverLaunchBatchOther(service, async () => {});
  await db.db.exec(
    'create role durable_batch_diagnostics_reader;grant wishly_analytics_ro to durable_batch_diagnostics_reader;grant usage on schema public to durable_batch_diagnostics_reader;grant select on all tables in schema public to durable_batch_diagnostics_reader;'
  );
  let chain = Promise.resolve();
  const install = () =>
    setQueryExecutor((sql, params) => {
      assertReadOnlySql(sql);
      const task = chain.then(async () => {
        await db.db.exec('begin read only;set local role durable_batch_diagnostics_reader');
        try {
          return (await db.db.query<Record<string, unknown>>(sql, params)).rows;
        } finally {
          await db.db.exec('rollback');
        }
      });
      chain = task.then(
        () => undefined,
        () => undefined
      );
      return task;
    });
  install();
  try {
    const inspected = await getInspect(input.requestKey);
    expect(inspected.found).toBe(true);
    if (!inspected.found) throw Error('Missing durable batch');
    expect(inspected.terminal).toBeNull();
    expect(inspected.stages.missing).toContain('result_visible');
    expect(inspected.durable_launch_batches!.records).toHaveLength(2);
    expect(inspected.durable_launch_batches!.records[0]).toMatchObject({
      batch_id: batch.id,
      team_id: team,
      actor_id: actor,
      request_key: input.requestKey,
      launch_id: input.items[0]!.launchId,
      child_request_key: input.items[0]!.childRequestKey,
      admission: 'accepted',
      generation: { state: 'succeeded' }
    });
    expect(inspected.durable_launch_batches!.records[1]).toMatchObject({
      admission: 'refused',
      error_code: 'LAUNCH_VERSION_CONFLICT',
      generation_id: null
    });
    const child = await getDurableLaunchBatchEvidence(input.items[0]!.childRequestKey);
    expect(child.records).toHaveLength(2);
    expect(child.records[0]!.member_count).toBe(2);
    const text = JSON.stringify(inspected);
    expect(text).not.toContain('Synthetic offer');
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('identity_snapshot');
  } finally {
    await chain;
    setQueryExecutor(null);
  }
  const waiting = await pendingInput();
  install();
  try {
    const evidence = await getDurableLaunchBatchEvidence(waiting.input.requestKey);
    expect(evidence.records[0]).toMatchObject({
      admission: 'pending',
      error_code: 'DRIVE_UNAVAILABLE',
      admission_attempts: 1,
      generation_id: null
    });
    expect(evidence.records[0]!.admission_next_attempt_at).toBeTruthy();
  } finally {
    await chain;
    setQueryExecutor(null);
  }
  await db.root(
    "update private.launch_batches set created_at=clock_timestamp()-interval '1 hour'where id=$1",
    [waiting.batch.id]
  );
  install();
  try {
    const past = await getDurableLaunchBatchEvidence(
      waiting.input.requestKey,
      new Date(Date.now() - 30 * 60_000).toISOString()
    );
    expect(past.records[0]).toMatchObject({
      admission: 'unknown',
      snapshot_at_as_of: 'unknown',
      error_code: null,
      admission_attempts: null
    });
    expect(past.blind_spots.some(message => message.includes('as-of'))).toBe(true);
  } finally {
    await chain;
    setQueryExecutor(null);
  }
  await cancel(waiting.input.requestKey);
});
it('reports missing batch projection explicitly instead of treating silence as no work', async () => {
  setQueryExecutor(async () => []);
  try {
    expect(await getDurableLaunchBatchEvidence(crypto.randomUUID())).toMatchObject({
      supported: false,
      records: [],
      blind_spots: [expect.stringContaining('unavailable')]
    });
    expect(await getInspect(crypto.randomUUID())).toMatchObject({
      found: false,
      durable_launch_batches: {
        supported: false,
        blind_spots: [expect.stringContaining('unavailable')]
      }
    });
  } finally {
    setQueryExecutor(null);
  }
});
