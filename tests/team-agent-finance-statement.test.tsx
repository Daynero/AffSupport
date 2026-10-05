// @vitest-environment jsdom
import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { buildFinanceReport, type FinanceSnapshot } from '@video-compressor/shared';
import { FinanceTopupStatement } from '../apps/web/src/team/accounts/finance/FinanceTopupStatement';

it('shows dated actual top-ups, including explicit zero, and opens their day without summing balances', () => {
  const s: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 't',
    teamName: 'T',
    from: '2026-09-01',
    to: '2026-09-30',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [{ id: 'x', name: 'X' }],
    agents: [{ id: 'a', agentId: '001' }],
    placements: [
      {
        id: 'p',
        agentRowId: 'a',
        accountId: 'x',
        startsOn: '2026-01-01',
        endsOn: null,
        version: '1'
      }
    ],
    fields: []
  };
  for (const [date, metric, value] of [
    ['2026-09-10', 'topup', '100.00'],
    ['2026-09-11', 'topup', '50.00'],
    ['2026-09-12', 'topup', '0.00'],
    ['2026-09-10', 'balance', '30.00'],
    ['2026-09-11', 'balance', '20.00']
  ] as const)
    s.fields.push({
      agentRowId: 'a',
      date,
      metric,
      value,
      currency: 'USD',
      version: '1',
      placementId: 'p',
      updatedAt: 'now',
      updatedBy: null
    });
  const onDay = vi.fn();
  render(<FinanceTopupStatement report={buildFinanceReport(s)} onDay={onDay} />);
  expect(screen.getByText(/150 USD/u)).toBeTruthy();
  expect(screen.getByText(/· 0 USD$/u)).toBeTruthy();
  expect(screen.queryByText(/30 USD/u)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2026-09-11' }));
  expect(onDay).toHaveBeenCalledWith('2026-09-11');
});
