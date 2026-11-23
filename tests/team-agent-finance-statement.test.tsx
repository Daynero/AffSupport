// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
afterEach(cleanup);
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

// 027 T042/T044: a month with a transfer, an explicit zero and a cleared value, read once by
// the on-screen statement and once by the Excel sheet. Both come from `buildFinanceReport`;
// this pins that they also say the same thing, row for row and in the total.
it('keeps a moved agent’s top-ups under the account of their day, on screen and in Excel alike', async () => {
  const { financeWorkbookSheets } = await import('../supabase/functions/_shared/finance-workbook');
  const field = (
    placementId: string,
    date: string,
    metric: 'topup' | 'balance' | 'spend',
    value: string | null
  ) => ({
    agentRowId: 'a',
    date,
    metric,
    value,
    currency: 'USD' as const,
    version: '1',
    placementId,
    updatedAt: 'now',
    updatedBy: null
  });
  const s: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 't',
    teamName: 'T',
    from: '2026-09-01',
    to: '2026-09-30',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [
      { id: 'x', name: 'Before' },
      { id: 'y', name: 'After' }
    ],
    agents: [{ id: 'a', agentId: '001' }],
    placements: [
      {
        id: 'p',
        agentRowId: 'a',
        accountId: 'x',
        startsOn: '2026-01-01',
        endsOn: '2026-09-15',
        version: '2'
      },
      {
        id: 'q',
        agentRowId: 'a',
        accountId: 'y',
        startsOn: '2026-09-15',
        endsOn: null,
        version: '1'
      }
    ],
    fields: [
      field('p', '2026-09-10', 'topup', '100.00'),
      // Cleared: a value that was there and is now empty is no top-up at all.
      field('p', '2026-09-12', 'topup', null),
      field('q', '2026-09-20', 'topup', '40.50'),
      field('q', '2026-09-21', 'topup', '0.00'),
      field('q', '2026-09-20', 'balance', '999.00')
    ]
  };
  const report = buildFinanceReport(s);
  const onDay = vi.fn();
  render(<FinanceTopupStatement report={report} onDay={onDay} />);
  const lines = [...document.querySelectorAll('section > div')].map(line =>
    line.textContent?.replace(/\s+/gu, ' ').trim()
  );
  expect(lines).toEqual([
    '2026-09-10 Before / 001 · 100 USD',
    '2026-09-20 After / 001 · 40,50 USD',
    '2026-09-21 After / 001 · 0 USD'
  ]);
  expect(screen.queryByText(/2026-09-12/u)).toBeNull();
  expect(screen.queryByText(/999/u)).toBeNull();
  // One agent, one summary line: the transfer splits its columns, not the agent.
  expect(report.agents).toHaveLength(1);
  expect(report.agents[0]!.totals.topup).toBe(report.totals.topup);
  fireEvent.click(screen.getByRole('button', { name: '2026-09-20' }));
  expect(onDay).toHaveBeenCalledWith('2026-09-20');

  const statement = financeWorkbookSheets(s).find(
    sheet => sheet.sheetName === 'Виписка поповнень'
  )!;
  const rows = statement.rows.slice(1).map(row => row.map(cell => cell.v));
  expect(rows).toEqual([
    ['2026-09-10', 'Before', '001', '100.00'],
    ['2026-09-20', 'After', '001', '40.50'],
    ['2026-09-21', 'After', '001', '0.00'],
    ['Разом', '', '', report.totals.topup]
  ]);
  expect(report.totals.topup).toBe('140.50');
  expect(document.querySelector('section > p:last-child')?.textContent).toMatch(/140,50 USD$/u);
});
