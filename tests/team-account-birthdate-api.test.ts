import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
const audit = '2026-10-18T00:30:00Z';
const account = {
  id: 'social',
  team_id: 'team',
  name: 'Social',
  starts_on: '2026-10-17',
  created_at: audit,
  updated_at: audit
};
const agent = {
  id: 'rk',
  team_id: 'team',
  account_id: 'social',
  agent_id: '926',
  starts_on: '2026-10-17',
  runs: [],
  labels: [],
  balance: null,
  topup: null,
  created_at: audit,
  updated_at: audit
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(audit));
});
afterEach(() => {
  rpc.mockReset();
  vi.useRealTimers();
});
it('sends the selected SOC day and timezone and keeps the physical audit timestamp', async () => {
  rpc.mockResolvedValue({ data: account, error: null });
  const row = await teamApi.createAccount({
    teamId: 'team',
    name: 'Social',
    startsOn: '2026-10-17',
    timezone: 'Europe/Kyiv'
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('create_team_account', {
    p_team: 'team',
    p_name: 'Social',
    p_starts_on: '2026-10-17',
    p_timezone: 'Europe/Kyiv'
  });
  expect(row.startsOn).toBe('2026-10-17');
  expect(row.createdAt).toBe(audit);
});
it('sends the selected RK day without backdating its audit timestamp', async () => {
  rpc.mockResolvedValue({ data: agent, error: null });
  const row = await teamApi.addAccountAgent({
    teamId: 'team',
    accountId: 'social',
    agentId: '926',
    startsOn: '2026-10-17',
    timezone: 'Europe/Kyiv'
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('add_team_account_agent', {
    p_team: 'team',
    p_account: 'social',
    p_agent_id: '926',
    p_note: undefined,
    p_starts_on: '2026-10-17',
    p_timezone: 'Europe/Kyiv'
  });
  expect(row.startsOn).toBe('2026-10-17');
  expect(row.createdAt).toBe(audit);
});
it.each(['2026-02-30', '', 'yesterday'])(
  'rejects malformed dates before either RPC: %s',
  async startsOn => {
    await expect(
      teamApi.createAccount({ teamId: 'team', name: 'Social', startsOn, timezone: 'UTC' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      teamApi.addAccountAgent({
        teamId: 'team',
        accountId: 'social',
        agentId: '926',
        startsOn,
        timezone: 'UTC'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(rpc).not.toHaveBeenCalled();
  }
);
it('uses the selected timezone at midnight for future-day rejection', async () => {
  const startsOn = '2026-10-18';
  const timezone = 'America/Los_Angeles';
  await expect(
    teamApi.createAccount({ teamId: 'team', name: 'Social', startsOn, timezone })
  ).rejects.toMatchObject({ code: 'FUTURE_FINANCE_DATE' });
  await expect(
    teamApi.addAccountAgent({
      teamId: 'team',
      accountId: 'social',
      agentId: '926',
      startsOn,
      timezone
    })
  ).rejects.toMatchObject({ code: 'FUTURE_FINANCE_DATE' });
  expect(rpc).not.toHaveBeenCalled();
});
it('leaves omitted dates to the validated timezone-local server default', async () => {
  rpc.mockResolvedValue({ data: account, error: null });
  await teamApi.createAccount({ teamId: 'team', name: 'Social', timezone: 'America/Los_Angeles' });
  expect(rpc).toHaveBeenCalledWith('create_team_account', {
    p_team: 'team',
    p_name: 'Social',
    p_timezone: 'America/Los_Angeles'
  });
});
it('does not claim selected-day acceptance if the server omits or changes the effective day', async () => {
  rpc.mockResolvedValueOnce({ data: { ...account, starts_on: undefined }, error: null });
  await expect(
    teamApi.createAccount({
      teamId: 'team',
      name: 'Social',
      startsOn: '2026-10-17',
      timezone: 'UTC'
    })
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  rpc.mockResolvedValueOnce({ data: { ...agent, starts_on: '2026-10-18' }, error: null });
  await expect(
    teamApi.addAccountAgent({
      teamId: 'team',
      accountId: 'social',
      agentId: '926',
      startsOn: '2026-10-17',
      timezone: 'UTC'
    })
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
