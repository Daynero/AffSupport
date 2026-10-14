// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamAccountSummary } from '@video-compressor/shared';
import { teamApi } from '../apps/web/src/api/team';
import * as supabaseModule from '../apps/web/src/lib/supabase';
import { useAccounts } from '../apps/web/src/team/accounts/useAccounts';

const TEAM = '8a000000-0000-4000-8000-000000000001';
const A = '8a000000-0000-4000-8000-000000000002';
const B = '8a000000-0000-4000-8000-000000000003';
const C = '8a000000-0000-4000-8000-000000000004';
const G1 = '8a000000-0000-4000-8000-000000000005';
const G2 = '8a000000-0000-4000-8000-000000000006';

function row(id: string, agentIds: string[] = []): TeamAccountSummary {
  return {
    id,
    teamId: TEAM,
    name: id,
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    agents: agentIds.map(agentId => ({
      id: agentId,
      accountId: id,
      teamId: TEAM,
      agentId,
      createdAt: '2026-10-01',
      updatedAt: '2026-10-01',
      runs: [],
      labels: [],
      balance: null,
      topup: null,
      taskCount: 0
    }))
  };
}

afterEach(() => vi.restoreAllMocks());

describe('saved account order across two clients', () => {
  it('updates both scopes after Realtime and resolves a stale version to canonical order', async () => {
    let rows = [row(A, [G1, G2]), row(B), row(C)];
    let socialVersion = 0;
    let agentVersion = 0;
    const listeners: Array<(event: unknown) => void> = [];
    const connection = {
      channel: vi.fn(() => {
        const channel = {
          on: vi.fn(
            (_kind: string, filter: { table: string }, callback: (event: unknown) => void) => {
              if (filter.table === 'team_accounts' || filter.table === 'team_account_agents')
                listeners.push(callback);
              return channel;
            }
          ),
          subscribe: vi.fn(() => channel)
        };
        return channel;
      }),
      removeChannel: vi.fn()
    };
    vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue(
      connection as unknown as NonNullable<ReturnType<typeof supabaseModule.getSupabaseClient>>
    );
    const list = vi.spyOn(teamApi, 'listAccounts').mockImplementation(async () => rows);
    vi.spyOn(teamApi, 'getAccountOrder').mockImplementation(async () => ({
      socialsVersion: socialVersion,
      socialIds: rows.map(item => item.id),
      agents: Object.fromEntries(
        rows.map(item => [
          item.id,
          {
            version: item.id === A ? agentVersion : 0,
            ids: item.agents.map(agent => agent.id)
          }
        ])
      )
    }));
    const reorder = vi.spyOn(teamApi, 'reorderAccounts').mockImplementation(async input => {
      const version = input.scopeId === TEAM ? socialVersion : agentVersion;
      const canonical =
        input.scopeId === TEAM
          ? rows.map(item => item.id)
          : rows.find(item => item.id === A)!.agents.map(agent => agent.id);
      if (input.expectedVersion !== version) return { status: 'conflict', version, ids: canonical };
      if (input.scopeId === TEAM) {
        rows = input.ids.map(id => rows.find(item => item.id === id)!);
        socialVersion += 1;
        return { status: 'applied', version: socialVersion, ids: input.ids };
      }
      rows = rows.map(item =>
        item.id === A
          ? {
              ...item,
              agents: input.ids.map(id => item.agents.find(agent => agent.id === id)!)
            }
          : item
      );
      agentVersion += 1;
      return { status: 'applied', version: agentVersion, ids: input.ids };
    });
    const first = renderHook(() => useAccounts({ teamId: TEAM }));
    const second = renderHook(() => useAccounts({ teamId: TEAM }));
    await waitFor(() => expect(second.result.current.orderSnapshot?.socialsVersion).toBe(0));

    await act(async () => {
      expect(await first.result.current.reorderScope(TEAM, [C, A, B])).toMatchObject({
        status: 'applied'
      });
    });
    act(() => listeners.forEach(listener => listener({})));
    await waitFor(() =>
      expect(second.result.current.accounts.map(item => item.id)).toEqual([C, A, B])
    );
    expect(second.result.current.orderSnapshot?.socialsVersion).toBe(1);

    await act(async () => {
      expect(await second.result.current.reorderScope(A, [G2, G1])).toMatchObject({
        status: 'applied'
      });
    });
    act(() => listeners.forEach(listener => listener({})));
    await waitFor(() =>
      expect(first.result.current.orderSnapshot?.agents[A]?.ids).toEqual([G2, G1])
    );

    rows = [row(B), row(C), row(A, [G2, G1])];
    socialVersion = 2;
    list.mockRejectedValueOnce(new Error('READ_OFFLINE'));
    await act(async () => {
      expect(await first.result.current.reorderScope(TEAM, [A, B, C])).toMatchObject({
        status: 'conflict'
      });
    });
    expect(first.result.current.accounts.map(item => item.id)).toEqual([B, C, A]);
    expect(first.result.current.orderSnapshot?.socialsVersion).toBe(2);
    expect(first.result.current.error).toBe('READ_OFFLINE');
    expect(reorder).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 1 }));
    first.unmount();
    second.unmount();
    expect(connection.removeChannel).toHaveBeenCalledTimes(2);
  });

  it('keeps canonical order after a permission refusal', async () => {
    const rows = [row(A), row(B)];
    vi.spyOn(supabaseModule, 'getSupabaseClient').mockReturnValue(null);
    vi.spyOn(teamApi, 'listAccounts').mockResolvedValue(rows);
    vi.spyOn(teamApi, 'getAccountOrder').mockResolvedValue({
      socialsVersion: 3,
      socialIds: [A, B],
      agents: { [A]: { version: 0, ids: [] }, [B]: { version: 0, ids: [] } }
    });
    vi.spyOn(teamApi, 'reorderAccounts').mockRejectedValue(new Error('PERMISSION_DENIED'));
    const view = renderHook(() => useAccounts({ teamId: TEAM }));
    await waitFor(() => expect(view.result.current.orderSnapshot?.socialsVersion).toBe(3));
    await act(async () => {
      await expect(view.result.current.reorderScope(TEAM, [B, A])).rejects.toThrow(
        'PERMISSION_DENIED'
      );
    });
    expect(view.result.current.accounts.map(item => item.id)).toEqual([A, B]);
  });
});
