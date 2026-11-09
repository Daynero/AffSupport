// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  CATALOG_PERFORMANCE_ACTOR,
  CATALOG_PERFORMANCE_TEAM,
  CATALOG_PERFORMANCE_SIZES,
  catalogManagerPerformanceFixture
} from './fixtures/catalog-manager-performance';
vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 'a2600000-0000-4000-8000-000000000002' } }),
  AuthContextOverride: ({ children }: { children: React.ReactNode }) => children
}));
vi.mock('../apps/web/src/team/explorer/WorkspaceOperationsProvider', () => ({
  useOptionalWorkspaceOperations: () => null
}));
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { createCatalogManagerPerformanceHarness } from './support/catalog-manager-performance-harness';
beforeEach(() => {
  // Freeze only autonomous polling/countdown intervals. Promise reads, React,
  // browser events and waitFor remain real; no latency assertion is made here.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  setPrivateCacheScope(CATALOG_PERFORMANCE_ACTOR, 'owner');
  localStorage.setItem('wishly.active-team.v1', CATALOG_PERFORMANCE_TEAM);
  localStorage.setItem('language', 'en');
  localStorage.setItem('catalog-icon-legend-seen', '1');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});
const renderedRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>('tr[data-catalog-id]'));
it('fixture identity/content is reproducible, mixed and privacy-safe at every required size', () => {
  for (const size of CATALOG_PERFORMANCE_SIZES) {
    const a = catalogManagerPerformanceFixture(size),
      b = catalogManagerPerformanceFixture(size);
    expect(a).toEqual(b);
    expect(new Set(a.rows.map(r => r.catalogId)).size).toBe(size);
    expect(a.profiles).toHaveLength(size);
    expect(a.rows.filter(r => r.name.includes('льон'))).toHaveLength(size / 2);
    if (size) {
      expect(new Set(a.scenarios).size).toBe(4);
      expect(new Set(a.rows.map(r => r.name)).size).toBeLessThan(size);
    }
  }
});
it.each(CATALOG_PERFORMANCE_SIZES)(
  'bounds rendered rows and reads for %i full-profile records without truncating search/selection',
  async size => {
    const harness = createCatalogManagerPerformanceHarness(size);
    render(<harness.Harness />);
    await waitFor(() => expect(harness.counts.managerReads).toBe(1));
    await waitFor(() => expect(screen.queryByText('Loading catalogs…')).toBeNull());
    expect(renderedRows()).toHaveLength(Math.min(size, 60));
    expect(harness.counts.profilerObserved).toBe(true);
    const baseline = harness.snapshotCounts();
    const reads = () => ({
      manager: harness.counts.managerReads,
      catalog: harness.counts.catalogReads,
      profiles: harness.counts.profileReads,
      state: harness.counts.stateReads
    });
    const initialReads = reads();
    if (size === 0) {
      expect(screen.getByText('No catalogs yet. Create one from a video.')).toBeTruthy();
      expect(harness.counts.writes).toBe(0);
      return;
    }
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: harness.fixture.halfMatchQuery }
    });
    expect(renderedRows()).toHaveLength(Math.min(size / 2, 60));
    const afterSearch = harness.counts.commits;
    expect(afterSearch - baseline.commits).toBeLessThanOrEqual(16);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    expect(
      within(screen.getByRole('group', { name: 'Selected catalogs' })).getByText(
        `${size / 2} catalogs selected`
      )
    ).toBeTruthy();
    expect(harness.counts.commits - afterSearch).toBeLessThanOrEqual(16);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    const target = harness.fixture.rows[size - 1]!;
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: target.videoName } });
    expect(renderedRows()).toHaveLength(1);
    expect(renderedRows()[0]!.dataset.catalogId).toBe(target.catalogId);
    const beforeDetails = harness.counts.commits;
    fireEvent.click(within(renderedRows()[0]!).getByRole('button', { name: target.name }));
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    const details = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.team-updater-detail');
      expect(node).not.toBeNull();
      return node!;
    });
    fireEvent.click(within(details).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.querySelector('.team-updater-detail')).toBeNull());
    expect(harness.counts.commits - beforeDetails).toBeLessThanOrEqual(24);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderedRows()).toHaveLength(Math.min(size, 60));
    expect(reads()).toEqual(initialReads);
    expect(harness.counts.writes).toBe(0);
  },
  30000
);
it('fallback full-profile join stays linear instead of scanning profiles once per catalog', async () => {
  const harness = createCatalogManagerPerformanceHarness(500, 'split');
  render(<harness.Harness />);
  await waitFor(() => expect(renderedRows()).toHaveLength(60));
  expect(harness.counts.catalogReads).toBe(1);
  expect(harness.counts.profileReads).toBe(1);
  expect(harness.counts.managerReads).toBe(0);
  expect(harness.counts.profileElementReads).toBeGreaterThanOrEqual(500);
  expect(harness.counts.profileElementReads).toBeLessThanOrEqual(1500);
  const before = harness.counts.profileElementReads;
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'льон' } });
  expect(renderedRows()).toHaveLength(60);
  expect(harness.counts.profileElementReads).toBe(before);
  expect(harness.counts.writes).toBe(0);
});
