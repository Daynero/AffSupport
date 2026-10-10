import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { financeFixture, FINANCE_OWNER } from './support/team-agent-finance';
let f: Awaited<ReturnType<typeof financeFixture>>;
beforeEach(async () => {
  f = await financeFixture();
}, 60000);
afterEach(async () => {
  await f?.db.close();
});
it('allows deleting a transferred agent with no financial history', async () => {
  const p = (
    await f.db.root<{ id: string; version: string }>(
      'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [f.agent]
    )
  )[0]!;
  await f.db.asUser(
    FINANCE_OWNER,
    'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)',
    [f.team, f.agent, f.accounts[1], '2026-09-15', p.id, p.version, 'UTC', randomUUID()]
  );
  await f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account($1,$2)', [
    f.team,
    f.accounts[0]
  ]);
  expect(
    await f.db.root('select account_id from public.team_account_agents where id=$1', [f.agent])
  ).toEqual([{ account_id: f.accounts[1] }]);
  expect(
    (
      await f.db.root<{ tags: { account_name: string }[] }>(
        'select private.team_task_agent_tags($1) as tags',
        [f.task]
      )
    )[0]!.tags[0]!.account_name
  ).toBe('X');
  await f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account_agent($1,$2)', [
    f.team,
    f.agent
  ]);
  expect(
    await f.db.root('select id from public.team_account_agents where id=$1', [f.agent])
  ).toHaveLength(0);
  expect(
    await f.db.root('select id from public.team_agent_transfer_events where agent_row_id=$1', [
      f.agent
    ])
  ).toHaveLength(0);
});
it('moves every sum the agent ever had to the new social account', async () => {
  await f.db.asUser(
    FINANCE_OWNER,
    'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on)))',
    [f.team, f.agent, '2026-09-10', 'spend', '40.00', '0', 'UTC', randomUUID()]
  );
  const p = (
    await f.db.root<{ id: string; version: string }>(
      'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [f.agent]
    )
  )[0]!;
  await f.db.asUser(
    FINANCE_OWNER,
    'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)',
    [f.team, f.agent, f.accounts[1], '2026-09-15', p.id, p.version, 'UTC', randomUUID()]
  );
  // Money recorded before the move now counts under the new social account.
  for (const table of ['team_agent_finance_values', 'team_agent_finance_events'])
    expect(
      await f.db.root(`select account_id from public.${table} where agent_row_id=$1`, [f.agent])
    ).toEqual([{ account_id: f.accounts[1] }]);
  const report = (
    await f.db.asUser<{ result: { placements: { accountId: string }[] } }>(
      FINANCE_OWNER,
      'select public.get_team_agent_finance($1,$2,$3,$4) as result',
      [f.team, '2026-09-01', '2026-09-30', 'UTC']
    )
  )[0]!.result;
  expect(report.placements.map(place => place.accountId)).toEqual([f.accounts[1]]);
  // A later write on an earlier day lands on the new account too.
  await f.db.asUser(
    FINANCE_OWNER,
    'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on)))',
    [f.team, f.agent, '2026-09-01', 'topup', '5', '0', 'UTC', randomUUID()]
  );
  expect(
    await f.db.root(
      "select account_id from public.team_agent_finance_values where agent_row_id=$1 and metric='topup'",
      [f.agent]
    )
  ).toEqual([{ account_id: f.accounts[1] }]);
  // The former social account holds nothing any more; the new one is protected.
  await expect(
    f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account($1,$2)', [f.team, f.accounts[1]])
  ).rejects.toThrow(/FINANCE_HISTORY_PROTECTED/);
  await f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account($1,$2)', [
    f.team,
    f.accounts[0]
  ]);
  // The audit still names where the agent came from, after that account is gone.
  const history = (
    await f.db.asUser<{ result: { transfers: { from_account: string; to_account: string }[] } }>(
      FINANCE_OWNER,
      'select public.list_team_agent_finance_history($1,$2,null,50) as result',
      [f.team, f.agent]
    )
  )[0]!.result;
  expect(history.transfers).toEqual([
    expect.objectContaining({ from_account: 'X', to_account: 'Y' })
  ]);
});
it('rejects invalid targets and ID collisions, ignores dates and history, retries a move exactly once', async () => {
  const p = (
    await f.db.root<{ id: string; version: string }>(
      'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [f.agent]
    )
  )[0]!;
  const call = (target: string, date: string | null, request = randomUUID()) =>
    f.db.asUser(FINANCE_OWNER, 'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)', [
      f.team,
      f.agent,
      target,
      date,
      p.id,
      p.version,
      'UTC',
      request
    ]);
  await expect(call(f.accounts[0]!, '2026-09-25')).rejects.toThrow(/INVALID_INPUT/);
  await expect(call(f.otherAccount, '2026-09-25')).rejects.toThrow(/NOT_FOUND/);
  const duplicate = (
    await f.db.asUser<{ id: string }>(
      FINANCE_OWNER,
      "select public.add_team_account_agent($1,$2,'001234')->>'id' as id",
      [f.team, f.accounts[1]]
    )
  )[0]!.id;
  await expect(call(f.accounts[1]!, '2026-09-25')).rejects.toThrow(/AGENT_ID_CONFLICT/);
  await f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account_agent($1,$2)', [
    f.team,
    duplicate
  ]);
  // Entries — even today's, even cleared ones — no longer hold a transfer back,
  // and whatever date an older client sends is ignored.
  for (const [value, version] of [
    ['10.00', '0'],
    [null, '1']
  ] as const)
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on)))',
      [f.team, f.agent, '2026-09-25', 'spend', value, version, 'UTC', randomUUID()]
    );
  const request = randomUUID();
  const first = await call(f.accounts[1]!, '2025-12-31', request);
  expect(await call(f.accounts[1]!, '2025-12-31', request)).toEqual(first);
  expect(
    (
      await f.db.root<{ n: number }>(
        'select count(*)::int as n from public.team_agent_transfer_events where agent_row_id=$1',
        [f.agent]
      )
    )[0]!.n
  ).toBe(1);
  expect(
    await f.db.root(
      'select account_id from public.team_agent_finance_values where agent_row_id=$1',
      [f.agent]
    )
  ).toEqual([{ account_id: f.accounts[1] }]);
});
it('preserves the same agent through X → Y → X and counts backdated money where it is now', async () => {
  const move = async (target: string, date: string) => {
    const p = (
      await f.db.root<{ id: string; version: string }>(
        'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
        [f.agent]
      )
    )[0]!;
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)',
      [f.team, f.agent, target, date, p.id, p.version, 'UTC', randomUUID()]
    );
  };
  await move(f.accounts[1]!, '2026-09-15');
  await move(f.accounts[0]!, '2026-09-20');
  await f.db.asUser(
    FINANCE_OWNER,
    'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on)))',
    [f.team, f.agent, '2026-09-16', 'spend', '40.00', '0', 'UTC', randomUUID()]
  );
  const value = await f.db.root<{ account_id: string }>(
    'select account_id from public.team_agent_finance_values where agent_row_id=$1',
    [f.agent]
  );
  // Every sum follows the agent to where it is now, whatever day it is for.
  expect(value[0]!.account_id).toBe(f.accounts[0]);
  await expect(
    f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account($1,$2)', [f.team, f.accounts[0]])
  ).rejects.toThrow(/FINANCE_HISTORY_PROTECTED/);
  expect(
    await f.db.root('select id from public.team_account_agents where id=$1', [f.agent])
  ).toHaveLength(1);
  for (const table of ['team_agent_runs', 'team_agent_labels', 'team_task_agents'])
    expect(
      await f.db.root(`select id from public.${table} where agent_row_id=$1`, [f.agent])
    ).toHaveLength(1);
  let cursor: unknown = null;
  const seen: string[] = [];
  for (let n = 0; n < 3; n++) {
    const page = (
      await f.db.asUser<{
        result: {
          events: { id: string; newValue: string }[];
          transfers: { id: string }[];
          nextCursor: unknown;
        };
      }>(FINANCE_OWNER, 'select public.list_team_agent_finance_history($1,$2,$3,1) as result', [
        f.team,
        f.agent,
        cursor === null ? null : JSON.stringify(cursor)
      ])
    )[0]!.result;
    expect(page.events.length + page.transfers.length).toBe(1);
    seen.push(...page.events.map(e => e.id), ...page.transfers.map(e => e.id));
    if (page.events.length) expect(page.events[0]!.newValue).toBe('40.00');
    cursor = page.nextCursor;
  }
  expect(new Set(seen).size).toBe(3);
});

