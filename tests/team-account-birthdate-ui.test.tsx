// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  financeToday,
  type FinanceSnapshot,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { AccountSpace } from '../apps/web/src/team/accounts/AccountSpace';
import { previousFinanceDay } from '../apps/web/src/team/accounts/finance/UnifiedFinance';
import { ToastProvider } from '../apps/web/src/components/toast';
import { accountsWorkspaceApi } from '../apps/web/src/api/team-accounts-workspace';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
import { teamApi } from '../apps/web/src/api/team';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
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
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('creates a SOC and RK on yesterday, refreshes editable finance, and hides them only before their effective day', async () => {
  const today = financeToday();
  const yesterday = previousFinanceDay(today);
  const audit = new Date().toISOString();
  const accounts: TeamAccountSummary[] = [
    {
      id: 'legacy',
      teamId: 'team',
      name: 'Legacy',
      createdAt: '2020-01-01',
      updatedAt: audit,
      agents: []
    }
  ];
  vi.mocked(accountsWorkspaceApi.overview).mockImplementation(async () => ({
    schemaVersion: 1,
    coverage: 'complete',
    socialOrderVersion: '0',
    agentOrderVersions: {},
    accounts: accounts.map(account => ({
      ...account,
      twoFactorSeed: account.twoFactorSeed ?? null,
      agents: [...account.agents]
    }))
  }));
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(
    async (_team, from, to): Promise<FinanceSnapshot> => ({
      schemaVersion: 2,
      teamId: 'team',
      teamName: 'Team',
      from,
      to,
      currency: 'USD',
      generatedAt: audit,
      accounts: accounts.map(row => ({ id: row.id, name: row.name })),
      agents: accounts.flatMap(row =>
        row.agents.map(agent => ({ id: agent.id, agentId: agent.agentId }))
      ),
      placements: accounts.flatMap(row =>
        row.agents.map(agent => ({
          id: `p-${agent.id}`,
          agentRowId: agent.id,
          accountId: row.id,
          startsOn: agent.startsOn ?? '2020-01-01',
          endsOn: null,
          version: '0'
        }))
      ),
      fields: [],
      lifecycle: {
        accounts: accounts.map(row => ({
          id: row.id,
          createdAt: row.createdAt,
          ...(row.startsOn ? { startsOn: row.startsOn } : {}),
          archivedAt: null,
          version: '0',
          sortRank: 0
        })),
        agents: accounts.flatMap(row =>
          row.agents.map(agent => ({
            id: agent.id,
            accountId: row.id,
            createdAt: agent.createdAt,
            startsOn: agent.startsOn,
            archivedAt: null,
            version: '0',
            sortRank: 0
          }))
        ),
        events: [],
        parents: []
      }
    })
  );
  const create = vi.spyOn(teamApi, 'createAccount').mockImplementation(async input => {
    const created: TeamAccountSummary = {
      id: 'new',
      teamId: 'team',
      name: input.name,
      startsOn: input.startsOn,
      createdAt: audit,
      updatedAt: audit,
      agents: []
    };
    accounts.push(created);
    return { ...created, agents: [] };
  });
  const add = vi.spyOn(teamApi, 'addAccountAgent').mockImplementation(async input => {
    const row = {
      id: 'new-rk',
      accountId: input.accountId,
      teamId: 'team',
      agentId: input.agentId,
      startsOn: input.startsOn,
      createdAt: audit,
      updatedAt: audit,
      runs: [],
      labels: [],
      balance: null,
      topup: null,
      taskCount: 0
    };
    accounts.find(account => account.id === input.accountId)!.agents.push(row);
    return row;
  });
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  await screen.findByRole('region', { name: 'Legacy' });
  await user.click(screen.getByRole('button', { name: 'Yesterday' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Yesterday' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  );
  await user.click(screen.getByRole('button', { name: 'Add account' }));
  await user.type(screen.getByRole('textbox', { name: /^Account name/ }), 'PastSOC{Enter}');
  await screen.findByRole('textbox', { name: /^Social account 2FA key/ });
  await user.keyboard('{Enter}');
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      teamId: 'team',
      name: 'PastSOC',
      startsOn: yesterday,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
  );
  await user.type(await screen.findByRole('textbox', { name: 'Full ad account ID' }), '926{Enter}');
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'new', agentId: '926', startsOn: yesterday })
    )
  );
  await user.keyboard('{Escape}');
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: /PastSOC.*Balance.*USD/ }) as HTMLInputElement).disabled
    ).toBe(false)
  );
  expect(screen.getByRole('region', { name: 'PastSOC' })).toBeTruthy();
  const createFlow = vi
    .mocked(emitAccountSignal)
    .mock.calls.find(
      ([action, stage, props]) =>
        action === 'retained_action' && stage === 'requested' && props.operation === 'createAccount'
    )?.[2].flowId;
  for (const stage of ['requested', 'accepted', 'applied'])
    expect(emitAccountSignal).toHaveBeenCalledWith(
      'retained_action',
      stage,
      expect.objectContaining({ flowId: createFlow, operation: 'createAccount', day: 'previous' })
    );
  await user.click(screen.getByRole('button', { name: 'Previous period' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'PastSOC' })).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Today' }));
  await screen.findByRole('region', { name: 'PastSOC' });
  expect(accounts.find(row => row.id === 'new')?.createdAt).toBe(audit);
  expect(accounts.find(row => row.id === 'new')?.agents[0]?.createdAt).toBe(audit);
}, 15_000);

it('keeps a social visible as empty before the birth of its first RK', async () => {
  const today = financeToday();
  const yesterday = previousFinanceDay(today);
  const audit = new Date().toISOString();
  const row: TeamAccountSummary = {
    id: 'social',
    teamId: 'team',
    name: 'EarlierSOC',
    startsOn: yesterday,
    createdAt: audit,
    updatedAt: audit,
    agents: [
      {
        id: 'later-rk',
        accountId: 'social',
        teamId: 'team',
        agentId: '927',
        startsOn: today,
        createdAt: audit,
        updatedAt: audit,
        runs: [],
        labels: [],
        balance: null,
        topup: null,
        taskCount: 0
      }
    ]
  };
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue({
    schemaVersion: 1,
    coverage: 'complete',
    socialOrderVersion: '0',
    agentOrderVersions: {},
    accounts: [{ ...row, twoFactorSeed: null }]
  });
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from,
    to,
    currency: 'USD',
    generatedAt: audit,
    accounts: [{ id: row.id, name: row.name }],
    agents: [{ id: 'later-rk', agentId: '927' }],
    placements: [
      {
        id: 'p',
        agentRowId: 'later-rk',
        accountId: row.id,
        startsOn: today,
        endsOn: null,
        version: '0'
      }
    ],
    fields: []
  }));
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  await screen.findByRole('region', { name: 'EarlierSOC' });
  await user.click(screen.getByRole('button', { name: 'Yesterday' }));
  await waitFor(() => expect(screen.queryByLabelText('EarlierSOC-927')).toBeNull());
  expect(screen.getByRole('region', { name: 'EarlierSOC' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Previous period' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'EarlierSOC' })).toBeNull());
});
