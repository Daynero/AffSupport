// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FinanceToolbar } from '../apps/web/src/team/accounts/finance/FinanceToolbar';
afterEach(cleanup);
it('shifts a custom range by its own length rather than turning it into a month', () => {
  const onRange = vi.fn();
  render(
    <FinanceToolbar
      date="2026-08-28"
      today="2026-10-04"
      monthly
      from="2026-08-28"
      to="2026-09-03"
      timezone="UTC"
      pending={false}
      exporting={false}
      canExport
      navigate={vi.fn()}
      onRange={onRange}
      onExport={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
  expect(onRange).toHaveBeenLastCalledWith('2026-09-04', '2026-09-10');
  fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
  expect(onRange).toHaveBeenLastCalledWith('2026-08-21', '2026-08-27');
  fireEvent.click(screen.getByRole('button', { name: '2026-08-28 — 2026-09-03' }));
  expect(screen.getByRole('grid')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'All time' })).toBeNull();
});
it('keeps the calendar closed initially and exposes one selected period', () => {
  const navigate = vi.fn();
  render(
    <FinanceToolbar
      date="2026-10-03"
      today="2026-10-03"
      monthly={false}
      from="2026-10-03"
      to="2026-10-03"
      timezone="UTC"
      pending={false}
      exporting={false}
      canExport
      navigate={navigate}
      onExport={vi.fn()}
    />
  );
  expect(screen.queryByRole('grid')).toBe(null);
  expect((screen.getByRole('button', { name: 'Next period' }) as HTMLButtonElement).disabled).toBe(
    true
  );
  fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
  expect(navigate).toHaveBeenLastCalledWith('2026-10-02', false);
  fireEvent.click(screen.getByRole('button', { name: '2026-10-03' }));
  expect(screen.getByRole('grid')).toBeTruthy();
});
it('moves by whole months and marks the current mode instead of silently showing day mode', () => {
  const navigate = vi.fn();
  render(
    <FinanceToolbar
      date="2026-09-01"
      today="2026-10-03"
      monthly
      from="2026-09-01"
      to="2026-09-30"
      timezone="UTC"
      pending={false}
      exporting={false}
      canExport
      navigate={navigate}
      onExport={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
  expect(navigate).toHaveBeenLastCalledWith('2026-10-01', true);
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(navigate).toHaveBeenLastCalledWith('2026-10-03', false);
});
