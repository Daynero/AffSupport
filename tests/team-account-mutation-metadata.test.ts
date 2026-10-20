import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseTeamAccountAgent, sortTeamAgents } from '@video-compressor/shared';
import { financeFixture, FINANCE_OWNER, FINANCE_VIEWER } from './support/team-agent-finance';

it('retained writes preserve manual rank and actor-private decoration; new RK appends after the full scope', async () => {
  const f = await financeFixture();
  try {
    const call = async (name: string, args: unknown[], user = FINANCE_OWNER) =>
      (
        await f.db.asUser<{ value: any }>(
          user,
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`,
          args
        )
      )[0]!.value;
    const second = await call('add_team_account_agent', [
      f.team,
      f.accounts[0],
      '222-new',
      null,
      'UTC',
      '2026-01-01'
    ]);
    expect(parseTeamAccountAgent(second)).toMatchObject({
      sortRank: 1,
      lifecycleVersion: '0',
      archivedAt: null,
      nameColor: 0,
      nameColorVersion: '0'
    });
    await call('set_team_account_name_color', [f.team, f.agent, 3, '0', randomUUID()]);
    const overview = await call('get_team_accounts_overview', [
      f.team,
      '2026-01-01',
      '2026-01-02',
      'UTC'
    ]);
    await call('reorder_team_accounts', [
      f.team,
      'agents',
      f.accounts[0],
      second.id,
      f.agent,
      'before',
      overview.agentOrderVersions[f.accounts[0]!],
      randomUUID()
    ]);
    const check = (raw: unknown) => {
      const parsed = parseTeamAccountAgent(raw);
      expect(parsed).toMatchObject({
        id: f.agent,
        sortRank: 1,
        lifecycleVersion: '0',
        archivedAt: null,
        nameColor: 3,
        nameColorVersion: '1'
      });
      return parsed!;
    };
    const run = check(
      await call('add_team_agent_run', [f.team, f.agent, 'New run must not move row'])
    );
    expect(run.runs).toHaveLength(2);
    const renamed = check(
      await call('update_team_account_agent', [f.team, f.agent, '000-renamed'])
    );
    expect(renamed.agentId).toBe('000-renamed');
    const labelled = check(await call('attach_team_agent_label', [f.team, f.agent, f.label]));
    expect(labelled.labels).toHaveLength(1);
    const released = check(await call('clear_team_agent_runs', [f.team, f.agent]));
    expect(released.runs).toEqual([]);
    const third = parseTeamAccountAgent(
      await call('add_team_account_agent', [
        f.team,
        f.accounts[0],
        '000-new-free',
        null,
        'UTC',
        '2026-01-01'
      ])
    )!;
    expect(third).toMatchObject({ sortRank: 2, nameColor: 0, nameColorVersion: '0' });
    const reorderedSecond = parseTeamAccountAgent(
      (
        await call('get_team_accounts_overview', [f.team, '2026-01-01', '2026-01-02', 'UTC'])
      ).accounts
        .find((a: any) => a.id === f.accounts[0])
        .agents.find((a: any) => a.id === second.id)
    )!;
    expect(sortTeamAgents([released, third, reorderedSecond]).map(row => row.id)).toEqual([
      second.id,
      f.agent,
      third.id
    ]);
    await f.db.root(
      "update public.team_members set base_role='editor' where team_id=$1 and user_id=$2",
      [f.team, FINANCE_VIEWER]
    );
    const otherActor = parseTeamAccountAgent(
      await call(
        'add_team_agent_run',
        [f.team, f.agent, 'Other editor keeps private default'],
        FINANCE_VIEWER
      )
    );
    expect(otherActor).toMatchObject({ sortRank: 1, nameColor: 0, nameColorVersion: '0' });
  } finally {
    await f.db.close();
  }
}, 120000);
