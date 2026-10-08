// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSupabaseClient } from '../apps/web/src/lib/supabase';
import { useTeamRealtime } from '../apps/web/src/team/useTeamRealtime';
import { TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';

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
  it('keeps the workspace stale when teams refresh but its catalog read fails, then recovers on retry', async () => {
    const team: TeamContextSnapshot = {
      id: '21000000-0000-4000-8000-000000000001',
      name: 'Team',
      role: 'owner',
      permissions: DEFAULT_ROLE_PERMISSIONS.owner,
      connectionState: 'connected'
    };
    window.history.replaceState(null, '', `/team/${team.id}`);
    localStorage.setItem('wishly.active-team.v1', team.id);
    const client = {
      listTeams: vi.fn(async () => [team]),
      listFolderPage: vi.fn().mockRejectedValue(new Error('offline'))
    };
    const view = renderHook(
      () => {
        const context = useTeam();
        const page = useFolderPage({
          teamId: team.id,
          client,
          parentFolderId: null,
          revision: context.revision
        });
        return { context, page };
      },
      {
        wrapper: ({ children }) => (
          <TeamProvider initialTeams={[team]} client={client}>
            {children}
          </TeamProvider>
        )
      }
    );
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(client.listTeams).toHaveBeenCalled();
    expect(view.result.current.page.error).toBe(true);
    expect(view.result.current.context.realtimeState).toBe('reconnecting');
    client.listFolderPage.mockResolvedValue({ rows: [], total: 0, next: null });
    act(() => view.result.current.context.retryRealtime());
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(view.result.current.page.error).toBe(false);
    expect(view.result.current.context.realtimeState).toBe('connected');
    window.history.replaceState(null, '', '/');
  });
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

  it('does not let an older catalog response clear a newer invalidation', async () => {
    const team: TeamContextSnapshot = {
      id: '21000000-0000-4000-8000-000000000002',
      name: 'Team',
      role: 'owner',
      permissions: DEFAULT_ROLE_PERMISSIONS.owner,
      connectionState: 'connected'
    };
    window.history.replaceState(null, '', `/team/${team.id}`);
    localStorage.setItem('wishly.active-team.v1', team.id);
    const empty = { rows: [], total: 0, next: null };
    const client = {
      listTeams: vi.fn(async () => [team]),
      listFolderPage: vi.fn().mockResolvedValue(empty)
    };
    const view = renderHook(
      () => {
        const context = useTeam();
        useFolderPage({
          teamId: team.id,
          client,
          parentFolderId: null,
          revision: context.revision
        });
        return context;
      },
      {
        wrapper: ({ children }) => (
          <TeamProvider initialTeams={[team]} client={client}>
            {children}
          </TeamProvider>
        )
      }
    );
    act(() => status('SUBSCRIBED'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(view.result.current.realtimeState).toBe('connected');
    let first!: (value: typeof empty) => void;
    let second!: (value: typeof empty) => void;
    client.listFolderPage
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            first = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            second = resolve;
          })
      );
    act(() => events.get('team_catalog_events')!());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => events.get('team_catalog_events')!());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => first(empty));
    expect(view.result.current.realtimeState).toBe('reconnecting');
    await act(async () => second(empty));
    expect(view.result.current.realtimeState).toBe('connected');
    window.history.replaceState(null, '', '/');
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

describe('delivery does not wait for membership (028, release C)', () => {
  it('a realtime refetch bumps the materials revision before awaiting membership, and a failed membership read still delivers it', async () => {
    const team: TeamContextSnapshot = {
      id: '21000000-0000-4000-8000-000000000002',
      name: 'Team',
      role: 'owner',
      permissions: DEFAULT_ROLE_PERMISSIONS.owner,
      connectionState: 'connected'
    };
    window.history.replaceState(null, '', `/team/${team.id}`);
    localStorage.setItem('wishly.active-team.v1', team.id);
    let releaseTeams!: () => void;
    const client = {
      listTeams: vi
        .fn()
        .mockResolvedValueOnce([team])
        .mockImplementationOnce(
          () =>
            new Promise<TeamContextSnapshot[]>(resolve => {
              releaseTeams = () => resolve([team]);
            })
        )
        .mockRejectedValueOnce(new Error('membership offline')),
      listFolderPage: vi.fn().mockResolvedValue({ rows: [], total: 0, next: null })
    };
    const view = renderHook(() => useTeam(), {
      wrapper: ({ children }) => (
        <TeamProvider client={client as never} initialTeams={[team]}>
          {children}
        </TeamProvider>
      )
    });
    await act(async () => {
      status('SUBSCRIBED');
      await vi.advanceTimersByTimeAsync(1_100);
    });
    // The membership read is still pending; the revision has already moved.
    const after = view.result.current.revision;
    expect(after).toBeGreaterThan(0);
    await act(async () => {
      releaseTeams();
      await Promise.resolve();
    });
    await act(async () => {
      events.get('team_catalog_events')?.();
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(view.result.current.revision).toBeGreaterThan(after);
  });

  it('an unsubscribed channel of the previous team never invalidates the new team', async () => {
    const onRefetch = vi.fn();
    const view = renderHook(({ teamId }) => useTeamRealtime({ teamId, onRefetch }), {
      initialProps: { teamId: 'team-a' }
    });
    const oldStatus = status;
    const oldEvent = events.get('team_catalog_events')!;
    view.rerender({ teamId: 'team-b' });
    expect(removeChannel).toHaveBeenCalledTimes(1);
    oldStatus('SUBSCRIBED');
    oldEvent();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(onRefetch).not.toHaveBeenCalled();
  });
});
