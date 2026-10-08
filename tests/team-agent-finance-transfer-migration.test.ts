import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { financeFixture, FINANCE_OWNER } from './support/team-agent-finance';

it('backfills task accounts from attachment-time transfers, not financial effective dates', async () => {
  const f = await financeFixture({ throughMigration: '20261008110000_sync_diagnostics_view.sql' });
  try {
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
    const second = (
      await f.db.root<{ id: string }>(
        "insert into public.team_tasks(team_id,created_by,title) values($1,$2,'Attached under Y') returning id",
        [f.team, FINANCE_OWNER]
      )
    )[0]!.id;
    await f.db.root(
      'insert into public.team_task_agents(team_id,task_id,agent_row_id,attached_by) values($1,$2,$3,$4)',
      [f.team, second, f.agent, FINANCE_OWNER]
    );
    await move(f.accounts[0]!, '2026-09-20');
    await f.db.db.exec(
      readFileSync('supabase/migrations/20261008120000_team_agent_transfer_safety.sql', 'utf8')
    );
    for (const [task, account] of [
      [f.task, f.accounts[0]],
      [second, f.accounts[1]]
    ]) {
      const row = (
        await f.db.root<{ account_id: string }>(
          'select account_id from public.team_task_agents where task_id=$1',
          [task]
        )
      )[0]!;
      expect(row.account_id).toBe(account);
    }
    const link = (
      await f.db.root<{ id: string }>('select id from public.team_task_agents where task_id=$1', [
        f.task
      ])
    )[0]!.id;
    await expect(
      f.db.root('update public.team_task_agents set account_id=$1 where id=$2', [
        f.accounts[1],
        link
      ])
    ).rejects.toThrow(/INVALID_INPUT/);
  } finally {
    await f.db.close();
  }
}, 60000);
