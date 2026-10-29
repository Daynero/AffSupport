import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { financeFixture, FINANCE_OWNER, FINANCE_VIEWER } from './support/team-agent-finance';

it.each([
  ['agent', true],
  ['social', true],
  ['agent', false],
  ['social', false]
] as const)(
  'deletes %s (archived=%s) with money, releases Launch holds and preserves unrelated work',
  async (kind, archived) => {
    const f = await financeFixture({ legacy: true });
    try {
      const call = async (name: string, args: unknown[], user = FINANCE_OWNER) =>
        (
          await f.db.asUser<{ value: any }>(
            user,
            `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`,
            args
          )
        )[0]!.value;
      const requestId = randomUUID();
      const placement = (
        await f.db.root<{ id: string }>(
          'select id from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
          [f.agent]
        )
      )[0]!.id;
      await f.db.asUser(
        FINANCE_OWNER,
        'select public.set_team_agent_finance_value($1,$2,$3,$4,$5,$6,$7,$8,(select id from public.team_agent_placements where agent_row_id=$2 and ends_on is null))',
        [f.team, f.agent, '2026-09-01', 'spend', '12.34', '0', 'UTC', requestId]
      );
      const launch = (
        await f.db.root<{ id: string }>(
          'insert into public.team_launches(team_id,created_by) values($1,$2) returning id',
          [f.team, FINANCE_OWNER]
        )
      )[0]!.id;
      await call('set_launch_assignment', [f.team, launch, f.agent, '0', randomUUID()]);
      const id = kind === 'agent' ? f.agent : f.accounts[0];
      if (archived) {
        const pre = await call('get_team_account_archive_preflight', [f.team, kind, id]);
        await call('set_team_account_archived', [
          f.team,
          kind,
          id,
          true,
          pre.lifecycleVersion,
          pre.token,
          randomUUID()
        ]);
      }
      // Reintroduce a legacy hold to cover deletion regardless of its current state.
      await f.db.root(
        "update private.team_launch_assignments set agent_row_id=$1,state='legacy_unknown' where launch_id=$2",
        [f.agent, launch]
      );
      const rpc = kind === 'agent' ? 'delete_team_account_agent' : 'delete_team_account';
      await expect(call(rpc, [f.team, id], FINANCE_VIEWER)).rejects.toThrow(/PERMISSION_DENIED/);
      await expect(call(rpc, [f.otherTeam, id])).rejects.toThrow(/NOT_FOUND/);
      await call(rpc, [f.team, id]);
      for (const table of [
        'team_account_agents',
        'team_agent_finance_values',
        'team_agent_finance_events',
        'team_agent_finance_legacy',
        'team_agent_transfer_events',
        'team_agent_placements'
      ]) {
        const column = table === 'team_account_agents' ? 'id' : 'agent_row_id';
        expect(
          await f.db.root(`select 1 from public.${table} where ${column}=$1`, [f.agent])
        ).toHaveLength(0);
      }
      expect(
        await f.db.root('select id from public.team_tasks where id=$1', [f.task])
      ).toHaveLength(1);
      expect(
        await f.db.root('select id from public.team_launches where id=$1', [launch])
      ).toHaveLength(1);
      expect(
        await f.db.root(
          'select state,agent_row_id from private.team_launch_assignments where launch_id=$1',
          [launch]
        )
      ).toEqual([{ state: 'released', agent_row_id: null }]);
      expect(
        await f.db.root('select id from public.team_accounts where id=$1', [f.otherAccount])
      ).toHaveLength(1);
      await expect(
        call('set_team_agent_finance_value', [
          f.team,
          f.agent,
          '2026-09-01',
          'spend',
          '12.34',
          '0',
          'UTC',
          requestId,
          placement
        ])
      ).rejects.toThrow(/REQUEST_REUSE_CONFLICT|NOT_FOUND/);
      const receipts = await f.db.root<{ result: unknown }>(
        'select result from public.team_agent_finance_requests where team_id=$1',
        [f.team]
      );
      expect(receipts.length).toBeGreaterThan(0);
      expect(receipts.every(row => JSON.stringify(row.result) === '{"deleted":true}')).toBe(true);
    } finally {
      await f.db.close();
    }
  },
  120000
);
