// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { financeToday, type FinanceSnapshot } from '@video-compressor/shared';
import {
  UnifiedFinanceProvider,
  UnifiedFinanceToolbar,
  UnifiedAgentFinanceFields,
  useUnifiedFinance,
  previousFinanceDay
} from '../apps/web/src/team/accounts/finance/UnifiedFinance';
import { ToastProvider } from '../apps/web/src/components/toast';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
import { copyText } from '../apps/web/src/two-factor/clipboard';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
vi.mock('../apps/web/src/api/team-finance', () => ({
  teamFinanceApi: {
    snapshot: vi.fn(),
    set: vi.fn(),
    undo: vi.fn(),
    clear: vi.fn(),
    export: vi.fn()
  }
}));
vi.mock('../apps/web/src/two-factor/clipboard', () => ({ copyText: vi.fn() }));
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const today = financeToday();
const yesterday = previousFinanceDay(today);
function fixture(from: string, to: string): FinanceSnapshot {
  return {
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from,
    to,
    currency: 'USD',
    generatedAt: 'now',
    accounts: [{ id: 'social', name: 'Social' }],
    agents: [{ id: 'a', agentId: 'g1-926' }],
    placements: [
      {
        id: 'p-a',
        agentRowId: 'a',
        accountId: 'social',
        startsOn: '2020-01-01',
        endsOn: null,
        version: '1'
      }
    ],
    fields: [
      { date: today, metric: 'spend' as const, value: '3.75' },
      { date: today, metric: 'topup' as const, value: '30.00' },
      { date: yesterday, metric: 'topup' as const, value: '12.00' }
    ]
      .filter(field => field.date >= from && field.date <= to)
      .map(field => ({
        ...field,
        agentRowId: 'a',
        currency: 'USD',
        version: '1',
        placementId: 'p-a',
        updatedAt: 'now',
        updatedBy: null
      }))
  };
}
function Workspace() {
  const finance = useUnifiedFinance();
  return (
    <>
      <button
        onClick={() => {
          finance.setDate(yesterday);
          finance.setReportRange([yesterday, today]);
        }}
      >
        Custom range
      </button>
      <output data-testid="period">{finance.reportRange?.join('/') ?? finance.date}</output>
      <UnifiedFinanceToolbar />
      <UnifiedAgentFinanceFields agentRowId="a" accountId="social" contextLabel="g1-926" />
    </>
  );
}
async function start() {
  vi.mocked(copyText).mockResolvedValue(true);
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) =>
    fixture(from, to)
  );
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <Workspace />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Period details' }) as HTMLButtonElement).disabled
    ).toBe(false)
  );
}
it('keeps the unified view and restores custom range and statement after day drilldown', async () => {
  await start();
  expect(screen.queryByRole('tablist')).toBeNull();
  fireEvent.click(screen.getByText('Custom range'));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Period details' }) as HTMLButtonElement).disabled
    ).toBe(false)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Period details' }));
  let dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByRole('tab', { name: 'Monthly matrix' }).getAttribute('aria-selected')
  ).toBe('true');
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Top-up statement' }));
  expect(within(dialog).getByText('Social / g1-926 · 12 USD')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: yesterday }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByTestId('period').textContent).toBe(yesterday);
  fireEvent.click(screen.getByRole('button', { name: 'Back to period report' }));
  dialog = await screen.findByRole('dialog');
  expect(screen.getByTestId('period').textContent).toBe(`${yesterday}/${today}`);
  await waitFor(() =>
    expect(
      within(dialog).getByRole('tab', { name: 'Top-up statement' }).getAttribute('aria-selected')
    ).toBe('true')
  );
  expect(within(dialog).getByText('Social / g1-926 · 30 USD')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('advances the actual monthly anchor on every previous-period navigation', async () => {
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'This month' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Previous period' })).toHaveProperty(
      'disabled',
      false
    )
  );
  const startDate = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  const expected = (offset: number) => {
    const from = new Date(startDate);
    from.setUTCMonth(from.getUTCMonth() - offset);
    const end = new Date(from);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    return `${from.toISOString().slice(0, 10)}/${end.toISOString().slice(0, 10)}`;
  };
  fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
  await waitFor(() => expect(screen.getByTestId('period').textContent).toBe(expected(1)));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Previous period' })).toHaveProperty(
      'disabled',
      false
    )
  );
  fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
  await waitFor(() => expect(screen.getByTestId('period').textContent).toBe(expected(2)));
});
it('copies canonical total amounts and keeps money outside diagnostics', async () => {
  await start();
  fireEvent.click(screen.getByRole('button', { name: 'Copy amount: Spend' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith('3,75'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy amount: Top-up' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith('30'));
  expect(emitAccountSignal).toHaveBeenCalledWith(
    'retained_action',
    'clipboard_confirmed',
    expect.objectContaining({ count: 1, result: 'complete' })
  );
  const signals = JSON.stringify(vi.mocked(emitAccountSignal).mock.calls);
  expect(signals).not.toContain('3.75');
  expect(signals).not.toContain('3,75');
  expect(signals).not.toContain('30.00');
  expect(signals).not.toContain('g1-926');
});
it('disables period details and total copies while an unsaved draft exists', async () => {
  await start();
  fireEvent.change(screen.getByRole('textbox', { name: `g1-926 · ${today} · Balance · USD` }), {
    target: { value: '123' }
  });
  for (const name of ['Period details', 'Copy amount: Spend', 'Copy amount: Top-up']) {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(copyText).not.toHaveBeenCalled();
  expect(teamFinanceApi.set).not.toHaveBeenCalled();
});
it('reports denied clipboard copying without a false success proof', async () => {
  await start();
  vi.mocked(copyText).mockResolvedValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Copy amount: Spend' }));
  await waitFor(() =>
    expect(emitAccountSignal).toHaveBeenCalledWith(
      'retained_action',
      'terminal',
      expect.objectContaining({ code: 'CLIPBOARD_DENIED', outcome: 'failure' })
    )
  );
  expect(
    vi.mocked(emitAccountSignal).mock.calls.some(call => call[1] === 'clipboard_confirmed')
  ).toBe(false);
  expect(
    screen.getByText('Could not complete the operation. Your draft is retained.')
  ).toBeTruthy();
});
it('restores matrix scroll and focused day after drilling down and guards a dirty return', async () => {
  await start();
  fireEvent.click(screen.getByText('Custom range'));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Period details' }) as HTMLButtonElement).disabled
    ).toBe(false)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Period details' }));
  const dialog = await screen.findByRole('dialog');
  const region = within(dialog).getByRole('region', { name: 'Monthly matrix' });
  fireEvent.scroll(region, { target: { scrollLeft: 47, scrollTop: 83 } });
  fireEvent.click(within(region).getByRole('button', { name: yesterday }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const balance = await screen.findByRole('textbox', {
    name: `g1-926 · ${yesterday} · Balance · USD`
  });
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(balance, { target: { value: '123' } });
  expect(
    (screen.getByRole('button', { name: 'Back to period report' }) as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to period report' }));
  const restored = within(await screen.findByRole('dialog')).getByRole('region', {
    name: 'Monthly matrix'
  });
  expect(restored.scrollLeft).toBe(47);
  expect(restored.scrollTop).toBe(83);
  expect(document.activeElement).toBe(within(restored).getByRole('button', { name: yesterday }));
});
