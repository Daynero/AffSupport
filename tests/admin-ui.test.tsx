// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session, User } from '@supabase/supabase-js';
import type { Profile } from '../apps/web/src/lib/database.types';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc })
}));

import { AuthContextOverride, type AuthContextValue } from '../apps/web/src/auth/AuthContext';
import { adminAuthStub } from './support/auth-stub.js';
import AdminPage, { marketingCsv, parseAdminOverview } from '../apps/web/src/pages/AdminPage';

const user = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.com',
  app_metadata: { provider: 'google' },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-07-18T00:00:00.000Z'
} as User;
const session = { user, access_token: 'test', refresh_token: 'test', expires_in: 3600 } as Session;
const profile: Profile = {
  id: user.id,
  email: user.email ?? null,
  display_name: 'Admin',
  avatar_url: null,
  language: 'en',
  plan: 'free',
  account_status: 'active',
  marketing_consent: false,
  marketing_consent_at: null,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
  last_seen_at: '2026-07-18T00:00:00.000Z',
  onboarding_completed: true
};

function context(isAdmin: boolean): AuthContextValue {
  return adminAuthStub({ user, session, profile, isAdmin });
}

const overview = {
  total_users: 10,
  new_users_24h: 1,
  new_users_7d: 3,
  new_users_30d: 8,
  active_users_7d: 6,
  active_users_30d: 9,
  marketing_consent_users: 2,
  agent_connections: 7,
  compressor_opens: 12,
  compression_batches: 5,
  successful_compressions: 13,
  failed_compressions: 1,
  total_videos: 15,
  total_input_bytes: 100000,
  total_output_bytes: 60000,
  total_saved_bytes: 40000,
  average_saving_percent: 40,
  optimal_batches: 4,
  custom_batches: 1,
  image_embedding_batches: 2,
  videos_optimal: 11,
  videos_custom: 2,
  videos_with_image: 3
};

beforeEach(() => {
  localStorage.setItem('language', 'en');
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'admin_overview') return { data: overview, error: null };
    if (name === 'admin_daily_activity')
      return {
        data: [{ activity_date: '2026-07-18', active_users: 3, event_count: 9 }],
        error: null
      };
    if (name === 'admin_tool_usage')
      return { data: [{ category: 'mode', label: 'optimal', total: 4 }], error: null };
    if (name === 'admin_agent_versions')
      return { data: [{ agent_version: '0.4.0-test.1', total: 7 }], error: null };
    if (name === 'admin_list_users')
      return {
        data: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            email: 'user@example.com',
            display_name: 'User',
            language: 'en',
            plan: 'free',
            account_status: 'active',
            marketing_consent: true,
            marketing_consent_at: '2026-07-18T00:00:00.000Z',
            created_at: '2026-07-18T00:00:00.000Z',
            last_seen_at: '2026-07-18T00:00:00.000Z',
            total_count: 1
          }
        ],
        error: null
      };
    return { data: [], error: null };
  });
});

afterEach(() => cleanup());

/** 034 — the page opens on «Тарифи»; the analytics content is the second tab. */
function openAnalytics() {
  fireEvent.click(screen.getByRole('tab', { name: 'Analytics' }));
}

describe('database-authorized admin UI', () => {
  it('shows a 403-style screen for a non-admin without making admin queries', () => {
    render(
      <AuthContextOverride value={context(false)}>
        <AdminPage />
      </AuthContextOverride>
    );
    expect(screen.getByText('Administrator access required')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('loads real aggregate cards, activity and users for a confirmed admin', async () => {
    render(
      <AuthContextOverride value={context(true)}>
        <AdminPage />
      </AuthContextOverride>
    );
    openAnalytics();
    await waitFor(() => expect(screen.getByText('Total users')).toBeTruthy());
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('user@example.com')).toBeTruthy();
    expect(screen.getByText('0.4.0-test.1')).toBeTruthy();
    expect(rpc.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining([
        'admin_overview',
        'admin_daily_activity',
        'admin_tool_usage',
        'admin_agent_versions',
        'admin_list_users'
      ])
    );
  });

  it('draws the activity of a period with data and names a period without any', async () => {
    const chart = { name: 'Daily active users and events' };
    const view = render(
      <AuthContextOverride value={context(true)}>
        <AdminPage />
      </AuthContextOverride>
    );
    openAnalytics();
    await waitFor(() => expect(screen.getByRole('img', chart)).toBeTruthy());
    expect(screen.queryByText('No data for this period.')).toBeNull();
    view.unmount();

    // 070: a period without a single active day was 200px of empty axis with no word on it.
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name: string) =>
      name === 'admin_daily_activity'
        ? {
            data: [{ activity_date: '2026-07-18', active_users: 0, event_count: 0 }],
            error: null
          }
        : base(name)
    );
    render(
      <AuthContextOverride value={context(true)}>
        <AdminPage />
      </AuthContextOverride>
    );
    openAnalytics();
    await waitFor(() => expect(screen.getByText('No data for this period.')).toBeTruthy());
    expect(screen.queryByRole('img', chart)).toBeNull();
    expect(document.querySelector('.activity-card .chart-legend')).toBeNull();
  });

  it('rejects malformed aggregate responses', () => {
    expect(parseAdminOverview(overview)).toEqual(overview);
    expect(parseAdminOverview({ total_users: 1 })).toBeNull();
    expect(parseAdminOverview(['raw-event'])).toBeNull();
  });

  it('has no donation goal: the section and its RPCs are gone', async () => {
    render(
      <AuthContextOverride value={context(true)}>
        <AdminPage />
      </AuthContextOverride>
    );
    openAnalytics();
    await screen.findByText('user@example.com');
    expect(screen.queryByText('Donation goal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save goal' })).toBeNull();
    const called = rpc.mock.calls.map(([name]) => name);
    expect(called).not.toContain('admin_active_support_goal');
    expect(called).not.toContain('admin_update_support_goal');
  });

  it('exports only the consent list and neutralizes spreadsheet formulas', () => {
    const csv = marketingCsv([
      {
        email: '=cmd@example.com',
        display_name: '+Formula',
        language: 'en',
        marketing_consent_at: '2026-07-18T00:00:00.000Z'
      }
    ]);
    expect(csv.split('\n')[0]).toBe('email,display_name,language,marketing_consent_at');
    expect(csv).toContain("'=cmd@example.com");
    expect(csv).toContain("'+Formula");
    expect(csv).not.toContain('properties');
    expect(csv).not.toContain('token');
  });
});
