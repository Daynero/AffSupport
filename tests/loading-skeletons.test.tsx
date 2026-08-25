// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Session, User } from '@supabase/supabase-js';
import type { Profile } from '../apps/web/src/lib/database.types';
import { jobConfigurationKey } from '../packages/shared/src/types.js';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc })
}));

import { AuthContextOverride, type AuthContextValue } from '../apps/web/src/auth/AuthContext';
import { adminAuthStub } from './support/auth-stub.js';
import { JobRow } from '../apps/web/src/components/JobRow';
import { translate, type Language } from '../apps/web/src/i18n';
import AccountPage from '../apps/web/src/pages/AccountPage';
import AdminPage from '../apps/web/src/pages/AdminPage';
import type { Translate } from '../apps/web/src/components/ui';
import { customEncoding, makeJob } from './helpers.js';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.com',
  app_metadata: { provider: 'google' },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-07-18T00:00:00.000Z'
} as User;
const session = { user, access_token: 'test', refresh_token: 'test', expires_in: 3600 } as Session;
const profile: Profile = {
  id: user.id,
  email: user.email ?? null,
  display_name: 'Owner',
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

function authValue(patch: Partial<AuthContextValue> = {}): AuthContextValue {
  return adminAuthStub({ user, session, profile, isAdmin: false, ...patch });
}

const translator =
  (language: Language): Translate =>
  (key, values) =>
    translate(language, key, values);

beforeEach(() => {
  localStorage.setItem('language', 'en');
  rpc.mockReset();
});

afterEach(() => cleanup());

describe('account page loading skeleton', () => {
  it('renders geometry-matching placeholders instead of a blank page while the profile loads', () => {
    const { container } = render(
      <AuthContextOverride value={authValue({ user: null, profile: null })}>
        <AccountPage />
      </AuthContextOverride>
    );
    // The static heading stays real; the two cards render as skeletons.
    expect(screen.getByText('Your account')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(container.querySelectorAll('.account-card').length).toBe(2);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(8);
    // No real form controls yet.
    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(container.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
  });
});

describe('admin page loading skeleton', () => {
  it('shows skeleton metric cards, chart, breakdowns and table rows while queries run', () => {
    rpc.mockImplementation(() => new Promise(() => {})); // never settles
    const { container } = render(
      <AuthContextOverride value={authValue({ isAdmin: true })}>
        <AdminPage />
      </AuthContextOverride>
    );
    const status = screen.getByRole('status');
    expect(status.classList.contains('admin-skeleton')).toBe(true);
    // Geometry mirrors the loaded dashboard: 23 metric cards + activity +
    // two breakdown cards + users card.
    expect(container.querySelectorAll('.metric-card').length).toBe(23);
    expect(container.querySelector('.activity-card .skeleton-chart')).toBeTruthy();
    expect(container.querySelectorAll('.breakdown-card').length).toBe(2);
    expect(container.querySelectorAll('.skeleton-table-row').length).toBe(5);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(30);
  });

  it('crossfades the loaded dashboard in place of the skeleton', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'admin_overview')
        return {
          data: Object.fromEntries(
            [
              'total_users',
              'new_users_24h',
              'new_users_7d',
              'new_users_30d',
              'active_users_7d',
              'active_users_30d',
              'marketing_consent_users',
              'agent_connections',
              'compressor_opens',
              'compression_batches',
              'successful_compressions',
              'failed_compressions',
              'total_videos',
              'total_input_bytes',
              'total_output_bytes',
              'total_saved_bytes',
              'average_saving_percent',
              'optimal_batches',
              'custom_batches',
              'image_embedding_batches',
              'videos_optimal',
              'videos_custom',
              'videos_with_image'
            ].map(key => [key, 1])
          ),
          error: null
        };
      return { data: [], error: null };
    });
    const { container } = render(
      <AuthContextOverride value={authValue({ isAdmin: true })}>
        <AdminPage />
      </AuthContextOverride>
    );
    expect(container.querySelector('.admin-skeleton')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Total users')).toBeTruthy());
    expect(container.querySelector('.admin-skeleton')).toBeNull();
    // The mount saw the skeleton, so real data enters with the crossfade class.
    expect(container.querySelector('.admin-loaded.content-appear')).toBeTruthy();
  });
});

describe('estimate → result morph', () => {
  const rowProps = {
    selected: false,
    disabled: false,
    compressionRunning: false,
    language: 'en' as const,
    onSelected: () => {},
    action: () => {},
    t: translator('en')
  };

  it('renders both phases while a job completes, then settles on the result panel', async () => {
    const processing = makeJob('morph-job', 'processing', {
      encoding: { ...customEncoding },
      estimateStatus: 'estimated',
      estimatedOutputBytes: 6000,
      estimatedSavingPercent: 40,
      estimateKey: jobConfigurationKey(customEncoding, null),
      startedAt: 1000
    });
    const { container, rerender } = render(<JobRow job={processing} {...rowProps} />);
    expect(screen.getByText('Expected result')).toBeTruthy();
    expect(screen.queryByText('Ready file')).toBeNull();

    const completed = {
      ...processing,
      status: 'completed' as const,
      progress: 100,
      finalSize: 5000,
      finalWidth: 1280,
      finalHeight: 720,
      finalFrameRate: 30,
      finalBitrate: 2_000_000,
      finalDurationSeconds: 10,
      finalCodec: 'h264',
      finishedAt: 6000
    };
    rerender(<JobRow job={completed} {...rowProps} />);

    // During the morph both phases are mounted inside the shared slot; the
    // outgoing estimate is hidden from assistive tech.
    expect(container.querySelector('.outcome-slot.is-morphing')).toBeTruthy();
    expect(screen.getByText('Expected result')).toBeTruthy();
    expect(screen.getByText('Ready file')).toBeTruthy();
    expect(container.querySelector('.outcome-phase-estimate')?.getAttribute('aria-hidden')).toBe(
      'true'
    );

    // After --dur-complete the estimate phase unmounts and only the result stays.
    await waitFor(() => expect(screen.queryByText('Expected result')).toBeNull(), {
      timeout: 2000
    });
    expect(screen.getByText('Ready file')).toBeTruthy();
    expect(container.querySelector('.outcome-slot.is-morphing')).toBeNull();
  });

  it('renders a completed job statically with only the result phase (no morph)', () => {
    const completed = makeJob('static-completed', 'completed', {
      finalSize: 5000,
      finalWidth: 1280,
      finalHeight: 720,
      finalFrameRate: 30,
      finalBitrate: 2_000_000,
      finalDurationSeconds: 10,
      finalCodec: 'h264',
      startedAt: 1000,
      finishedAt: 6000
    });
    const { container } = render(<JobRow job={completed} {...rowProps} />);
    expect(screen.getByText('Ready file')).toBeTruthy();
    expect(screen.queryByText('Expected result')).toBeNull();
    expect(container.querySelector('.outcome-slot.is-morphing')).toBeNull();
  });
});
