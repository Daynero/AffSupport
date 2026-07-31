// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const analyticsTrack = vi.hoisted(() => vi.fn());
const goalState = vi.hoisted(() => ({
  goal: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    slug: 'mac-updates-apple-developer',
    currency: 'USD',
    target_cents: 9900,
    raised_cents: 2400,
    title_en: 'Get rid of reinstalls',
    title_uk: 'Позбутися перевстановлень',
    description_en: 'The Apple Developer Program enables signed builds and safer Wishly updates.',
    description_uk:
      'Apple Developer Program дає змогу підписувати збірки та безпечніше оновлювати Wishly.',
    status: 'active',
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z'
  }
}));

vi.mock('../apps/web/src/support/SupportGoalContext', () => ({
  useSupportGoal: () => ({ goal: goalState.goal, loading: false, refresh: vi.fn() })
}));
vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: analyticsTrack, setLocale: vi.fn() }
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr') }
}));

import { SupportButton } from '../apps/web/src/components/SupportDialog';
import {
  formatSupportAmount,
  parseSupportAmountInput,
  parseSupportGoal,
  supportGoalProgress
} from '../apps/web/src/support/goals';

beforeEach(() => {
  localStorage.setItem('language', 'en');
  analyticsTrack.mockReset();
});

afterEach(() => cleanup());

describe('support goal data', () => {
  it('validates rows, formats money and clamps overfunded visual progress', () => {
    const parsed = parseSupportGoal(goalState.goal);
    expect(parsed).not.toBeNull();
    expect(formatSupportAmount(2400, 'USD', 'en')).toBe('$24');
    expect(formatSupportAmount(4250, 'USD', 'en')).toBe('$42.50');
    expect(supportGoalProgress({ ...parsed!, raised_cents: 10_500 })).toEqual({
      visualPercent: 100,
      displayPercent: 100,
      remainingCents: 0,
      complete: true
    });
    expect(parseSupportGoal({ ...goalState.goal, target_cents: 0 })).toBeNull();
  });

  it('parses the admin total as exact cents', () => {
    expect(parseSupportAmountInput('42.50')).toBe(4250);
    expect(parseSupportAmountInput('42,5')).toBe(4250);
    expect(parseSupportAmountInput('0')).toBe(0);
    expect(parseSupportAmountInput('-1')).toBeNull();
    expect(parseSupportAmountInput('1.234')).toBeNull();
  });
});

describe('support goal interface', () => {
  it('shows compact money progress and opens the specific, accessible goal card', () => {
    render(<SupportButton />);

    const trigger = screen.getByRole('button', { name: 'Support goal: $24 of $99' });
    expect(trigger.textContent).toContain('$24');
    expect(trigger.textContent).toContain('$99');
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        name: 'Get rid of reinstalls'
      })
    ).toBeTruthy();
    const progress = screen.getByRole('progressbar', { name: 'Funding progress' });
    expect(progress.getAttribute('aria-valuenow')).toBe('24');
    expect(progress.getAttribute('aria-valuetext')).toBe('$24 of $99');
    expect(screen.getByText('$75 to go')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Help close the goal · Monobank jar' }));
    expect(analyticsTrack).toHaveBeenCalledWith('support_donation_clicked', {
      feature_identifier: 'mac-updates-apple-developer',
      action_identifier: 'monobank'
    });
  });
});
