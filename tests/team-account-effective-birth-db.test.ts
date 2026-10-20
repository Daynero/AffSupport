import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { financeFixture, FINANCE_OWNER } from './support/team-agent-finance';

it('migrates legacy history unchanged and atomically creates calendar-dated SOC/RK without changing physical audits', async () => {
  const f = await financeFixture({
    throughMigration: '20261202145000_account_mutation_metadata.sql'
  });
  try {
    const call = async (name: string, args: unknown[]) =>
      (
        await f.db.asUser<{ value: any }>(
          FINANCE_OWNER,
          `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`,
          args
        )
      )[0]!.value;
    const row = async (sql: string, args: unknown[] = []) => (await f.db.root<any>(sql, args))[0];
    const oldPlace = await row(
      'select id,starts_on::text,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [f.agent]
    );
    await call('set_team_agent_finance_value', [
      f.team,
      f.agent,
      '2026-01-02',
      'spend',
      '7.25',
      '0',
      'UTC',
      randomUUID(),
      oldPlace.id,
      'normal'
    ]);
    const oldSnapshot = await call('get_team_agent_finance', [
      f.team,
      '2026-01-01',
      '2026-01-03',
      'UTC'
    ]);
    const oldEvents = await row(
      'select count(*)::integer n from public.team_agent_finance_events where team_id=$1',
      [f.team]
    );
    const audit = await row('select created_at::text from public.team_account_agents where id=$1', [
      f.agent
    ]);
    await f.db.db.exec(
      readFileSync('supabase/migrations/20261202146000_account_effective_birth.sql', 'utf8')
    );
    expect(
      await row('select starts_on from public.team_account_agents where id=$1', [f.agent])
    ).toEqual({ starts_on: null });
    expect(
      await row('select starts_on from public.team_accounts where id=$1', [f.accounts[0]])
    ).toEqual({ starts_on: null });
    expect(
      await row('select created_at::text from public.team_account_agents where id=$1', [f.agent])
    ).toEqual(audit);
    expect(
      await row(
        'select id,starts_on::text,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
        [f.agent]
      )
    ).toEqual(oldPlace);
    expect(
      (await call('get_team_agent_finance', [f.team, '2026-01-01', '2026-01-03', 'UTC'])).fields
    ).toEqual(oldSnapshot.fields);
    expect(
      await row(
        'select count(*)::integer n from public.team_agent_finance_events where team_id=$1',
        [f.team]
      )
    ).toEqual(oldEvents);
    const legacy = await call('get_team_agent_finance_v2', [
      f.team,
      '2026-01-01',
      '2026-01-03',
      'UTC'
    ]);
    expect(legacy.lifecycle.agents.find((a: any) => a.id === f.agent)).not.toHaveProperty(
      'startsOn'
    );
    expect(legacy.lifecycle.accounts.find((a: any) => a.id === f.accounts[0])).not.toHaveProperty(
      'startsOn'
    );
    const dates = await row(
      "select private.finance_today('UTC')::text today,(private.finance_today('UTC')-1)::text yesterday,(private.finance_today('UTC')-3)::text older,(private.finance_today('UTC')-4)::text before_birth,(private.finance_today('UTC')+1)::text future,clock_timestamp()::text before_create"
    );
    const create = async (name: string, date?: string, zone = 'UTC') =>
      (
        await f.db.asUser<{ value: any }>(
          FINANCE_OWNER,
          'select to_jsonb(public.create_team_account($1,$2,$3,$4)) value',
          [f.team, name, date ?? null, zone]
        )
      )[0]!.value;
    const parent = await create('Selected yesterday', dates.yesterday);
    expect(parent.starts_on).toBe(dates.yesterday);
    expect(new Date(parent.created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(dates.before_create).getTime()
    );
    const child = await call('add_team_account_agent', [
      f.team,
      parent.id,
      'dated-rk',
      null,
      'Pacific/Kiritimati',
      dates.older
    ]);
    expect(child.starts_on).toBe(dates.older);
    expect(new Date(child.created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(dates.before_create).getTime()
    );
    expect(
      await row('select starts_on::text,created_at::text from public.team_accounts where id=$1', [
        parent.id
      ])
    ).toEqual({
      starts_on: dates.older,
      created_at: (await row('select $1::timestamptz::text stamp', [parent.created_at])).stamp
    });
    const place = await row(
      'select id,starts_on::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [child.id]
    );
    expect(place.starts_on).toBe(dates.older);
    expect(
      (
        await row(
          "select (starts_at at time zone 'Pacific/Kiritimati')::date::text as day from public.team_account_parent_history where agent_row_id=$1 and ends_at is null",
          [child.id]
        )
      ).day
    ).toBe(dates.older);
    const overview = await call('get_team_accounts_overview', [
      f.team,
      dates.older,
      dates.today,
      'UTC'
    ]);
    const shown = overview.accounts.find((a: any) => a.id === parent.id);
    expect(shown.starts_on).toBe(dates.older);
    expect(shown.agents[0].starts_on).toBe(dates.older);
    const beforeOverview = await call('get_team_accounts_overview', [
      f.team,
      dates.before_birth,
      dates.before_birth,
      'UTC'
    ]);
    expect(beforeOverview.accounts.some((a: any) => a.id === parent.id)).toBe(false);
    const onOverview = await call('get_team_accounts_overview', [
      f.team,
      dates.older,
      dates.older,
      'UTC'
    ]);
    expect(
      onOverview.accounts.find((a: any) => a.id === parent.id).agents.map((a: any) => a.id)
    ).toContain(child.id);
    expect(beforeOverview.socialOrderVersion).toBe(onOverview.socialOrderVersion);
    expect(beforeOverview.agentOrderVersions).toEqual(onOverview.agentOrderVersions);

    const snapshot = await call('get_team_agent_finance_v2', [
      f.team,
      dates.older,
      dates.today,
      'UTC'
    ]);
    expect(snapshot.lifecycle.agents.find((a: any) => a.id === child.id).startsOn).toBe(
      dates.older
    );
    expect(snapshot.lifecycle.accounts.find((a: any) => a.id === parent.id).startsOn).toBe(
      dates.older
    );
    expect(
      (
        await call('get_team_agent_finance', [
          f.team,
          dates.before_birth,
          dates.before_birth,
          'UTC'
        ])
      ).placements.some((p: any) => p.agentRowId === child.id)
    ).toBe(false);
    for (const intent of ['normal', 'historical_correction'])
      await expect(
        call('set_team_agent_finance_value', [
          f.team,
          child.id,
          dates.before_birth,
          'spend',
          null,
          '0',
          'UTC',
          randomUUID(),
          place.id,
          intent
        ])
      ).rejects.toThrow('DATE_BEFORE_AGENT');
    await expect(
      call('clear_team_agent_finance_values', [
        f.team,
        dates.before_birth,
        'topup',
        JSON.stringify([{ agent: child.id, expectedVersion: '0' }]),
        'UTC',
        randomUUID(),
        'normal'
      ])
    ).rejects.toThrow('DATE_BEFORE_AGENT');
    await call('set_team_agent_finance_value', [
      f.team,
      child.id,
      dates.older,
      'spend',
      '0',
      '0',
      'UTC',
      randomUUID(),
      place.id,
      'normal'
    ]);
    expect(
      (
        await call('get_team_agent_finance_v2', [f.team, dates.older, dates.older, 'UTC'])
      ).fields.find((v: any) => v.agentRowId === child.id).value
    ).toBe('0.00');
    const legacyChild = await call('add_team_account_agent', [
      f.team,
      f.accounts[0],
      'legacy-parent-child',
      null,
      'UTC',
      dates.older
    ]);
    expect(legacyChild.starts_on).toBe(dates.older);
    const legacyBefore = await call('get_team_accounts_overview', [
      f.team,
      dates.before_birth,
      dates.before_birth,
      'UTC'
    ]);
    expect(
      legacyBefore.accounts
        .find((a: any) => a.id === f.accounts[0])
        .agents.some((a: any) => a.id === legacyChild.id)
    ).toBe(false);

    expect(
      (await row('select starts_on from public.team_accounts where id=$1', [f.accounts[0]]))
        .starts_on
    ).toBeNull();
    const todayParent = (
      await f.db.asUser<{ value: any }>(
        FINANCE_OWNER,
        'select to_jsonb(public.create_team_account($1,$2)) value',
        [f.team, 'Old arity today']
      )
    )[0]!.value;
    expect(todayParent.starts_on).toBe(dates.today);
    const todayChild = await call('add_team_account_agent', [
      f.team,
      todayParent.id,
      'old-arity-today'
    ]);
    expect(todayChild.starts_on).toBe(dates.today);
    const todayPlace = await row(
      'select starts_on::text from public.team_agent_placements where agent_row_id=$1',
      [todayChild.id]
    );
    expect(todayPlace.starts_on).toBe(dates.today);
    const transferRow = await call('add_team_account_agent', [
      f.team,
      parent.id,
      'transfer-does-not-rebirth-social',
      null,
      'UTC',
      dates.older
    ]);
    const transferPlace = await row(
      'select id,version::text from public.team_agent_placements where agent_row_id=$1 and ends_on is null',
      [transferRow.id]
    );
    await expect(
      call('move_team_account_agent', [
        f.team,
        transferRow.id,
        todayParent.id,
        dates.yesterday,
        transferPlace.id,
        transferPlace.version,
        'UTC',
        randomUUID()
      ])
    ).rejects.toThrow('TRANSFER_DATE_INVALID');
    await call('move_team_account_agent', [
      f.team,
      transferRow.id,
      todayParent.id,
      dates.today,
      transferPlace.id,
      transferPlace.version,
      'UTC',
      randomUUID()
    ]);
    expect(
      (await row('select starts_on::text from public.team_accounts where id=$1', [todayParent.id]))
        .starts_on
    ).toBe(dates.today);

    await expect(create('Reject future', dates.future)).rejects.toThrow('FUTURE_FINANCE_DATE');
    await expect(create('Reject zone', dates.yesterday, 'Invalid/Zone')).rejects.toThrow(
      'INVALID_INPUT'
    );
    expect(
      (
        await row(
          "select count(*)::integer n from public.team_accounts where team_id=$1 and name in('Reject future','Reject zone')",
          [f.team]
        )
      ).n
    ).toBe(0);
    const pre = await call('get_team_account_archive_preflight', [f.team, 'agent', child.id]);
    const archived = await call('set_team_account_archived', [
      f.team,
      'agent',
      child.id,
      true,
      pre.lifecycleVersion,
      pre.token,
      randomUUID()
    ]);
    expect(new Date(archived.archivedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(dates.before_create).getTime()
    );
    expect(
      (await row('select created_at::text from public.team_accounts where id=$1', [parent.id]))
        .created_at
    ).toBe((await row('select $1::timestamptz::text stamp', [parent.created_at])).stamp);
  } finally {
    await f.db.close();
  }
}, 120000);
