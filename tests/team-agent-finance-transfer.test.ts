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
it('protects a former social account when the agent gained financial history after moving', async () => {
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
  await f.db.asUser(
    FINANCE_OWNER,
    'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8)',
    [f.team, f.agent, '2026-09-16', 'spend', '40.00', '0', 'UTC', randomUUID()]
  );
  await expect(
    f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account($1,$2)', [f.team, f.accounts[0]])
  ).rejects.toThrow(/FINANCE_HISTORY_PROTECTED/);
  expect(
    await f.db.root('select id from public.team_agent_transfer_events where agent_row_id=$1', [
      f.agent
    ])
  ).toHaveLength(1);
});
it('rejects invalid targets, ID collisions and dates with cleared entries; retries a move exactly once', async () => {
  const p = (
    await f.db.root<{ id: string; version: string }>(
      'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [f.agent]
    )
  )[0]!;
  const call = (target: string, date: string, request = randomUUID()) =>
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
  await expect(call(f.accounts[0]!, '2026-09-25')).rejects.toThrow(/TRANSFER_DATE_INVALID/);
  await expect(call(f.otherAccount, '2026-09-25')).rejects.toThrow(/NOT_FOUND/);
  await expect(call(f.accounts[1]!, '2026-01-01')).rejects.toThrow(/TRANSFER_DATE_INVALID/);
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
  for (const [value, version] of [
    ['10.00', '0'],
    [null, '1']
  ] as const)
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8)',
      [f.team, f.agent, '2026-09-25', 'spend', value, version, 'UTC', randomUUID()]
    );
  await expect(call(f.accounts[1]!, '2026-09-25')).rejects.toThrow(/TRANSFER_DATE_INVALID/);
  const request = randomUUID();
  const first = await call(f.accounts[1]!, '2026-09-26', request);
  expect(await call(f.accounts[1]!, '2026-09-26', request)).toEqual(first);
  expect(
    (
      await f.db.root<{ n: number }>(
        'select count(*)::int as n from public.team_agent_transfer_events where agent_row_id=$1',
        [f.agent]
      )
    )[0]!.n
  ).toBe(1);
});
it('preserves the same agent through X → Y → X and attributes backdated money', async () => {
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
    'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8)',
    [f.team, f.agent, '2026-09-16', 'spend', '40.00', '0', 'UTC', randomUUID()]
  );
  const value = await f.db.root<{ account_id: string }>(
    'select account_id from public.team_agent_finance_values where agent_row_id=$1',
    [f.agent]
  );
  expect(value[0]!.account_id).toBe(f.accounts[1]);
  await expect(
    f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account($1,$2)', [f.team, f.accounts[1]])
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
