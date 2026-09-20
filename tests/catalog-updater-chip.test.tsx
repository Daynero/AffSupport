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
    const link = screen.getByRole('link', { name: 'Open the catalog updater: 3 catalogs' });
    expect(link.className).toContain('ui-chip-busy');
    expect(link.textContent).toContain('0:01:05');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(link.textContent).toContain('0:01:00');
  });

  it('counts down on the server clock, not the local one', () => {
    renderChip(running, 30_000);
    expect(screen.getByRole('link').textContent).toContain('0:00:35');
  });

  it('says the round is under way once the time runs out', () => {
    renderChip({ ...running, nextRunAt: new Date(NOW - 1_000).toISOString() });
    expect(screen.getByRole('link').textContent).toContain('updating now');
  });

  it('turns to a warning when sheets keep failing', () => {
    renderChip({ ...running, failingCount: 1, catalogCount: 1 });
    const link = screen.getByRole('link');
    expect(link.className).toContain('ui-chip-warn');
    expect(link.textContent).toContain('needs attention');
    expect(link.textContent).toContain('1 catalog');
  });
});

describe('the chip while re-stitching', () => {
  it('counts the ready copies', () => {
    renderChip({ ...running, restitch: true, spareReadyCount: 2 });
    expect(screen.getByRole('link').textContent).toContain('copies 2/3');
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
