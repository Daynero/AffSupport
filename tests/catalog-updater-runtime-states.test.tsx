// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CatalogUpdateProgress } from '../apps/web/src/team/catalog-updater/CatalogUpdateProgress';
import { UpdaterCountdown } from '../apps/web/src/team/catalog-updater/UpdaterCountdown';

const NOW = Date.parse('2026-10-21T10:00:00.000Z');
beforeEach(() => {
  localStorage.setItem('language', 'en');
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

it('distinguishes queued video preparation from confirmed measurable progress', () => {
  const view = render(<CatalogUpdateProgress stage="waiting_video" restitchProgress={80} />);
  expect(screen.getByRole('status').textContent).toContain('Waiting');
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText('80%')).toBeNull();
  view.rerender(
    <CatalogUpdateProgress stage="restitching" restitchStage="processing" restitchProgress={42} />
  );
  expect(screen.getByRole('status').textContent).toContain('Re-stitching the video');
  const progress = screen.getByRole('progressbar', { name: 'Video re-stitching progress' });
  expect(progress.getAttribute('aria-valuenow')).toBe('42');
  expect(progress.querySelector('span')?.style.transform).toBe('scaleX(0.42)');
});

it.each([
  [-10, 0],
  [150, 100],
  [null, 0]
])('bounds confirmed progress %s to the accessible percentage %s', (input, expected) => {
  render(<CatalogUpdateProgress stage="restitching" restitchProgress={input} />);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(String(expected));
  expect(screen.getByRole('status').textContent).toContain('Downloading');
});

it('re-reads the server-adjusted deadline on focus and visibility, then stops its timer on unmount', () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const view = render(
    <UpdaterCountdown
      targetIso={new Date(NOW + 90_000).toISOString()}
      offsetMs={30_000}
      dueLabel="Due"
    />
  );
  expect(view.container.textContent).toBe('0:01:00');
  act(() => {
    vi.setSystemTime(NOW + 30_000);
    fireEvent.focus(window);
  });
  expect(view.container.textContent).toBe('0:00:30');
  hidden.mockReturnValue(true);
  act(() => {
    vi.setSystemTime(NOW + 60_000);
    fireEvent(document, new Event('visibilitychange'));
  });
  expect(view.container.textContent).toBe('0:00:30');
  hidden.mockReturnValue(false);
  act(() => fireEvent(document, new Event('visibilitychange')));
  expect(view.container.textContent).toBe('Due');
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not fabricate a countdown without a scheduled deadline', () => {
  const view = render(<UpdaterCountdown targetIso={null} offsetMs={0} dueLabel="Due" />);
  expect(view.container.textContent).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});
