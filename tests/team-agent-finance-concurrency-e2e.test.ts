import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';

// This suite is deliberately part of the release/e2e gate, not a silently
// skipped unit test. Only loopback PostgreSQL is permitted, even with an env URL.
const connectionString =
  process.env.FINANCE_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const destination = new URL(connectionString);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname))
  throw new Error('FINANCE_TEST_DATABASE_MUST_BE_LOCAL');
const options = {
  connectionString,
  connectionTimeoutMillis: 5000,
  application_name: 'finance-concurrency-tests'
};
const root = new pg.Client(options);
const a = new pg.Client(options);
const b = new pg.Client(options);
const owner = randomUUID();
const team = randomUUID();
const account = randomUUID();
let bPid = 0;
let seeded = false;
beforeAll(async () => {
  try {
    await Promise.all([root.connect(), a.connect(), b.connect()]);
  } catch {
    throw new Error(
      'LOCAL_POSTGRES_UNAVAILABLE: start a healthy local Supabase stack; this suite does not fall back to PGlite'
    );
  }
  const schema = await root.query(
    "select to_regprocedure('public.set_team_agent_finance_value(uuid,uuid,date,text,text,text,text,uuid,uuid)') as rpc"
  );
  if (!schema.rows[0]?.rpc) throw new Error('FINANCE_LOCAL_MIGRATIONS_REQUIRED');
  await root.query('begin');
  try {
    await root.query(
      "insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values($1,'authenticated','authenticated',$2,'{}','{}')",
      [owner, `${owner}@finance-concurrency.test`]
    );
    await root.query('insert into public.admin_users(user_id) values($1)', [owner]);
    await root.query('insert into public.teams(id,name,owner_id) values($1,$2,$3)', [
      team,
      'Finance concurrency fixture',
      owner
    ]);
    await root.query(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin')",
      [team, owner]
    );
    await root.query(
      'insert into public.team_accounts(id,team_id,name,created_by) values($1,$2,$3,$4)',
      [account, team, 'Concurrency account', owner]
    );
    await root.query('commit');
    seeded = true;
  } catch (error) {
    await root.query('rollback');
    throw error;
  }
  bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
}, 30000);
afterAll(async () => {
  for (const client of [a, b]) {
    try {
      await client.query('rollback');
    } catch {
      /* A failed connection has nothing to roll back. */
    }
  }
  if (seeded) {
    await root.query('delete from public.teams where id=$1', [team]);
    await root.query('delete from auth.users where id=$1', [owner]);
  }
  await Promise.all([root.end(), a.end(), b.end()]);
});
async function editor(client: pg.Client) {
  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await client.query("set local statement_timeout='10s'");
}
async function agent() {
  await editor(a);
  const result = await a.query("select public.add_team_account_agent($1,$2,$3)->>'id' as id", [
    team,
    account,
    randomUUID()
  ]);
  await a.query('commit');
  const id = result.rows[0].id;
  await root.query(
    "update public.team_agent_placements set starts_on='2026-01-01' where agent_row_id=$1",
    [id]
  );
  return id as string;
}
async function write(client: pg.Client, id: string, metric: string, value: string, version = '0') {
  const placement = (
    await root.query(
      'select id from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [id]
    )
  ).rows[0].id;
  return client.query(
    'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
    [team, id, '2026-09-10', metric, value, version, 'UTC', randomUUID(), placement]
  );
}
async function blocked() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await root.query('select wait_event_type from pg_stat_activity where pid=$1', [
      bPid
    ]);
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await delay(20);
  }
  throw new Error('SECOND_SESSION_DID_NOT_WAIT_FOR_LOCK');
}
it('serializes competing same-metric writes and rejects the stale version', async () => {
  const id = await agent();
  await editor(a);
  await editor(b);
  await write(a, id, 'spend', '10.00');
  const second = write(b, id, 'spend', '20.00').then(
    () => null,
    error => error as Error
  );
  await blocked();
  await a.query('commit');
  expect((await second)?.message).toContain('FINANCE_CONFLICT');
  await b.query('rollback');
  expect(
    (
      await root.query(
        'select count(*)::int as n from public.team_agent_finance_events where agent_row_id=$1',
        [id]
      )
    ).rows[0].n
  ).toBe(1);
});
it('preserves concurrent changes to different metrics', async () => {
  const id = await agent();
  await editor(a);
  await editor(b);
  await write(a, id, 'balance', '70.00');
  const second = write(b, id, 'topup', '200.00');
  await blocked();
  await a.query('commit');
  await second;
  await b.query('commit');
  expect(
    (
      await root.query(
        'select count(*)::int as n from public.team_agent_finance_values where agent_row_id=$1',
        [id]
      )
    ).rows[0].n
  ).toBe(2);
});
it('does not let a concurrent delete erase a committed financial write', async () => {
  const id = await agent();
  await editor(a);
  await editor(b);
  await write(a, id, 'spend', '12.34');
  const deletion = b.query('select public.delete_team_account_agent($1,$2)', [team, id]).then(
    () => null,
    error => error as Error
  );
  await blocked();
  await a.query('commit');
  expect((await deletion)?.message).toContain('FINANCE_HISTORY_PROTECTED');
  await b.query('rollback');
  expect(
    (await root.query('select id from public.team_account_agents where id=$1', [id])).rowCount
  ).toBe(1);
});
