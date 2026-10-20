import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseTeamAccount } from '@video-compressor/shared';
import { financeFixture, FINANCE_OWNER, FINANCE_VIEWER } from './support/team-agent-finance';

it('archives independently, rejects stale preflight, retains financial history, replays receipts, and persists private color and order', async () => {
  const f = await financeFixture();
  try {
    const call = async (name: string, args: unknown[], user = FINANCE_OWNER) =>
      (
        await f.db.asUser<{ value: any }>(
          user,
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`,
          args
        )
      )[0]!.value;
    const created = (
      await f.db.asUser<{ value: Record<string, unknown> }>(
        FINANCE_OWNER,
        'select to_jsonb(public.create_team_account($1,$2)) value',
        [f.team, 'Raw composite parse']
      )
    )[0]!.value;
    expect(parseTeamAccount({ ...created, agents: [] })).toMatchObject({
      id: created.id,
      lifecycleVersion: '0'
    });
    await f.db.asUser(FINANCE_OWNER, 'select public.delete_team_account($1,$2)', [
      f.team,
      created.id
    ]);
    const signalBefore = (
      await f.db.root<{ revision: string }>(
        'select revision::text from public.team_account_workspace_signals where team_id=$1',
        [f.team]
      )
    )[0]!.revision;
    await f.db.root("update public.team_tasks set status='done' where id=$1", [f.task]);
    const signalAfter = (
      await f.db.root<{ revision: string }>(
        'select revision::text from public.team_account_workspace_signals where team_id=$1',
        [f.team]
      )
    )[0]!.revision;
    expect(BigInt(signalAfter)).toBeGreaterThan(BigInt(signalBefore));
    const overview = await call('get_team_accounts_overview', [
      f.team,
      '2026-01-01',
      '2026-01-02',
      'UTC'
    ]);
    expect(overview.accounts).toHaveLength(2);
    const orderId = randomUUID();
    const order = await call('reorder_team_accounts', [
      f.team,
      'socials',
      null,
      f.accounts[1],
      f.accounts[0],
      'before',
      overview.socialOrderVersion,
      orderId
    ]);
    expect(order.order).toEqual([f.accounts[1], f.accounts[0]]);
    expect(
      await call('reorder_team_accounts', [
        f.team,
        'socials',
        null,
        f.accounts[1],
        f.accounts[0],
        'before',
        overview.socialOrderVersion,
        orderId
      ])
    ).toEqual(order);
    await expect(
      call('reorder_team_accounts', [
        f.team,
        'socials',
        null,
        f.accounts[0],
        f.accounts[1],
        'before',
        overview.socialOrderVersion,
        randomUUID()
      ])
    ).rejects.toThrow('ACCOUNT_ORDER_CONFLICT');
    await call('set_team_account_name_color', [f.team, f.agent, 3, '0', randomUUID()]);
    const viewer = await call(
      'get_team_accounts_overview',
      [f.team, '2026-01-01', '2026-01-02', 'UTC'],
      FINANCE_VIEWER
    );
    expect(viewer.accounts.find((a: any) => a.id === f.accounts[0]).agents[0].name_color).toBe(0);
    const pre = await call('get_team_account_archive_preflight', [f.team, 'agent', f.agent]);
    const placement = (
      await f.db.root<{ id: string }>(
        'select id from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
        [f.agent]
      )
    )[0]!.id;
    const date = new Date().toISOString().slice(0, 10);
    await call('set_team_agent_finance_value', [
      f.team,
      f.agent,
      date,
      'spend',
      '0',
      '0',
      'UTC',
      randomUUID(),
      placement,
      'normal'
    ]);
    await expect(
      call('set_team_account_archived', [
        f.team,
        'agent',
        f.agent,
        true,
        pre.lifecycleVersion,
        pre.token,
        randomUUID()
      ])
    ).rejects.toThrow('ACCOUNT_LIFECYCLE_CONFLICT');
    const fresh = await call('get_team_account_archive_preflight', [f.team, 'agent', f.agent]);
    const request = randomUUID();
    const archived = await call('set_team_account_archived', [
      f.team,
      'agent',
      f.agent,
      true,
      fresh.lifecycleVersion,
      fresh.token,
      request
    ]);
    expect(archived.effectiveArchived).toBe(true);
    expect(
      await call('set_team_account_archived', [
        f.team,
        'agent',
        f.agent,
        true,
        fresh.lifecycleVersion,
        fresh.token,
        request
      ])
    ).toEqual(archived);
    const active = await f.db.asUser<{ agents: any[] }>(
      FINANCE_OWNER,
      'select agents from public.list_team_accounts($1) where id=$2',
      [f.team, f.accounts[0]]
    );
    expect(active[0]!.agents).toEqual([]);
    await expect(
      call('set_team_agent_finance_value', [
        f.team,
        f.agent,
        date,
        'spend',
        '5',
        '1',
        'UTC',
        randomUUID(),
        placement,
        'normal'
      ])
    ).rejects.toThrow('HISTORICAL_CORRECTION_REQUIRED');
    await call('set_team_agent_finance_value', [
      f.team,
      f.agent,
      date,
      'spend',
      '5',
      '1',
      'UTC',
      randomUUID(),
      placement,
      'historical_correction'
    ]);
    expect(
      (await call('get_team_agent_finance_v2', [f.team, date, date, 'UTC'])).fields[0].value
    ).toBe('5.00');
    const list = await call('list_team_account_archive', [f.team, null, 50, '']);
    expect(list.items).toHaveLength(1);
    await expect(call('add_team_agent_run', [f.team, f.agent, 'No new work'])).rejects.toThrow(
      'ACCOUNT_ARCHIVED'
    );
  } finally {
    await f.db.close();
  }
}, 120000);

it('parent restore keeps child-owned archives and archived sources cannot bypass old finance paths', async () => {
  const f = await financeFixture({ legacy: true });
  try {
    const call = async (name: string, args: unknown[], user = FINANCE_OWNER) =>
      (
        await f.db.asUser<{ value: any }>(
          user,
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`,
          args
        )
      )[0]!.value;
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
    const second = await call('add_team_account_agent', [f.team, f.accounts[0], 'another']);
    await archive('agent', f.agent, true);
    const ownPlacement = (
      await f.db.root<{ id: string; version: string }>(
        'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
        [f.agent]
      )
    )[0]!;
    await expect(
      call('move_team_account_agent', [
        f.team,
        f.agent,
        f.accounts[1],
        new Date().toISOString().slice(0, 10),
        ownPlacement.id,
        ownPlacement.version,
        'UTC',
        randomUUID()
      ])
    ).rejects.toThrow('ACCOUNT_ARCHIVED');
    await archive('social', f.accounts[0]!, true);
    expect((await call('list_team_account_archive', [f.team, null, 100, ''])).items).toHaveLength(
      3
    );
    await expect(archive('agent', f.agent, false)).rejects.toThrow('PARENT_ARCHIVED');
    await expect(
      call('add_team_account_agent', [f.team, f.accounts[0], 'blocked'])
    ).rejects.toThrow('PARENT_ARCHIVED');
    await expect(
      call('set_team_account_name_color', [f.team, f.agent, 1, '0', randomUUID()], FINANCE_VIEWER)
    ).resolves.toMatchObject({ color: 1 });
    await expect(
      call(
        'set_team_account_archived',
        [f.team, 'social', f.accounts[0], false, '1', null, randomUUID()],
        FINANCE_VIEWER
      )
    ).rejects.toThrow('PERMISSION_DENIED');
    await archive('social', f.accounts[0]!, false);
    const active = await f.db.asUser<{ agents: { id: string }[] }>(
      FINANCE_OWNER,
      'select agents from public.list_team_accounts($1) where id=$2',
      [f.team, f.accounts[0]]
    );
    expect(active[0]!.agents.map(a => a.id)).toEqual([second.id]);
    await expect(
      call('import_team_agent_finance_legacy', [
        f.team,
        f.legacy,
        'balance',
        '2026-01-02',
        '7',
        'USD',
        'UTC',
        randomUUID()
      ])
    ).rejects.toThrow('HISTORICAL_CORRECTION_REQUIRED');
    await call('import_team_agent_finance_legacy', [
      f.team,
      f.legacy,
      'balance',
      '2026-01-02',
      '7',
      'USD',
      'UTC',
      randomUUID(),
      'historical_correction'
    ]);
    const current = await call('get_team_account_archive_preflight', [f.team, 'agent', f.agent]);
    expect(current.effectiveArchived).toBe(true);
    const history = (
      await call('get_team_agent_finance_v2', [f.team, '2026-01-01', '2026-01-03', 'UTC'])
    ).lifecycle;
    expect(
      history.events.filter((e: any) => e.entityKind === 'social').map((e: any) => e.archived)
    ).toEqual([true, false]);
    await expect(call('delete_team_account_agent', [f.team, f.agent])).rejects.toThrow(
      'FINANCE_HISTORY_PROTECTED'
    );
  } finally {
    await f.db.close();
  }
}, 120000);
