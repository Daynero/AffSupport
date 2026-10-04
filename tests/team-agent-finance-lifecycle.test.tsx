// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LegacyFinanceReview } from '../apps/web/src/team/accounts/finance/LegacyFinanceReview';
const api = vi.hoisted(() => ({ legacy: vi.fn(), importLegacy: vi.fn() }));
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: api }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
