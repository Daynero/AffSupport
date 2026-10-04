// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { buildFinanceReport, type FinanceSnapshot } from '@video-compressor/shared';
import { MonthlyFinanceSummary } from '../apps/web/src/team/accounts/finance/MonthlyFinanceSummary';
afterEach(cleanup);
it('keeps the monthly matrix in its own bounded scroll area and refuses future day editing', () => {
  const snapshot: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 't',
    teamName: 'T',
    from: '2026-10-01',
    to: '2026-10-31',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [],
    agents: [],
    placements: [],
    fields: []
  };
  render(
    <MonthlyFinanceSummary
      report={buildFinanceReport(snapshot)}
      onDay={vi.fn()}
      today="2026-10-03"
    />
  );
  expect(screen.getByRole('region', { name: 'Monthly matrix' }).className).toContain(
    'finance-matrix-scroll'
  );
  expect(screen.getByRole('region', { name: 'Monthly matrix' }).className).not.toContain(
    'max-h-96'
  );
  expect(screen.getByRole('table').querySelector('.finance-matrix-total')).toBeTruthy();
  expect((screen.getByRole('button', { name: '2026-10-04' }) as HTMLButtonElement).disabled).toBe(
    true
  );
  expect((screen.getByRole('button', { name: '2026-10-03' }) as HTMLButtonElement).disabled).toBe(
    false
  );
  expect(screen.queryByRole('tabpanel', { name: 'Top-up statement' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Top-up statement' }));
  expect(screen.queryByRole('region', { name: 'Monthly matrix' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Top-up statement' }).getAttribute('aria-selected')).toBe(
    'true'
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Monthly matrix' }));
  expect(screen.getByRole('region', { name: 'Monthly matrix' })).toBeTruthy();
});
it('restores the monthly tab after returning from a day', () => {
  const snapshot: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 't',
    teamName: 'T',
    from: '2026-09-01',
    to: '2026-09-30',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [],
    agents: [],
    placements: [],
    fields: []
  };
  render(
    <MonthlyFinanceSummary
      report={buildFinanceReport(snapshot)}
      onDay={vi.fn()}
      initialContext={{ metric: 'topup', view: 'statement', scrollLeft: 0, scrollTop: 0 }}
    />
  );
  expect(screen.getByRole('tabpanel', { name: 'Top-up statement' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Monthly matrix' })).toBeNull();
});
