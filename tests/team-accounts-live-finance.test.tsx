// @vitest-environment jsdom
import React from 'react';
import userEvent from '@testing-library/user-event';
import {
  cleanup,
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { teamApi } from '../apps/web/src/api/team';
import { agentReleaseApi } from '../apps/web/src/api/team-agent-release';
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
vi.mock('../apps/web/src/api/team-agent-release', () => ({
  agentReleaseApi: { read: vi.fn(), release: vi.fn() }
}));
vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({
  accountsWorkspaceApi: { overview: vi.fn() }
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

it('remeasures the table when the toolbar wraps and ignores hidden retained geometry', async () => {
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
    teamId: 'resize',
    teamName: 'Resize',
    from: date,
    to: date,
    currency: 'USD',
    generatedAt: 'now',
    accounts: [],
    agents: [],
    placements: [],
    fields: []
  });
  let top = 210;
  let visible = true;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(0, this.classList.contains('team-accounts-table') ? top : 0, 600, 80);
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    () =>
      Object.assign(visible ? [new DOMRect(0, 0, 600, 500)] : [], {
        item: () => null
      }) as unknown as DOMRectList
  );
  const observers: Array<{ targets: Set<Element>; callback: () => void }> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets = new Set<Element>();
      constructor(callback: () => void) {
        observers.push({ targets: this.targets, callback });
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    }
  );
  const view = render(
    <ToastProvider>
      <AccountSpace teamId="resize" />
    </ToastProvider>
  );
  await waitFor(() => expect(document.querySelector('.team-accounts-table')).not.toBeNull());
  const surface = document.querySelector<HTMLElement>('.team-account-space')!;
  const toolbar = document.querySelector('.team-accounts-sticky')!;
  const observer = observers.find(
    entry => entry.targets.has(surface) && entry.targets.has(toolbar)
  );
  expect(observer).toBeDefined();
  expect(surface.style.getPropertyValue('--team-accounts-table-offset')).toBe('210px');
  top = 330;
  act(() => observer!.callback());
  expect(surface.style.getPropertyValue('--team-accounts-table-offset')).toBe('330px');
  visible = false;
  top = 0;
  act(() => observer!.callback());
  expect(surface.style.getPropertyValue('--team-accounts-table-offset')).toBe('330px');
  visible = true;
  top = 180;
  act(() => observer!.callback());
  expect(surface.style.getPropertyValue('--team-accounts-table-offset')).toBe('180px');
  view.unmount();
  expect(observer!.targets.size).toBe(0);
});

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

it('keeps an active g4 social and its add-RK action when all old RKs are archived', async () => {
  vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue(null);
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue({
    schemaVersion: 1,
    coverage: 'complete',
    socialOrderVersion: '0',
    agentOrderVersions: {},
    accounts: [
      { ...account, name: 'g4', agents: [{ ...agent, archivedAt: '2026-10-01T00:00:00Z' }] }
    ]
  });
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    schemaVersion: 1,
    teamId: 'g4-regression',
    teamName: 'Team',
    from,
    to,
    generatedAt: new Date().toISOString(),
    currency: 'USD',
    accounts: [],
    agents: [],
    placements: [],
    fields: []
  }));
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AccountSpace teamId="g4-regression" />
    </ToastProvider>
  );
  expect(await screen.findByRole('button', { name: 'Collapse g4' })).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'g4' })).getByRole('button', {
      name: 'Add ad account'
    })
  ).toBeTruthy();
  expect(document.querySelector('[data-agent-row-id="agent"]')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Yesterday' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Yesterday' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  );
  await user.click(
    within(screen.getByRole('region', { name: 'g4' })).getByRole('button', {
      name: 'Add ad account'
    })
  );
  expect(await screen.findByRole('textbox', { name: 'Full ad account ID' })).toBeTruthy();
});

async function startBulkRelease(versionChanged = false) {
  vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue(null);
  let released = false;
  const beforeAgent = {
    ...agent,
    runs: [
      { id: 'manual', note: 'Manual work', createdAt: new Date().toISOString(), marker: null }
    ],
    availability: { status: 'busy' as const, assignmentCount: 1, legacyCount: 0 }
  };
  const afterAgent = {
    ...agent,
    availability: { status: 'free' as const, assignmentCount: 0, legacyCount: 0 }
  };
  vi.mocked(accountsWorkspaceApi.overview).mockImplementation(async () => ({
    schemaVersion: 1,
    coverage: 'complete',
    socialOrderVersion: '0',
    agentOrderVersions: {},
    accounts: [{ ...account, agents: [released ? afterAgent : beforeAgent] }],
    launchAssignments: [],
    assignmentCoverage: 'complete'
  }));
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    schemaVersion: 1,
    teamId: 'bulk-undo',
    teamName: 'Team',
    from,
    to,
    generatedAt: new Date().toISOString(),
    currency: 'USD',
    accounts: [],
    agents: [],
    placements: [],
    fields: []
  }));
  vi.mocked(agentReleaseApi.read)
    .mockReset()
    .mockResolvedValueOnce({ agentRowId: agent.id, version: 'captured' })
    .mockResolvedValueOnce({
      agentRowId: agent.id,
      version: versionChanged ? 'changed' : 'captured'
    });
  vi.mocked(agentReleaseApi.release)
    .mockReset()
    .mockImplementation(async () => {
      released = true;
      return { agentRowId: agent.id, version: 'released' };
    });
  const add = vi.spyOn(teamApi, 'addAgentRun').mockImplementation(async input => ({
    ...afterAgent,
    runs: [{ id: 'restored', note: input.note, createdAt: new Date().toISOString(), marker: null }],
    availability: { status: 'busy', assignmentCount: 0, legacyCount: 0 }
  }));
  render(
    <ToastProvider>
      <AccountSpace teamId="bulk-undo" />
    </ToastProvider>
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Make free Account-123/ }));
  return add;
}
it('retains the manual entries in bulk release and offers their explicit restoration', async () => {
  const add = await startBulkRelease();
  const restore = await screen.findByRole('button', { name: 'Restore manual entries' });
  expect(agentReleaseApi.release).toHaveBeenCalledWith(
    expect.objectContaining({ expectedVersion: 'captured' })
  );
  fireEvent.click(restore);
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith({
      teamId: 'bulk-undo',
      agentRowId: agent.id,
      note: 'Manual work'
    })
  );
  expect(screen.getByText('Manual work')).toBeTruthy();
});
it('refuses bulk deletion when the snapshot changes before its manual recovery copy is captured', async () => {
  await startBulkRelease(true);
  await waitFor(() => expect(agentReleaseApi.read).toHaveBeenCalledTimes(2));
  expect(agentReleaseApi.release).not.toHaveBeenCalled();
  expect(screen.getByText('Manual work')).toBeTruthy();
});
