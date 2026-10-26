import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { financeAgentVisible, parseFinanceSnapshot } from '@video-compressor/shared';
import { unifiedAccountsFixture, UNIFIED_ACCOUNTS_OWNER } from './support/team-unified-accounts';

it('upgrades existing identities and ledger without rewriting history, seeds natural stable ranks and preserves temporal zero/null archive semantics', async () => {
  const f = await unifiedAccountsFixture({
    socialCount: 3,
    agentsPerSocial: 2,
    runsPerAgent: 0,
    throughMigration: '20261202137000_launch_account_offer_filters.sql'
  });
  try {
    const call = async (name: string, args: unknown[]) =>
      (
        await f.db.asUser<{ value: any }>(
          UNIFIED_ACCOUNTS_OWNER,
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`,
          args
        )
      )[0]!.value;
    await f.db.root("update public.team_accounts set name='g10' where id=$1", [f.socials[0]!.id]);
    await f.db.root("update public.team_accounts set name='g1' where id=$1", [f.socials[2]!.id]);
    const agent = f.agents[0]!;
    const placement = (
      await f.db.root<{ id: string }>(
        'select id from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and ends_on is null',
        [f.team, agent.id]
      )
    )[0]!.id;
    await call('set_team_agent_finance_value', [
      f.team,
      agent.id,
      '2025-12-15',
      'spend',
      '0',
      '0',
      'UTC',
      randomUUID(),
      placement
    ]);
    const before = (
      await call('get_team_agent_finance', [f.team, '2025-12-15', '2025-12-15', 'UTC'])
    ).fields;
    for (const migration of [
      '20261202138000_unified_accounts.sql',
      '20261202141000_account_analytics_guard.sql',
      '20261202142000_account_mutation_locking.sql'
    ])
      await f.db.db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'));
    const overview = await call('get_team_accounts_overview', [
      f.team,
      '2026-01-01',
      '2026-01-01',
      'UTC'
    ]);
    expect(overview.accounts.map((a: any) => a.name)).toEqual(['g1', 'g2', 'g10']);
    expect(overview.launchCoverage).toBe('complete');
    expect(overview.launchSummaries).toEqual([]);
    const old = await call('get_team_agent_finance_v2', [
      f.team,
      '2025-12-15',
      '2025-12-15',
      'UTC'
    ]);
    expect(old.fields).toEqual(before);
    const parsedOld = parseFinanceSnapshot(old)!;
    expect(parsedOld).not.toBeNull();
    expect(financeAgentVisible(parsedOld, agent.id, '2025-12-15', 'UTC')).toBe(true);
    const empty = await call('get_team_agent_finance_v2', [
      f.team,
      '2025-12-16',
      '2025-12-16',
      'UTC'
    ]);
    expect(financeAgentVisible(parseFinanceSnapshot(empty)!, agent.id, '2025-12-16', 'UTC')).toBe(
      false
    );
    const today = (
      await f.db.root<{ day: string }>(
        "select (clock_timestamp() at time zone 'UTC')::date::text as day"
      )
    )[0]!.day;
    const archive = async (kind: string, id: string, desired: boolean) => {
      const pre = await call('get_team_account_archive_preflight', [f.team, kind, id]);
      return call('set_team_account_archived', [
        f.team,
        kind,
        id,
        desired,
        pre.lifecycleVersion,
        desired ? pre.token : null,
        randomUUID()
      ]);
    };
    await archive('agent', agent.id, true);
    let snapshot = parseFinanceSnapshot(
      await call('get_team_agent_finance_v2', [f.team, today, today, 'UTC'])
    )!;
    expect(financeAgentVisible(snapshot, agent.id, today, 'UTC')).toBe(false);
    await call('set_team_agent_finance_value', [
      f.team,
      agent.id,
      today,
      'spend',
      '0',
      '0',
      'UTC',
      randomUUID(),
      placement,
      'historical_correction'
    ]);
    snapshot = parseFinanceSnapshot(
      await call('get_team_agent_finance_v2', [f.team, today, today, 'UTC'])
    )!;
    expect(financeAgentVisible(snapshot, agent.id, today, 'UTC')).toBe(true);
    await call('set_team_agent_finance_value', [
      f.team,
      agent.id,
      today,
      'spend',
      null,
      '1',
      'UTC',
      randomUUID(),
      placement,
      'historical_correction'
    ]);
    snapshot = parseFinanceSnapshot(
      await call('get_team_agent_finance_v2', [f.team, today, today, 'UTC'])
    )!;
    expect(financeAgentVisible(snapshot, agent.id, today, 'UTC')).toBe(false);
    await archive('agent', agent.id, false);
    snapshot = parseFinanceSnapshot(
      await call('get_team_agent_finance_v2', [f.team, today, today, 'UTC'])
    )!;
    expect(financeAgentVisible(snapshot, agent.id, today, 'UTC')).toBe(true);
    const parentPre = await call('get_team_account_archive_preflight', [
      f.team,
      'social',
      agent.account_id
    ]);
    await archive('agent', agent.id, true);
    await expect(
      call('set_team_account_archived', [
        f.team,
        'social',
        agent.account_id,
        true,
        parentPre.lifecycleVersion,
        parentPre.token,
        randomUUID()
      ])
    ).rejects.toThrow('ACCOUNT_LIFECYCLE_CONFLICT');
    await archive('social', agent.account_id, true);
    await archive('social', agent.account_id, false);
    snapshot = parseFinanceSnapshot(
      await call('get_team_agent_finance_v2', [f.team, today, today, 'UTC'])
    )!;
    expect(financeAgentVisible(snapshot, agent.id, today, 'UTC')).toBe(false);
    expect(snapshot.lifecycle!.agents.find(a => a.id === agent.id)!.archivedAt).not.toBeNull();
  } finally {
    await f.close();
  }
}, 120000);

it('reads the actual v2 RPC after a closed parent history outlives its legacy social', async () => {
  const f = await unifiedAccountsFixture({ socialCount: 1, agentsPerSocial: 1, runsPerAgent: 0 });
  try {
    // Mirrors retained pre-archive history, without deleting or fabricating current identities.
    await f.db.root(
      "insert into public.team_account_parent_history(team_id,agent_row_id,account_id,starts_at,ends_at,provenance) values($1,$2,$3,'2025-01-01','2025-02-01','observed')",
      [f.team, f.agents[0]!.id, randomUUID()]
    );
    const [{ value }] = await f.db.asUser<{ value: unknown }>(
      UNIFIED_ACCOUNTS_OWNER,
      "select public.get_team_agent_finance_v2($1,'2026-01-02','2026-01-02','UTC') value",
      [f.team]
    );
    const parsed = parseFinanceSnapshot(value);
    expect(parsed).not.toBeNull();
    expect(parsed!.lifecycle!.parents).toHaveLength(2);
    expect(parsed!.agents).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60000);
