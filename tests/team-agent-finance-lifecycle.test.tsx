// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
import { LegacyFinanceReview } from '../apps/web/src/team/accounts/finance/LegacyFinanceReview';
const api = vi.hoisted(() => ({
  legacy: vi.fn(),
  importLegacy: vi.fn(),
  snapshot: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
  undo: vi.fn()
}));
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: api }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('requires a separate confirmation of the explicit date, currency and amount before legacy import', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
  api.legacy.mockResolvedValue([
    {
      id: 'legacy',
      balance_units: 70,
      requested_topup_units: 200,
      balance_imported_event_id: null,
      topup_imported_event_id: null
    }
  ]);
  api.importLegacy.mockResolvedValue({ fields: [] });
  const onImported = vi.fn();
  render(
    <LegacyFinanceReview
      teamId="team"
      agent="agent"
      today="2026-10-03"
      timezone="UTC"
      onClose={vi.fn()}
      onImported={onImported}
    />
  );
  await screen.findByText('70');
  fireEvent.change(screen.getByRole('textbox', { name: 'USD' }), { target: { value: '65,50' } });
  expect(
    (screen.getByRole('button', { name: 'Confirm and import' }) as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /October 3, 2026/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
  expect(api.importLegacy).not.toHaveBeenCalled();
  expect(await screen.findByText(/2026-10-03.*65.50 USD/)).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: 'Confirm and import' });
  fireEvent.click(buttons.at(-1)!);
  await waitFor(() =>
    expect(api.importLegacy).toHaveBeenCalledWith(
      'team',
      'legacy',
      'balance',
      '2026-10-03',
      '65.50',
      'UTC',
      expect.any(String)
    )
  );
  expect(onImported).toHaveBeenCalledOnce();
  const signals = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[2].operation === 'financeLegacyImport');
  expect(signals.map(call => call[1])).toEqual(['requested', 'accepted', 'terminal']);
  expect(signals.at(-1)?.[2].result).toBe('partial');
  expect(signals.some(call => call[1] === 'applied')).toBe(false);
  expect(JSON.stringify(signals)).not.toContain('legacy');
  expect(
    signals.every(call =>
      Object.keys(call[2]).every(key => ['flowId', 'operation', 'outcome', 'result'].includes(key))
    )
  ).toBe(true);
});

it('reports an unavailable legacy source without enabling import or claiming delivered history', async () => {
  api.legacy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const onImported = vi.fn();
  render(
    <LegacyFinanceReview
      teamId="team"
      agent="agent"
      today="2026-10-03"
      timezone="UTC"
      onClose={vi.fn()}
      onImported={onImported}
    />
  );
  expect(
    await screen.findByText('Could not complete the operation. Your draft is retained.')
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Confirm and import' })).toHaveProperty(
    'disabled',
    true
  );
  expect(api.importLegacy).not.toHaveBeenCalled();
  expect(onImported).not.toHaveBeenCalled();
  const signals = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[2].operation === 'financeHistory');
  expect(
    signals.some(
      call =>
        call[1] === 'terminal' && call[2].result === 'unknown' && call[2].outcome === 'failure'
    )
  ).toBe(true);
  expect(signals.some(call => call[1] === 'applied')).toBe(false);
});

it('retains the confirmed legacy import and identical request after failure until a successful retry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
  api.legacy.mockResolvedValueOnce([
    {
      id: 'legacy',
      balance_units: 70,
      requested_topup_units: 200,
      balance_imported_event_id: null,
      topup_imported_event_id: null
    }
  ]);
  api.importLegacy
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ fields: [] });
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(
    <LegacyFinanceReview
      teamId="team"
      agent="agent"
      today="2026-10-03"
      timezone="UTC"
      onClose={onClose}
      onImported={onImported}
    />
  );
  await screen.findByText('70');
  fireEvent.change(screen.getByRole('textbox', { name: 'USD' }), { target: { value: '65,50' } });
  fireEvent.click(screen.getByRole('button', { name: /October 3, 2026/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Confirm and import' }).at(-1)!);
  await waitFor(() =>
    expect(screen.getAllByText(/Could not complete the operation/).length).toBeGreaterThan(0)
  );
  expect(onImported).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'USD' })).toHaveProperty('value', '65,50');
  fireEvent.click(screen.getAllByRole('button', { name: 'Confirm and import' }).at(-1)!);
  await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
  expect(onClose).toHaveBeenCalledOnce();
  expect(api.importLegacy).toHaveBeenCalledTimes(2);
  expect(api.importLegacy.mock.calls[1]).toEqual(api.importLegacy.mock.calls[0]);
});