it('rejects a stale empty draft after a transfer and retains historical task tags', async () => {
  const p = (
    await f.db.root<{ id: string; version: string }>(
      'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [f.agent]
    )
  )[0]!;
  const request = randomUUID();
  const args = [f.team, f.agent, f.accounts[1], '2026-09-15', p.id, p.version, 'UTC', request];
  const first = await f.db.asUser(
    FINANCE_OWNER,
    'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)',
    args
  );
  expect(
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)',
      args
    )
  ).toEqual(first);
  await expect(
    f.db.asUser(
      FINANCE_OWNER,
      'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [f.team, f.agent, '2026-09-15', 'topup', '250', '0', 'UTC', randomUUID(), p.id]
    )
  ).rejects.toThrow(/PLACEMENT_CONFLICT/);
  expect(
    await f.db.root('select id from public.team_agent_finance_values where agent_row_id=$1', [
      f.agent
    ])
  ).toHaveLength(0);
  const tags = (
    await f.db.root<{ tags: { account_id: string; account_name: string }[] }>(
      'select private.team_task_agent_tags($1) as tags',
      [f.task]
    )
  )[0]!.tags;
  expect(tags[0]).toMatchObject({ account_id: f.accounts[0], account_name: 'X' });
  const summaries = await f.db.asUser<{
    id: string;
    task_count: number;
    agents: { task_count: number; account_task_count: number }[];
  }>(FINANCE_OWNER, 'select * from public.list_team_accounts($1)', [f.team]);
  expect(summaries.find(account => account.id === f.accounts[0])!.task_count).toBe(1);
  const destination = summaries.find(account => account.id === f.accounts[1])!;
  expect(destination.task_count).toBe(0);
  expect(destination.agents[0]).toMatchObject({ task_count: 1, account_task_count: 0 });
  const oldTasks = await f.db.asUser(
    FINANCE_OWNER,
    'select id from public.list_team_tasks(p_team:=$1,p_account:=$2)',
    [f.team, f.accounts[0]]
  );
  expect(oldTasks).toEqual([{ id: f.task }]);
  expect(
    await f.db.asUser(
      FINANCE_OWNER,
      'select id from public.list_team_tasks(p_team:=$1,p_account:=$2)',
      [f.team, f.accounts[1]]
    )
  ).toHaveLength(0);
  // The old setter is not an authenticated escape hatch around the CAS.
  expect(
    (
      await f.db.root<{ allowed: boolean }>(
        "select has_function_privilege('authenticated','public.set_team_agent_finance_value(uuid,uuid,date,text,text,text,text,uuid)','execute') as allowed"
      )
    )[0]!.allowed
  ).toBe(false);
});
it('records repeated same-day transfers without duplicate report columns', async () => {
  for (const target of [f.accounts[1], f.accounts[0], f.accounts[1]]) {
    const p = (
      await f.db.root<{ id: string; version: string }>(
        'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
        [f.agent]
      )
    )[0]!;
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)',
      [f.team, f.agent, target, '2026-01-01', p.id, p.version, 'UTC', randomUUID()]
    );
  }
  const result = (
    await f.db.asUser<{ result: { placements: { accountId: string }[] } }>(
      FINANCE_OWNER,
      'select public.get_team_agent_finance($1,$2,$3,$4) as result',
      [f.team, '2026-01-01', '2026-01-31', 'UTC']
    )
  )[0]!.result;
  expect(result.placements).toHaveLength(1);
  expect(result.placements[0]!.accountId).toBe(f.accounts[1]);
  expect(
    await f.db.root('select id from public.team_agent_transfer_events where agent_row_id=$1', [
      f.agent
    ])
  ).toHaveLength(3);
});
it('reports nothing blocking a transfer, whatever the history holds', async () => {
  for (const [metric, value, version] of [
    ['topup', '0', '0'],
    ['spend', '15', '0'],
    ['spend', null, '1']
  ] as const) {
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and starts_on<=$3::date and (ends_on is null or $3::date<ends_on)))',
      [f.team, f.agent, '2026-09-25', metric, value, version, 'UTC', randomUUID()]
    );
  }
  const result = (
    await f.db.asUser<{ result: { minDate: string; blockers: unknown[] } }>(
      FINANCE_OWNER,
      'select public.get_team_agent_transfer_eligibility($1,$2,$3) as result',
      [f.team, f.agent, 'UTC']
    )
  )[0]!.result;
  expect(result.minDate).toBe(new Date().toISOString().slice(0, 10));
  expect(result.blockers).toEqual([]);
});
