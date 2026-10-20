// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogUpdaterState } from '../apps/web/src/api/team';

/** Feature 023, US3: the updater beside the space settings, and its countdown. */

const { CatalogUpdaterChip } =
  await import('../apps/web/src/team/catalog-updater/CatalogUpdaterChip');
const { formatRemaining } = await import('../apps/web/src/team/catalog-updater/UpdaterCountdown');

const NOW = Date.parse('2026-09-15T12:00:00.000Z');

const running: CatalogUpdaterState = {
  state: 'running',
  interval: '1h',
  restitch: false,
  nextRunAt: new Date(NOW + 65_000).toISOString(),
  startedAt: new Date(NOW).toISOString(),
  catalogCount: 3,
  failingCount: 0,
  spareReadyCount: null,
  restitchBlockedCode: null,
  serverNow: new Date(NOW).toISOString()
};

beforeEach(() => {
  localStorage.setItem('language', 'en');
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

function renderChip(state: CatalogUpdaterState | null, offsetMs = 0) {
  const onNavigate = vi.fn();
  render(
    <CatalogUpdaterChip
      state={state}
      offsetMs={offsetMs}
      href="/team/s?updater=1"
      onNavigate={onNavigate}
    />
  );
  return { onNavigate };
}

describe('the updater chip', () => {
  it('says nothing while the updater is stopped', () => {
    // Idle, the updater is a line in the space's menu; the header speaks only
    // when there is news (024, FR-094).
    renderChip(null);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('.team-updater-chip')).toBeNull();
  });

  it('shows the countdown and the number of catalogs while running', () => {
    renderChip(running);
    const link = screen.getByRole('link', { name: /Open the catalog manager: 3 catalogs/ });
    expect(link.className).not.toContain('ui-chip-busy');
    expect(link.querySelector('.ui-chip-spinner')).toBeNull();
    expect(link.textContent).toContain('Next update in 2 min');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(link.textContent).toContain('Next update in 1 min');
  });

  it('counts down on the server clock, not the local one', () => {
    renderChip(running, 30_000);
    expect(screen.getByRole('link').textContent).toContain('Next update in 1 min');
  });

  it('does not infer execution just because the scheduled time passed', () => {
    renderChip({ ...running, nextRunAt: new Date(NOW - 1_000).toISOString() });
    expect(screen.getByRole('link').textContent).toContain('Waiting to start');
  });

  it('turns to a warning when sheets keep failing', () => {
    renderChip({ ...running, failingCount: 1, catalogCount: 1 });
    const link = screen.getByRole('link');
    expect(link.className).toContain('ui-chip-warn');
    expect(link.textContent).toContain('needs attention');
    expect(link.getAttribute('aria-label')).toContain('1 catalog');
  });
});

describe('the chip while re-stitching', () => {
  it('counts the ready copies', () => {
    renderChip({ ...running, restitch: true, spareReadyCount: 2 });
    expect(screen.getByRole('link').textContent).not.toContain('copies 2/3');
    expect(screen.getByRole('link').textContent).toContain('Next update in');
  });
});

describe('formatRemaining', () => {
  it.each([
    [0, '0:00:00'],
    [999, '0:00:01'],
    [3_600_000, '1:00:00'],
    [86_399_000, '23:59:59'],
    [86_400_000 * 6 + 3_660_000, '6d 01:01']
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatRemaining(ms)).toBe(text);
  });
});

describe('why the spares stand still (030)', () => {
  it('names an empty pool and a member who may not download', () => {
    renderChip({
      ...running,
      restitch: true,
      spareReadyCount: 1,
      restitchBlockedCode: 'RESTITCH_POOL_EMPTY'
    });
    expect(screen.getByRole('link').className).toContain('ui-chip-warn');
    cleanup();
    renderChip({
      ...running,
      restitch: true,
      spareReadyCount: 1,
      restitchBlockedCode: 'RESTITCH_SOURCE_FORBIDDEN'
    });
    expect(screen.getByRole('link').className).toContain('ui-chip-warn');
    cleanup();
    renderChip({ ...running, restitch: true, spareReadyCount: 1 });
    expect(screen.queryByText(/No pictures are available/)).toBeNull();
  });
});

it('prioritizes actual work over the future schedule, including a manually started unscheduled run', () => {
  renderChip({ ...running, activeCount: 2 });
  expect(screen.getByRole('link').textContent).toContain('Updating 2 catalogs');
  expect(screen.getByRole('link').textContent).not.toContain('Next update in');
  expect(document.querySelector('.ui-chip-spinner')).toBeTruthy();
  cleanup();
  renderChip({ ...running, state: 'stopped', activeCount: 1 });
  expect(screen.getByRole('link').textContent).toContain('Updating 1 catalog');
});

it('returns to the next scheduled update when the server reports no remaining active work', () => {
  const props = { offsetMs: 0, href: '/team/s?updater=1', onNavigate: vi.fn() };
  const { rerender } = render(
    <CatalogUpdaterChip {...props} state={{ ...running, activeCount: 1 }} />
  );
  expect(screen.getByRole('link').textContent).toContain('Updating 1 catalog');
  rerender(<CatalogUpdaterChip {...props} state={{ ...running, activeCount: 0 }} />);
  expect(screen.getByRole('link').textContent).toContain('Next update in');
  expect(document.querySelector('.ui-chip-spinner')).toBeNull();
});
