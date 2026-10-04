import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { financeFixture, FINANCE_OWNER } from './support/team-agent-finance';

it('rolls back every row on a stale batch member and refuses an Undo after a newer edit', async () => {
  const f = await financeFixture();
  try {
    const second = (
      await f.db.asUser<{ id: string }>(
        FINANCE_OWNER,
        "select public.add_team_account_agent($1,$2,$3)->>'id' as id",
        [f.team, f.accounts[0], 'Second']
      )
    )[0]!.id;
    await f.db.root(
      "update public.team_agent_placements set starts_on='2026-01-01' where agent_row_id=$1",
      [second]
    );
    const set = (agent: string, value: string, version: string) =>
      f.db.asUser(
        FINANCE_OWNER,
        'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8)',
        [f.team, agent, '2026-09-10', 'topup', value, version, 'UTC', randomUUID()]
      );
    await set(f.agent, '100.25', '0');
    await set(second, '50.75', '0');
    const read = () =>
      f.db.root<{ agent_row_id: string; amount_cents: string; version: string }>(
        "select agent_row_id,amount_cents::text,version::text from public.team_agent_finance_values where team_id=$1 and metric='topup' order by agent_row_id",
        [f.team]
      );
    const before = await read();
    const countEvents = () =>
      f.db.root<{ count: number }>(
        'select count(*)::int as count from public.team_agent_finance_events where team_id=$1',
        [f.team]
      );
    const journal = await countEvents();
    const clear = (version: string, request: string) =>
      f.db.asUser(
        FINANCE_OWNER,
        'select public.clear_team_agent_finance_values($1,$2,$3,$4,$5,$6)',
        [
          f.team,
          '2026-09-10',
          'topup',
          JSON.stringify([
            { agent: f.agent, expectedVersion: '1' },
            { agent: second, expectedVersion: version }
          ]),
          'UTC',
          request
        ]
      );
    await expect(clear('0', randomUUID())).rejects.toThrow(/FINANCE_CONFLICT/);
    expect(await read()).toEqual(before);
    expect(await countEvents()).toEqual(journal);
    const request = randomUUID();
    const cleared = await clear('1', request);
    expect(await clear('1', request)).toEqual(cleared);
    await set(second, '75.00', '2');
    const newer = await read();
    await expect(
      f.db.asUser(FINANCE_OWNER, 'select public.undo_team_agent_finance_clear($1,$2,$3)', [
        f.team,
        request,
        randomUUID()
      ])
    ).rejects.toThrow(/FINANCE_CONFLICT/);
    expect(await read()).toEqual(newer);
  } finally {
    await f.db.close();
  }
}, 60000);

it('clears a batch atomically and restores it exactly once', async () => {
  const f = await financeFixture();
  try {
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8)',
      [f.team, f.agent, '2026-09-10', 'balance', '12.34', '0', 'UTC', randomUUID()]
    );
    await expect(
      f.db.asUser(
        FINANCE_OWNER,
        'select public.clear_team_agent_finance_values($1,$2,$3,$4,$5,$6)',
        [
          f.team,
          '2026-09-10',
          'balance',
          JSON.stringify([{ agent: f.agent, expectedVersion: '0' }]),
          'UTC',
          randomUUID()
        ]
      )
    ).rejects.toThrow(/FINANCE_CONFLICT/);
    const request = randomUUID();
    const rows = await f.db.asUser<{
      result: { undoReference: string; fields: { value: string | null }[] };
    }>(
      FINANCE_OWNER,
      'select public.clear_team_agent_finance_values($1,$2,$3,$4,$5,$6) as result',
      [
        f.team,
        '2026-09-10',
        'balance',
        JSON.stringify([{ agent: f.agent, expectedVersion: '1' }]),
        'UTC',
        request
      ]
    );
    expect(rows[0]!.result.undoReference).toBe(request);
    expect(rows[0]!.result.fields[0]!.value).toBe(null);
    const restored = await f.db.asUser<{ result: { fields: { value: string }[] } }>(
      FINANCE_OWNER,
      'select public.undo_team_agent_finance_clear($1,$2,$3) as result',
      [f.team, request, randomUUID()]
    );
    expect(restored[0]!.result.fields[0]!.value).toBe('12.34');
  } finally {
    await f.db.close();
  }
}, 60000);

it('imports legacy metrics independently, retains the originals and rejects occupied dates', async () => {
  const f = await financeFixture();
  try {
    const legacy = (
      await f.db.root<{ id: string }>(
        'insert into public.team_agent_finance_legacy(team_id,agent_row_id,account_id,balance_units,requested_topup_units) values($1,$2,$3,70,200) returning id',
        [f.team, f.agent, f.accounts[0]]
      )
    )[0]!.id;
    const call = (metric: string, date: string, value: string, request = randomUUID()) =>
      f.db.asUser(
        FINANCE_OWNER,
        'select public.import_team_agent_finance_legacy($1,$2,$3,$4,$5,$6,$7,$8)',
        [f.team, legacy, metric, date, value, 'USD', 'UTC', request]
      );
    const request = randomUUID();
    const first = await call('balance', '2026-09-10', '70.00', request);
    expect(await call('balance', '2026-09-10', '70.00', request)).toEqual(first);
    await expect(call('balance', '2026-09-11', '70.00')).rejects.toThrow(/LEGACY_ALREADY_IMPORTED/);
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8)',
      [f.team, f.agent, '2026-09-10', 'topup', '0.00', '0', 'UTC', randomUUID()]
    );
    await expect(call('topup', '2026-09-10', '200.00')).rejects.toThrow(/LEGACY_TARGET_OCCUPIED/);
    await call('topup', '2026-09-11', '150.00');
    const rows = await f.db.root<{ balance_units: number; requested_topup_units: number }>(
      'select balance_units,requested_topup_units from public.team_agent_finance_legacy where id=$1',
      [legacy]
    );
    expect(rows[0]).toEqual({ balance_units: 70, requested_topup_units: 200 });
    await expect(
      f.db.asUser(FINANCE_OWNER, 'select public.delete_draft_team($1)', [f.team])
    ).rejects.toThrow(/FINANCE_HISTORY_PROTECTED/);
    await f.db.root('delete from public.teams where id=$1', [f.team]);
    expect(
      await f.db.root('select id from public.team_agent_finance_values where team_id=$1', [f.team])
    ).toHaveLength(0);
  } finally {
    await f.db.close();
  }
}, 60000);
