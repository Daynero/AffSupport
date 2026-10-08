import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financeFixture, FINANCE_OWNER, FINANCE_VIEWER } from './support/team-agent-finance';
let fixture: Awaited<ReturnType<typeof financeFixture>>;
beforeAll(async () => {
  fixture = await financeFixture();
}, 60000);
afterAll(async () => {
  await fixture?.db.close();
});
describe('finance foundation', () => {
  it('rejects undated clients instead of losing history', async () => {
    await expect(
      fixture.db.asUser(FINANCE_OWNER, 'select public.set_team_agent_money($1,$2,50,50)', [
        fixture.team,
        fixture.agent
      ])
    ).rejects.toThrow(/FINANCE_CLIENT_UPGRADE_REQUIRED/);
    for (const rpc of ['clear_team_agent_balances', 'clear_team_agent_topups'])
      await expect(
        fixture.db.asUser(FINANCE_OWNER, `select public.${rpc}($1)`, [fixture.team])
      ).rejects.toThrow(/FINANCE_CLIENT_UPGRADE_REQUIRED/);
  });
  it('creates a stable initial placement and keeps a new day empty', async () => {
    const rows = await fixture.db.root(
      'select * from public.team_agent_placements where agent_row_id=$1',
      [fixture.agent]
    );
    expect(rows).toHaveLength(1);
    expect(await fixture.db.root('select * from public.team_agent_finance_values')).toHaveLength(0);
  });
  it('validates timezone before creation and keeps the legacy call usable', async () => {
    await expect(
      fixture.db.asUser(
        FINANCE_OWNER,
        "select public.add_team_account_agent($1,$2,'new',null,'not/a/timezone')",
        [fixture.team, fixture.accounts[0]]
      )
    ).rejects.toThrow(/INVALID_INPUT/);
    expect(
      await fixture.db.root("select id from public.team_account_agents where agent_id='new'")
    ).toHaveLength(0);
    await expect(
      fixture.db.asUser(FINANCE_VIEWER, "select public.add_team_account_agent($1,$2,'new')", [
        fixture.team,
        fixture.accounts[0]
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
  it('isolates direct reads and forbids direct money and history mutations', async () => {
    await expect(
      fixture.db.asUser(FINANCE_VIEWER, 'select public.get_team_agent_finance($1,$2,$3,$4)', [
        fixture.otherTeam,
        '2026-09-10',
        '2026-09-10',
        'UTC'
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(
      await fixture.db.asUser(
        FINANCE_VIEWER,
        'select id from public.team_agent_placements where team_id=$1',
        [fixture.otherTeam]
      )
    ).toHaveLength(0);
    await expect(
      fixture.db.asUser(
        FINANCE_OWNER,
        'update public.team_account_agents set balance=1 where id=$1',
        [fixture.agent]
      )
    ).rejects.toThrow(/permission denied|FINANCE_CLIENT_UPGRADE_REQUIRED/iu);
    await fixture.db.root('set role authenticated');
    try {
      expect(
        await fixture.db.asUser(
          FINANCE_VIEWER,
          'select id from public.team_agent_placements where team_id=$1',
          [fixture.otherTeam]
        )
      ).toHaveLength(0);
      await expect(
        fixture.db.asUser(FINANCE_OWNER, 'delete from public.team_agent_finance_events')
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await fixture.db.root('reset role');
    }
  });
  it('allows history before registration in every creation timezone', async () => {
    await fixture.db.db.exec(`
      alter function private.finance_create_agent(uuid,uuid,text,text) rename to finance_create_agent_test_original;
      create function private.finance_create_agent(p_team uuid,p_account uuid,p_agent_id text,p_note text) returns jsonb language plpgsql security definer set search_path='' as $$
      declare result jsonb;begin
        result:=private.finance_create_agent_test_original(p_team,p_account,p_agent_id,p_note);
        update public.team_account_agents set created_at='2026-01-01T00:30:00Z' where id=(result->>'id')::uuid;
        return result;
      end $$;
    `);
    const utc = (
      await fixture.db.asUser<{ id: string }>(
        FINANCE_OWNER,
        "select public.add_team_account_agent($1,$2,'utc-test')->>'id' as id",
        [fixture.team, fixture.accounts[0]]
      )
    )[0]!.id;
    const west = (
      await fixture.db.asUser<{ id: string }>(
        FINANCE_OWNER,
        "select public.add_team_account_agent($1,$2,'west-test',null,'America/Los_Angeles')->>'id' as id",
        [fixture.team, fixture.accounts[0]]
      )
    )[0]!.id;
    const rows = await fixture.db.root<{ agent_row_id: string; date: string }>(
      'select agent_row_id,starts_on::text as date from public.team_agent_placements where agent_row_id in($1,$2)',
      [utc, west]
    );
    expect(rows.find(r => r.agent_row_id === utc)?.date).toBe('0001-01-01');
    expect(rows.find(r => r.agent_row_id === west)?.date).toBe('0001-01-01');
  });
});
