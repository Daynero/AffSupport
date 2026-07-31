// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const initialGoal = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  slug: 'mac-updates-apple-developer',
  currency: 'USD',
  target_cents: 9900,
  raised_cents: 0,
  title_en: 'Get rid of reinstalls',
  title_uk: 'Позбутися перевстановлень',
  description_en: 'English goal description.',
  description_uk: 'Опис цілі українською.',
  status: 'active',
  created_at: '2026-07-31T00:00:00.000Z',
  updated_at: '2026-07-31T00:00:00.000Z'
} as const;

const realtime = vi.hoisted(() => {
  const state: { handler: ((payload: { new: unknown }) => void) | null } = { handler: null };
  const query = {} as {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
  };
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.maybeSingle = vi.fn();

  const channel = {} as {
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  channel.on = vi.fn((_kind, _filter, handler) => {
    state.handler = handler;
    return channel;
  });
  channel.subscribe = vi.fn(callback => {
    callback('SUBSCRIBED');
    return channel;
  });

  const client = {
    from: vi.fn(() => query),
    channel: vi.fn(() => channel),
    removeChannel: vi.fn().mockResolvedValue('ok')
  };
  return { state, query, channel, client };
});

vi.mock('../apps/web/src/lib/supabase', () => ({
  getSupabaseClient: () => realtime.client
}));

import { SupportGoalProvider, useSupportGoal } from '../apps/web/src/support/SupportGoalContext';

function GoalProbe() {
  const { goal, loading } = useSupportGoal();
  return <span>{loading ? 'loading' : String(goal?.raised_cents ?? 'none')}</span>;
}

afterEach(() => {
  cleanup();
  realtime.state.handler = null;
  realtime.query.maybeSingle.mockReset();
  realtime.client.removeChannel.mockClear();
});

describe('support goal realtime synchronization', () => {
  it('replaces the visible amount as soon as Postgres broadcasts an update', async () => {
    realtime.query.maybeSingle.mockResolvedValue({ data: initialGoal, error: null });
    const view = render(
      <SupportGoalProvider>
        <GoalProbe />
      </SupportGoalProvider>
    );
    await waitFor(() => expect(screen.getByText('0')).toBeTruthy());

    act(() => {
      realtime.state.handler?.({
        new: {
          ...initialGoal,
          raised_cents: 3500,
          updated_at: '2026-07-31T12:00:00.000Z'
        }
      });
    });
    expect(screen.getByText('3500')).toBeTruthy();

    view.unmount();
    expect(realtime.client.removeChannel).toHaveBeenCalledOnce();
  });
});
