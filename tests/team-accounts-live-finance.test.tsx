// @vitest-environment jsdom
import React, { type ComponentProps } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { teamApi } from '../apps/web/src/api/team';
import * as supabaseModule from '../apps/web/src/lib/supabase';
import { useAccounts } from '../apps/web/src/team/accounts/useAccounts';
import { AccountSpace } from '../apps/web/src/team/accounts/AccountSpace';
import type { FinanceWorkspace } from '../apps/web/src/team/accounts/finance/FinanceWorkspace';
import { ToastProvider } from '../apps/web/src/components/toast';

vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => true, revision: 0 })
}));
vi.mock('../apps/web/src/team/labels/useTaskLabels', () => ({
  useTaskLabels: () => ({ labels: [] })
}));
vi.mock('../apps/web/src/team/accounts/finance/FinanceWorkspace', () => ({
  FinanceWorkspace: (props: ComponentProps<typeof FinanceWorkspace>) => (
    <section aria-label="Finance fixture">
      <input aria-label="Finance draft" defaultValue="" />
      <button onClick={() => void props.onToggleLabel?.(props.agents![0], 'label', true)}>
        Attach finance tag
      </button>
      <button onClick={() => void props.onToggleLabel?.(props.agents![0], 'label', false)}>
        Detach finance tag
      </button>
    </section>
  )
}));

afterEach(() => vi.restoreAllMocks());

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
  agents: [agent],
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
};

it('keeps a finance draft while switching views and updates its agent tags', async () => {
  vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue(null);
  vi.spyOn(teamApi, 'listAccounts').mockResolvedValue([account]);
  const attach = vi.spyOn(teamApi, 'attachAgentLabel').mockResolvedValue(agent);
  const detach = vi.spyOn(teamApi, 'detachAgentLabel').mockResolvedValue(agent);
  render(
    <ToastProvider>
      <AccountSpace teamId="live-finance" />
    </ToastProvider>
  );
  await waitFor(() => expect(screen.getByRole('region', { name: 'Account' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Daily finances' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Finance draft' }), {
    target: { value: 'unsaved' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Attach finance tag' }));
  await waitFor(() =>
    expect(attach).toHaveBeenCalledWith({
      teamId: 'live-finance',
      agentRowId: 'agent',
      labelId: 'label'
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Detach finance tag' }));
  await waitFor(() => expect(detach).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Agents and runs' }));
  fireEvent.click(screen.getByRole('button', { name: 'Daily finances' }));
  expect((screen.getByRole('textbox', { name: 'Finance draft' }) as HTMLInputElement).value).toBe(
    'unsaved'
  );
});

it('coalesces finance realtime changes, refreshes accounts and unsubscribes on exit', async () => {
  const callbacks = new Map<string, () => void>();
  const channel = {
    on: vi.fn((_event: string, filter: { table: string }, callback: () => void) => {
      callbacks.set(filter.table, callback);
      return channel;
    }),
    subscribe: vi.fn((callback: (status: string) => void) => {
      callback('SUBSCRIBED');
      return channel;
    })
  };
  const removeChannel = vi.fn();
  const connection = { channel: vi.fn(() => channel), removeChannel };
  vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue(
    connection as unknown as NonNullable<ReturnType<typeof supabaseModule.getSupabaseClient>>
  );
  const list = vi.spyOn(teamApi, 'listAccounts').mockResolvedValue([account]);
  const notification = vi.fn();
  window.addEventListener('soty:accounts-finance', notification);
  const view = renderHook(() => useAccounts({ teamId: 'live-updates' }));
  try {
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    list.mockClear();
    act(() => {
      callbacks.get('team_agent_finance_values')!();
      callbacks.get('team_agent_placements')!();
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(notification).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(removeChannel).toHaveBeenCalledWith(channel);
  } finally {
    window.removeEventListener('soty:accounts-finance', notification);
  }
});
