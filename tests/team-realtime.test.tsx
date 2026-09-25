// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSupabaseClient } from '../apps/web/src/lib/supabase';
import { useTeamRealtime } from '../apps/web/src/team/useTeamRealtime';
import { TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';

vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: vi.fn() }));

type Callback = () => void;
let events: Map<string, Callback>;
let status: (value: string) => void;
let removeChannel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  events = new Map();
  const channel = {
    on: vi.fn((_: string, filter: { table: string }, callback: Callback) => {
      events.set(filter.table, callback);
      return channel;
    }),
    subscribe: vi.fn((callback: (value: string) => void) => {
      status = callback;
      return channel;
    })
  };
  removeChannel = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getSupabaseClient).mockReturnValue({
    channel: vi.fn().mockReturnValue(channel),
    removeChannel
  } as unknown as ReturnType<typeof getSupabaseClient>);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('team Realtime invalidation', () => {
  it('subscribes only to published catalog and operation events and catches the subscribe race', async () => {
    const onRefetch = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTeamRealtime({ teamId: 'team-1', onRefetch }));
    expect([...events.keys()].sort()).toEqual(['team_catalog_events', 'team_operations']);
    act(() => status('SUBSCRIBED'));
    expect(result.current).toBe('connecting');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onRefetch).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('connected');
  });

  it('coalesces duplicate/out-of-order events and re-reads after an event during a read', async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>(resolve => {
      finishFirst = resolve;
    });
    const onRefetch = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    renderHook(() => useTeamRealtime({ teamId: 'team-1', onRefetch }));
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onRefetch).toHaveBeenCalledTimes(1);
    act(() => {
      events.get('team_catalog_events')!();
      events.get('team_catalog_events')!();
      events.get('team_operations')!();
    });
    act(() => finishFirst());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onRefetch).toHaveBeenCalledTimes(2);
  });

  it('catches up after reconnect and visibility, then removes the channel on exit', async () => {
    const onRefetch = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useTeamRealtime({ teamId: 'team-1', onRefetch }));
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => status('CHANNEL_ERROR'));
    expect(result.current).toBe('reconnecting');
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onRefetch).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onRefetch).toHaveBeenCalledTimes(3);
    unmount();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('keeps the channel stale until a failed authoritative read is retried successfully', async () => {
    const onRefetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary catalog read failure'))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useTeamRealtime({ teamId: 'team-1', onRefetch }));
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current).toBe('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onRefetch).toHaveBeenCalledTimes(2);
    expect(result.current).toBe('connected');
  });

  it('remounts the subscription on an explicit retry without reloading the page', async () => {
    const onRefetch = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ retryNonce }) => useTeamRealtime({ teamId: 'team-1', onRefetch, retryNonce }),
      { initialProps: { retryNonce: 0 } }
    );
    act(() => status('CHANNEL_ERROR'));
    rerender({ retryNonce: 1 });
    expect(removeChannel).toHaveBeenCalledTimes(1);
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('drops a removed membership after an authoritative team read', async () => {
    const team: TeamContextSnapshot = {
      id: '21000000-0000-4000-8000-000000000001',
      name: 'Team',
      role: 'owner',
      permissions: DEFAULT_ROLE_PERMISSIONS.owner,
      connectionState: 'connected'
    };
    localStorage.setItem('wishly.active-team.v1', team.id);
    const client = { listTeams: vi.fn().mockResolvedValueOnce([team]).mockResolvedValueOnce([]) };
    const { result } = renderHook(() => useTeam(), {
      wrapper: ({ children }) => (
        <TeamProvider initialTeams={[team]} client={client} realtime={false}>
          {children}
        </TeamProvider>
      )
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.refreshTeams();
    });
    expect(result.current.membershipLostTeamId).toBe(team.id);
    expect(result.current.activeTeam).toBeNull();
  });
});
