// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSupabaseClient } from '../apps/web/src/lib/supabase';
import { useTeamRealtime } from '../apps/web/src/team/useTeamRealtime';

vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('team Realtime cost boundary', () => {
  it.each([1, 100])('%i clients catch up locally without making provider calls', async members => {
    vi.useFakeTimers();
    const subscriptions: Array<(state: string) => void> = [];
    const events: Array<() => void> = [];
    const providerList = vi.fn();
    const catalogRead = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getSupabaseClient).mockReturnValue({
      channel: vi.fn(() => {
        const channel = {
          on: vi.fn((_kind: string, _filter: unknown, callback: () => void) => {
            events.push(callback);
            return channel;
          }),
          subscribe: vi.fn((callback: (state: string) => void) => {
            subscriptions.push(callback);
            return channel;
          })
        };
        return channel;
      }),
      removeChannel: vi.fn().mockResolvedValue(undefined)
    } as unknown as ReturnType<typeof getSupabaseClient>);

    const mounted = Array.from({ length: members }, () =>
      renderHook(() => useTeamRealtime({ teamId: 'team-1', onRefetch: catalogRead }))
    );
    act(() => subscriptions.forEach(callback => callback('SUBSCRIBED')));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(catalogRead).toHaveBeenCalledTimes(members);
    act(() => events.forEach(callback => callback()));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(catalogRead).toHaveBeenCalledTimes(members * 2);
    expect(providerList).not.toHaveBeenCalled();
    mounted.forEach(view => view.unmount());
  });
});
