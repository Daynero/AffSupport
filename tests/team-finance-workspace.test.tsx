// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { buildFinanceReport, type FinanceSnapshot } from '@video-compressor/shared';
import { MonthlyFinanceSummary } from '../apps/web/src/team/accounts/finance/MonthlyFinanceSummary';

afterEach(cleanup);

it('keeps the monthly scroll position, header offset and keyboard focus across views', () => {
  const snapshot: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from: '2026-10-01',
    to: '2026-10-31',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [],
    agents: [],
    placements: [],
    fields: []
  };
  const onContextChange = vi.fn();
  const onDay = vi.fn();
  render(
    <MonthlyFinanceSummary
      report={buildFinanceReport(snapshot)}
      onDay={onDay}
      onContextChange={onContextChange}
    />
  );
  const matrix = screen.getByRole('region', { name: 'Monthly matrix' }) as HTMLElement;
  Object.defineProperty(matrix, 'clientWidth', { value: 640, configurable: true });
  Object.defineProperty(matrix, 'scrollWidth', { value: 1280, configurable: true });
  matrix.scrollLeft = 640;
  matrix.scrollTop = 160;
  fireEvent.scroll(matrix);
  expect(onContextChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      scrollLeft: 640,
      scrollTop: 160
    })
  );
  vi.spyOn(matrix, 'getBoundingClientRect').mockReturnValue({ top: 180 } as DOMRect);
  fireEvent(window, new Event('resize'));
  expect(matrix.style.getPropertyValue('--finance-table-top')).toBe('180px');
  fireEvent.click(screen.getByRole('button', { name: '2026-10-15' }));
  expect(onDay).toHaveBeenCalledWith('2026-10-15');
  fireEvent.click(screen.getByRole('tab', { name: 'Top-up statement' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Monthly matrix' }));
  const restored = screen.getByRole('region', { name: 'Monthly matrix' }) as HTMLElement;
  expect(restored.scrollLeft).toBe(640);
  expect(restored.scrollTop).toBe(160);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '2026-10-15' }));
});
