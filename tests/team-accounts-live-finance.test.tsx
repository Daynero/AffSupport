// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { teamApi } from '../apps/web/src/api/team';
import * as supabaseModule from '../apps/web/src/lib/supabase';
import { useAccounts } from '../apps/web/src/team/accounts/useAccounts';
import { AccountSpace } from '../apps/web/src/team/accounts/AccountSpace';
import { financeToday } from '@video-compressor/shared';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
import { accountsWorkspaceApi } from '../apps/web/src/api/team-accounts-workspace';
import { ToastProvider } from '../apps/web/src/components/toast';

vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => true, revision: 0 })
}));
vi.mock('../apps/web/src/team/labels/useTaskLabels', () => ({
  useTaskLabels: () => ({ labels: [] })
}));
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: { snapshot: vi.fn() } }));
vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({
  accountsWorkspaceApi: { overview: vi.fn() }
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const agent = {
  id: 'agent',
  accountId: 'account',
  teamId: 'live-finance',
  agentId: '123',
  runs: [],
  labels: [],
  balance: null,
  topup: null,
  taskCount: 0,
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
};
const account = {
  id: 'account',
  teamId: 'live-finance',
  name: 'Account',
  twoFactorSeed: null,
  agents: [agent],
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
};

it('shows one unified view and retains its finance draft across social collapse', async () => {
  vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue(null);
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue({
    schemaVersion: 1,
    coverage: 'complete',
    accounts: [account],
    socialOrderVersion: '0',
    agentOrderVersions: {}
  });
  const date = financeToday();
  vi.mocked(teamFinanceApi.snapshot).mockResolvedValue({
    schemaVersion: 1,
    teamId: 'live-finance',
    teamName: 'Finance',
    from: date,
    to: date,
    currency: 'USD',
    generatedAt: 'now',
    accounts: [{ id: account.id, name: account.name }],
    agents: [{ id: agent.id, agentId: agent.agentId }],
    placements: [
      {
        id: 'placement',
        accountId: account.id,
        agentRowId: agent.id,
        startsOn: '2026-01-01',
        endsOn: null,
        version: '0'
      }
    ],
    fields: []
  });
  render(
    <ToastProvider>
      <AccountSpace teamId="live-finance" />
    </ToastProvider>
  );
  const balance = await screen.findByRole('textbox', {
    name: new RegExp(`123 · ${date} · Balance · USD`)
  });
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  const row = balance.closest<HTMLElement>('[data-agent-row-id]');
  if (!row) throw new Error('Missing RK row');
  const fields = within(row).getAllByRole('textbox');
  expect(fields).toHaveLength(3);
  expect(fields.map(input => input.getAttribute('aria-label'))).toEqual([
    expect.stringContaining(`${date} · Balance · USD`),
    expect.stringContaining(`${date} · Top-up · USD`),
    expect.stringContaining(`${date} · Spend · Today · USD`)
  ]);
  expect(within(row).queryByText('Balance')).toBeNull();
  expect(within(row).queryByText('Top-up')).toBeNull();
  expect(within(row).queryByText('Spend')).toBeNull();
  expect(within(row).queryByRole('button', { name: /History/i })).toBeNull();
  expect(within(row).queryByRole('button', { name: /Archive/i })).toBeNull();
  const more = within(row).getByRole('button', { name: /^More actions for/ });
  fireEvent.click(more);
  expect(await screen.findByRole('menuitem', { name: 'History · Account · 123' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Archive Account-123' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  expect(teamFinanceApi.snapshot).toHaveBeenCalledWith(
    'live-finance',
    date,
    date,
    expect.any(String),
    true
  );
  expect(screen.queryByRole('button', { name: 'Daily finances' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Ad accounts and runs' })).toBeNull();
  fireEvent.change(balance, { target: { value: '125,35' } });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand Account' }));
  expect(
    (
      screen.getByRole('textbox', {
        name: new RegExp(`123 · ${date} · Balance · USD`)
      }) as HTMLInputElement
    ).value
  ).toBe('125,35');
});

it('refreshes account data from the workspace revision without owning another channel', async () => {
  const channel = vi.fn();
  vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue({
    channel
  } as unknown as NonNullable<ReturnType<typeof supabaseModule.getSupabaseClient>>);
  const list = vi.spyOn(teamApi, 'listAccounts').mockResolvedValue([account]);
  const view = renderHook(({ revision }) => useAccounts({ teamId: 'live-updates', revision }), {
    initialProps: { revision: 0 }
  });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  list.mockClear();
  view.rerender({ revision: 1 });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  expect(channel).not.toHaveBeenCalled();
  view.unmount();
});
