// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CatalogRegistryRow } from '../apps/web/src/api/team';
import {
  CatalogProgressRow,
  catalogRowProgress
} from '../apps/web/src/team/catalog-updater/CatalogProgressRow';

afterEach(cleanup);
const row: CatalogRegistryRow = {
  catalogId: 'one',
  name: 'Catalog',
  sheetUrl: '',
  videoId: 'video',
  videoName: 'Video',
  folderName: null,
  folderDriveId: null,
  productCount: 1,
  createdAt: '2026-10-20T00:00:00Z',
  lastUpdatedAt: null,
  updateCount: 0,
  inUpdater: true,
  lastUpdateError: null,
  updateInterval: '1d',
  nextRunAt: null,
  updatePending: true,
  updateStage: 'preparing',
  restitchProgress: null,
  restitchStage: null
};
const profile = (
  lastResult: 'running' | 'success' | 'unknown',
  lastSuccessfulAt: string | null,
  reconciliationRequired = false
) =>
  ({ lastResult, lastSuccessfulAt, reconciliationRequired }) as NonNullable<
    CatalogRegistryRow['profile']
  >;
const view = (value: CatalogRegistryRow) => (
  <table>
    <tbody>
      <CatalogProgressRow row={value}>
        <td>Catalog</td>
      </CatalogProgressRow>
    </tbody>
  </table>
);
it('shows registered K/N for the current video set without reporting catalog completion', () => {
  const value: CatalogRegistryRow = {
    ...row,
    updatePending: false,
    videoGeneration: {
      setId: '11111111-1111-4111-8111-111111111111',
      requestedCount: 5,
      registeredCount: 2,
      state: 'preparing'
    }
  };
  expect(catalogRowProgress(value).active).toBe(true);
  expect(catalogRowProgress(value).value).toBeCloseTo(0.208);
  const child = '11111111-1111-4111-8111-111111111112';
  const runningChild = {
    ...value,
    restitchProgress: 50,
    restitchOperationId: child,
    videoGeneration: { ...value.videoGeneration!, activeChildOperationId: child }
  };
  expect(catalogRowProgress(runningChild).value).toBeCloseTo(0.24);
  expect(catalogRowProgress({ ...runningChild, restitchOperationId: null }).value).toBeCloseTo(
    0.208
  );
  const { rerender } = render(view(value));
  expect(screen.getByRole('row').getAttribute('aria-label')).toContain('2');
  rerender(
    view({
      ...value,
      videoGeneration: { ...value.videoGeneration!, state: 'ready', registeredCount: 5 }
    })
  );
  expect(screen.getByRole('row').className).not.toContain('is-update-complete');
});
it('advances only from observed stages and clamps real video progress', () => {
  expect(
    catalogRowProgress({ ...row, updateStage: 'restitching', restitchProgress: 50 }).value
  ).toBeCloseTo(0.24);
  expect(
    catalogRowProgress({ ...row, updateStage: 'restitching', restitchProgress: 200 }).value
  ).toBeCloseTo(0.4);
  const { rerender } = render(view(row));
  const tr = screen.getByRole('row');
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.12');
  rerender(view({ ...row, updateStage: 'uploading' }));
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.82');
  rerender(view(row));
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.82');
});
it('does not complete during Drive reconciliation or flash on historical success', () => {
  const past = '2026-10-19T00:00:00Z';
  const { rerender } = render(
    view({ ...row, updatePending: false, profile: profile('success', past) })
  );
  const tr = screen.getByRole('row');
  expect(tr.className).not.toContain('is-update-complete');
  rerender(view({ ...row, profile: profile('running', past, true) }));
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.94');
  expect(tr.className).not.toContain('is-update-complete');
  rerender(view({ ...row, updatePending: false, profile: profile('unknown', past, true) }));
  expect(tr.className).not.toContain('is-update-complete');
});
it('fills and briefly highlights only a newly confirmed success, then clears the background', () => {
  const { rerender } = render(view({ ...row, profile: profile('running', null) }));
  rerender(
    view({ ...row, updatePending: false, profile: profile('success', '2026-10-20T12:00:00Z') })
  );
  const tr = screen.getByRole('row');
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('1');
  expect(tr.className).toContain('is-update-complete');
  // jsdom lacks AnimationEvent, so React may register the WebKit fallback.
  for (const type of ['animationend', 'webkitAnimationEnd']) {
    const ended = new Event(type, { bubbles: true });
    Object.defineProperty(ended, 'animationName', { value: 'catalog-row-complete' });
    fireEvent(tr.firstElementChild!, ended);
  }
  expect(tr.className).not.toContain('is-update-complete');
  expect(tr.style.getPropertyValue('--catalog-row-progress-visible')).toBe('0');
});

it('resets progress between consecutive active attempts and native children', () => {
  const first = {
    ...row,
    activeAttemptId: 'attempt-a',
    progressAttemptId: 'attempt-a',
    activeRoundAt: '2026-11-05T10:00:00Z',
    updateStage: 'uploading' as const
  };
  const { rerender } = render(view(first));
  const tr = screen.getByRole('row');
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.82');
  rerender(
    view({
      ...first,
      activeAttemptId: 'attempt-b',
      progressAttemptId: 'attempt-b',
      updateStage: 'preparing'
    })
  );
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.12');
  rerender(
    view({
      ...first,
      activeAttemptId: 'attempt-b',
      progressAttemptId: 'attempt-b',
      updateStage: 'restitching',
      restitchOperationId: 'child-a',
      restitchProgress: 90
    })
  );
  rerender(
    view({
      ...first,
      activeAttemptId: 'attempt-b',
      progressAttemptId: 'attempt-b',
      updateStage: 'restitching',
      restitchOperationId: 'child-b',
      restitchProgress: 0
    })
  );
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.08');
});
it('ignores progress from another attempt and video progress with no live child', () => {
  expect(
    catalogRowProgress({
      ...row,
      activeRoundAt: '2026-11-05T10:00:00Z',
      activeAttemptId: 'b',
      progressAttemptId: 'a',
      updateStage: 'uploading'
    }).value
  ).toBe(0.12);
  expect(
    catalogRowProgress({
      ...row,
      updateStage: 'restitching',
      restitchOperationId: null,
      restitchProgress: 99
    }).value
  ).toBe(0.08);
});

it('keeps the round progress when its finished video child leaves the snapshot', () => {
  const current = {
    ...row,
    activeRoundAt: '2026-11-05T10:00:00Z',
    activeAttemptId: 'a',
    progressAttemptId: 'a'
  };
  const { rerender } = render(
    view({
      ...current,
      updateStage: 'restitching',
      restitchOperationId: 'child-a',
      restitchProgress: 100
    })
  );
  const tr = screen.getByRole('row');
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.4');
  rerender(view({ ...current, updateStage: 'preparing', restitchOperationId: null }));
  expect(tr.style.getPropertyValue('--catalog-row-progress')).toBe('0.4');
});
