import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildFinanceReport, parseFinanceSnapshot } from '@video-compressor/shared';
import { financeFixture, FINANCE_OWNER, FINANCE_VIEWER } from './support/team-agent-finance';

it('backdates existing and new accounts while retaining transfer boundaries and safeguards', async () => {
  const f = await financeFixture({
    throughMigration: '20261008120000_team_agent_transfer_safety.sql'
  });
  try {
    const initial = (
      await f.db.root<{ id: string; version: string }>(
        'select id,version::text from public.team_agent_placements where agent_row_id=$1',
        [f.agent]
      )
    )[0]!;
    await f.db.asUser(
      FINANCE_OWNER,
      'select public.move_team_account_agent($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        f.team,
        f.agent,
        f.accounts[1],
        '2026-09-15',
        initial.id,
        initial.version,
        'UTC',
        randomUUID()
      ]
    );
    const transferred = (
      await f.db.root<{ id: string; starts_on: string; version: string }>(
        'select id,starts_on::text,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
        [f.agent]
      )
    )[0]!;
    await f.db.db.exec(
      readFileSync('supabase/migrations/20261009100000_team_agent_finance_backdating.sql', 'utf8')
    );
    expect(
      (
        await f.db.root(
          'select id,starts_on::text,version::text from public.team_agent_placements where id=$1',
          [transferred.id]
        )
      )[0]
    ).toEqual(transferred);

    const write = (
      agent: string,
      date: string,
      metric: string,
      placement: string,
      actor = FINANCE_OWNER
    ) =>
      f.db.asUser(actor, 'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        f.team,
        agent,
        date,
        metric,
        '12.34',
        '0',
        'UTC',
        randomUUID(),
        placement
      ]);
    for (const metric of ['balance', 'topup', 'spend'])
      await write(f.agent, '2025-12-15', metric, initial.id);
    await write(f.agent, '2026-09-15', 'spend', transferred.id);
    await expect(write(f.agent, '2026-09-14', 'spend', transferred.id)).rejects.toThrow(
      /PLACEMENT_CONFLICT/
    );
    await expect(write(f.agent, '2025-12-15', 'spend', initial.id)).rejects.toThrow(
      /FINANCE_CONFLICT/
    );
    await expect(write(f.agent, '2025-12-16', 'spend', initial.id, FINANCE_VIEWER)).rejects.toThrow(
      /PERMISSION_DENIED/
    );
    await expect(write(f.agent, '9999-12-31', 'spend', transferred.id)).rejects.toThrow(
      /FUTURE_FINANCE_DATE/
    );

    const snapshot = (
      await f.db.asUser<{ snapshot: unknown }>(
        FINANCE_OWNER,
        'select public.get_team_agent_finance($1,$2,$3,$4) as snapshot',
        [f.team, '2025-12-01', '2025-12-31', 'UTC']
      )
    )[0]!.snapshot;
    const parsed = parseFinanceSnapshot(snapshot);
    expect(parsed).not.toBeNull();
    const report = buildFinanceReport(parsed!);
    expect(report.cell(f.accounts[0]!, f.agent, '2025-12-15', 'spend')).toBe('12.34');
    expect(report.totals.topup).toBe('12.34');
    expect(report.columns.every(c => c.accountId === f.accounts[0])).toBe(true);

    const added = (
      await f.db.asUser<{ id: string }>(
        FINANCE_OWNER,
        "select public.add_team_account_agent($1,$2,'historic-new',null,'Europe/Kyiv')->>'id' as id",
        [f.team, f.accounts[0]]
      )
    )[0]!.id;
    const placement = (
      await f.db.root<{ id: string; date: string }>(
        'select id,starts_on::text as date from public.team_agent_placements where agent_row_id=$1',
        [added]
      )
    )[0]!;
    expect(placement.date).toBe('0001-01-01');
    await write(added, '2020-01-01', 'spend', placement.id);
  } finally {
    await f.db.close();
  }
}, 60000);
