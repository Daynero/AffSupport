import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
const OWNER = '47000000-0000-4000-8000-000000000001';
const ADMIN = '47000000-0000-4000-8000-000000000002';
let db: TeamTestDb;
let team: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner@retention.test' });
  await createUser(db, { id: ADMIN, email: 'admin@retention.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [ADMIN]);
  const tariffs = await db.asUser<{ id: string }>(
    ADMIN,
    "select public.admin_grant_space_tariff('owner@retention.test','lead',private.kyiv_today()+30,0)->>'id' id"
  );
  const tariff = tariffs[0]!.id;
  team = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Synthetic retention')"
    )
  )[0]!.id;
  // Keep recovery dispatch from starting fixture work. Only retention is exercised here.
  await db.asUser(ADMIN, 'select public.admin_end_space_tariff($1,true)', [tariff]);
}, 60_000);
afterAll(async () => db?.close());
async function history(days: number, parent: string, child: string) {
  const pause = randomUUID(),
    recovery = randomUUID(),
    item = randomUUID();
  await db.root(
    `insert into private.workspace_pauses(id,team_id,state,captured_at) values($1,$2,'recovery_registered',clock_timestamp()-($3::int*interval '1 day'))`,
    [pause, team, days]
  );
  await db.root(
    `insert into private.workspace_pause_items(id,pause_id,team_id,kind,resource_id,actor_id)
    values($1,$2,$3,'catalog_schedule',$4,$5)`,
    [item, pause, team, randomUUID(), OWNER]
  );
  await db.root(
    `insert into private.workspace_recoveries(id,pause_id,team_id,epoch,state,registered_at,last_progress_at)
    select $1,id,team_id,epoch,$3,clock_timestamp()-($4::int*interval '1 day'),clock_timestamp()-($4::int*interval '1 day') from private.workspace_pauses where id=$2`,
    [recovery, pause, parent, days]
  );
  await db.root(
    `insert into private.workspace_recovery_items(recovery_id,pause_item_id,team_id,state,stage,updated_at)
    values($1,$2,$3,$4,'terminal',clock_timestamp()-($5::int*interval '1 day'))`,
    [recovery, item, team, child, days]
  );
  return pause;
}
async function exists(id: string) {
  return (
    await db.root<{ present: boolean }>(
      'select exists(select 1 from private.workspace_pauses where id=$1) present',
      [id]
    )
  )[0]!.present;
}
it('retains recent terminals and old unresolved dependencies while pruning eligible old terminals', async () => {
  const recent = await history(29, 'completed', 'completed');
  const old = await history(31, 'completed', 'completed');
  const waiting = await history(45, 'waiting_dependency', 'waiting_dependency');
  const unfinishedChild = await history(45, 'completed', 'pending');
  const supersededButLeased = await history(45, 'superseded', 'leased');
  const superseded = await history(45, 'superseded', 'superseded');
  await db.root('select private.sweep_workspace_recovery()');
  expect(await exists(recent)).toBe(true);
  expect(await exists(old)).toBe(false);
  expect(await exists(waiting)).toBe(true);
  expect(await exists(unfinishedChild)).toBe(true);
  expect(await exists(supersededButLeased)).toBe(true);
  expect(await exists(superseded)).toBe(false);
});
it('bounds terminal history cleanup per sweep and makes progress on the next sweep', async () => {
  const pauses: string[] = [];
  for (let i = 0; i < 101; i++) pauses.push(await history(45, 'completed', 'completed'));
  const count = async () =>
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from private.workspace_pauses where id=any($1::uuid[])',
        [pauses]
      )
    )[0]!.n;
  await db.root('select private.sweep_workspace_recovery()');
  const remaining = await count();
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(101);
  await db.root('select private.sweep_workspace_recovery()');
  expect(await count()).toBeLessThan(remaining);
});
it('bounds expired credential, enrollment, receipt and rate bucket cleanup without deleting live credentials', async () => {
  const delegation = randomUUID();
  await db.root(
    `insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash)
    values($1,$2,$3,gen_random_uuid(),decode(repeat('ab',32),'hex'))`,
    [delegation, team, OWNER]
  );
  await db.root(
    `insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)
    select decode(lpad(to_hex(i),64,'0'),'hex'),$1,1,'claim',clock_timestamp()-interval '1 day' from generate_series(1,101) i`,
    [delegation]
  );
  await db.root(
    `insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)
    values(decode(repeat('ef',32),'hex'),$1,1,'claim',clock_timestamp()+interval '1 day')`,
    [delegation]
  );
  await db.root(
    `insert into private.team_recovery_enrollments(team_id,actor_id,installation_id,ticket_hash,expires_at)
    select $1,$2,gen_random_uuid(),decode(repeat('cd',32),'hex'),clock_timestamp()-interval '1 day' from generate_series(1,101)`,
    [team, OWNER]
  );
  await db.root(
    `insert into private.team_recovery_claim_receipts(delegation_id,request_id,created_at)
    select $1,gen_random_uuid(),clock_timestamp()-interval '31 days' from generate_series(1,101)`,
    [delegation]
  );
  await db.root(`insert into private.team_recovery_rate_buckets(installation_id,minute,kind,count)
    select gen_random_uuid(),clock_timestamp()-interval '1 day','claim',1 from generate_series(1,101)`);
  await db.root('select private.sweep_workspace_recovery()');
  const count = async (table: string) =>
    (await db.root<{ n: number }>(`select count(*)::int n from private.${table}`))[0]!.n;
  expect(await count('team_recovery_credentials')).toBeGreaterThan(1);
  for (const table of [
    'team_recovery_enrollments',
    'team_recovery_claim_receipts',
    'team_recovery_rate_buckets'
  ]) {
    expect(await count(table)).toBeGreaterThan(0);
    expect(await count(table)).toBeLessThan(101);
  }
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from private.team_recovery_credentials where expires_at>clock_timestamp()'
      )
    )[0]!.n
  ).toBe(1);
});
it('bounds expired rotation response cleanup and preserves a live response with its pointer', async () => {
  const ids = (
    await db.root<{ id: string }>(`insert into vault.secrets(secret,name,description)
    select 'synthetic-retention-response',gen_random_uuid()::text,'synthetic' from generate_series(1,102) returning id`)
  ).map(row => row.id);
  const live = ids[101]!;
  await db.root(
    `insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash,rotation_secret_id,rotation_replay_until)
    select $1,$2,gen_random_uuid(),decode(md5(id::text)||md5(id::text),'hex'),id,
      case when id=$4::uuid then clock_timestamp()+interval '1 day' else clock_timestamp()-interval '1 day' end
    from unnest($3::uuid[]) id`,
    [team, OWNER, ids, live]
  );
  const remaining = async () =>
    (
      await db.root<{ id: string }>(
        'select id from vault.secrets where id=any($1::uuid[]) order by id',
        [ids]
      )
    ).map(row => row.id);
  await db.root('select private.sweep_workspace_recovery()');
  expect(await remaining()).toHaveLength(2);
  expect(await remaining()).toContain(live);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from private.team_recovery_delegations where rotation_secret_id=any($1::uuid[])',
        [ids]
      )
    )[0]!.n
  ).toBe(2);
  await db.root('select private.sweep_workspace_recovery()');
  expect(await remaining()).toEqual([live]);
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from private.team_recovery_delegations where rotation_secret_id=$1',
        [live]
      )
    )[0]!.n
  ).toBe(1);
});
it('rolls back receipt detachment when deleting its Vault response fails', async () => {
  const delegation = randomUUID(),
    request = randomUUID();
  const secret = (
    await db.root<{ id: string }>(
      "select vault.create_secret('synthetic-retention-response','retention-rollback','synthetic') id"
    )
  )[0]!.id;
  await db.root(
    `insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash)
    values($1,$2,$3,gen_random_uuid(),decode(md5(($1::uuid)::text)||md5(($1::uuid)::text),'hex'))`,
    [delegation, team, OWNER]
  );
  await db.root(
    `insert into private.team_recovery_claim_receipts(delegation_id,request_id,response_secret_id,created_at)
    values($1,$2,$3,clock_timestamp()-interval '31 days')`,
    [delegation, request, secret]
  );
  await db.root(`create function private.retention_test_refuse_secret_delete() returns trigger language plpgsql as $$
    begin if old.id='${secret}'::uuid then raise exception 'SYNTHETIC_DELETE_FAILURE';end if;return old;end $$`);
  await db.root(
    'create trigger retention_test_refuse_delete before delete on vault.secrets for each row execute function private.retention_test_refuse_secret_delete()'
  );
  try {
    await expect(db.root('select private.sweep_workspace_recovery()')).rejects.toThrow(
      /SYNTHETIC_DELETE_FAILURE/u
    );
    expect(
      (
        await db.root<{ n: number }>(
          'select count(*)::int n from private.team_recovery_claim_receipts where delegation_id=$1 and request_id=$2',
          [delegation, request]
        )
      )[0]!.n
    ).toBe(1);
    expect(
      (
        await db.root<{ n: number }>('select count(*)::int n from vault.secrets where id=$1', [
          secret
        ])
      )[0]!.n
    ).toBe(1);
  } finally {
    await db.root('drop trigger retention_test_refuse_delete on vault.secrets');
    await db.root('drop function private.retention_test_refuse_secret_delete()');
  }
  await db.root('select private.sweep_workspace_recovery()');
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from private.team_recovery_claim_receipts where delegation_id=$1 and request_id=$2',
        [delegation, request]
      )
    )[0]!.n
  ).toBe(0);
  expect(
    (
      await db.root<{ n: number }>('select count(*)::int n from vault.secrets where id=$1', [
        secret
      ])
    )[0]!.n
  ).toBe(0);
});
