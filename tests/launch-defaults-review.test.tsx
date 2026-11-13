// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchDefaultsReview } from '../apps/web/src/team/launches/LaunchDefaultsReview';
import { launchConfig } from './fixtures/launches';
afterEach(cleanup);
it('shows current defaults and ordered SUB without exposing unrelated Launch content', () => {
  const config = launchConfig({ originalUrl: 'SYNTHETIC_PRIVATE_URL' });
  const reviewed = vi.fn();
  render(
    <LaunchDefaultsReview
      current={{
        config,
        subConfig: {
          schemaVersion: 1,
          sub1: ['buyer'],
          sub2: ['creative', 'social'],
          sub3: []
        }
      }}
      buyer="other_buyer"
      disabled={false}
      onReview={reviewed}
    />
  );
  expect(screen.getByText('other_buyer')).toBeTruthy();
  expect(screen.getByText('Creative → Social account')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC_PRIVATE_URL')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reviewed; keep my Launch draft' }));
  expect(reviewed).toHaveBeenCalledOnce();
});
it('cannot acknowledge while a mutation is unsettled', () => {
  const reviewed = vi.fn();
  render(<LaunchDefaultsReview current={null} buyer="" disabled onReview={reviewed} />);
  expect(screen.getByText('No workspace defaults are saved.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reviewed; keep my Launch draft' }));
  expect(reviewed).not.toHaveBeenCalled();
});
it.each([
  ['custom', 1200, undefined, '20'],
  ['random-centered', 1800, [1200, 2400], '20–40'],
  ['random-centered', 1800, undefined, '25–35'],
  ['random-30-40', undefined, undefined, '30–40'],
  ['random-40-50', undefined, undefined, '40–50'],
  ['random-50-60', undefined, undefined, '50–60']
] as const)(
  'reviews catalog restitch duration %s without overwriting the draft',
  (mode, seconds, range, expected) => {
    const config = launchConfig({ method: 'catalog', minBudget: 10, advantagePlus: true });
    config.catalog = {
      productCount: 5,
      restitchEnabled: true,
      finalDurationMode: mode,
      customFinalDurationSeconds: seconds ?? null,
      ...(range ? { finalDurationRangeSeconds: range } : {})
    };
    const reviewed = vi.fn();
    render(
      <LaunchDefaultsReview
        current={{
          config,
          subConfig: { schemaVersion: 1, sub1: [], sub2: ['adAccountSuffix'], sub3: ['buyer'] }
        }}
        buyer=""
        disabled={false}
        onReview={reviewed}
      />
    );
    expect(screen.getByText('10–30')).toBeTruthy();
    expect(screen.getByText(new RegExp(`: ${expected}$`))).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed; keep my Launch draft' }));
    expect(reviewed).toHaveBeenCalledOnce();
    expect(config.catalog?.finalDurationMode).toBe(mode);
  }
);
it('reviews a catalog with restitch disabled rather than inventing a duration', () => {
  const config = launchConfig({ method: 'catalog' });
  config.catalog = { ...config.catalog!, restitchEnabled: false };
  render(
    <LaunchDefaultsReview
      current={{ config, subConfig: { schemaVersion: 1, sub1: [], sub2: [], sub3: [] } }}
      buyer="buyer"
      disabled={false}
      onReview={vi.fn()}
    />
  );
  expect(screen.getByText('—')).toBeTruthy();
});

it('shows the exact manual budgets and offer scope before acknowledging a conflict', () => {
  const config = launchConfig({
    minBudget: 10,
    maxBudget: 30,
    budgetMode: 'manual',
    budgets: [10, 25, 30]
  });
  render(
    <LaunchDefaultsReview
      current={{ config, subConfig: config.subConfig }}
      offerName="Offer A"
      buyer=""
      disabled={false}
      onReview={vi.fn()}
    />
  );
  expect(screen.getByText('Settings changed for offer “Offer A”')).toBeTruthy();
  expect(screen.getByText('Manual')).toBeTruthy();
  expect(screen.getByText('10 · 25 · 30')).toBeTruthy();
});

it.each([true, false])(
  'reviews video variants and deferred publication with restitch %s',
  restitch => {
    const config = launchConfig({ method: 'catalog' });
    config.catalog = {
      ...config.catalog!,
      restitchEnabled: restitch,
      copyVideoToR2: true,
      catalogVideoProtocolVersion: 1,
      videoVariationCount: 4,
      videoPublication: {
        mode: 'scheduled',
        localDateTime: '2026-11-20T12:30',
        timeZone: 'Europe/Kyiv',
        resolvedOffset: '+02:00',
        dueAt: '2026-11-20T10:30:00.000Z'
      }
    };
    const view = render(
      <LaunchDefaultsReview
        current={{ config, subConfig: config.subConfig }}
        buyer=""
        disabled={false}
        onReview={vi.fn()}
      />
    );
    const value = (label: string) =>
      screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(value('Copy the video to R2')).toBe('On');
    expect(value('Video variations')).toBe(restitch ? '4' : '1');
    expect(value('Schedule the video link')).toBe('2026-11-20 12:30 · Europe/Kyiv');
    config.catalog.videoPublication = { mode: 'immediate' };
    view.rerender(
      <LaunchDefaultsReview
        current={{ config, subConfig: config.subConfig }}
        buyer=""
        disabled={false}
        onReview={vi.fn()}
      />
    );
    expect(value('Schedule the video link')).toBe('—');
  }
);
