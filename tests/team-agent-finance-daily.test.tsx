// @vitest-environment jsdom
/**
 * The daily finance row, accepted the way a person uses it (027 T012): the
 * keyboard on a field, a single clear confirmed and undone for each of the
 * three metrics, a conflicting write that keeps the draft, a no-op clear that
 * offers nothing to undo, and a viewer who gets no way to write.
 */
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { financeToday, type FinanceSnapshot } from '@video-compressor/shared';
import { FinanceWorkspace } from '../apps/web/src/team/accounts/finance/FinanceWorkspace';
import { DailyFinanceField } from '../apps/web/src/team/accounts/finance/DailyFinanceFields';
import { ToastProvider } from '../apps/web/src/components/toast';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';

vi.mock('../apps/web/src/api/team-finance', () => ({
  teamFinanceApi: { snapshot: vi.fn(), set: vi.fn(), undo: vi.fn(), clear: vi.fn() }
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const date = financeToday();

function snapshot(): FinanceSnapshot {
  const field = (metric: 'spend' | 'balance' | 'topup', value: string) => ({
    agentRowId: 'agent',
    date,
    metric,
    value,
    currency: 'USD' as const,
    version: '3',
    placementId: 'placement',
    updatedAt: 'now',
    updatedBy: null
  });
  return {
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from: date,
    to: date,
    currency: 'USD',
    generatedAt: 'now',
    accounts: [{ id: 'account', name: 'Account' }],
    agents: [{ id: 'agent', agentId: '123' }],
    placements: [
      {
        id: 'placement',
        agentRowId: 'agent',
        accountId: 'account',
        startsOn: '2026-01-01',
        endsOn: null,
        version: '1'
      }
    ],
    fields: [field('spend', '12.34'), field('balance', '70.00'), field('topup', '50.00')]
  };
}

const LABEL = { spend: 'Spend', balance: 'Balance', topup: 'Top-up' } as const;

function input(metric: keyof typeof LABEL) {
  return screen.getByRole('textbox', {
    name: `123 · ${date} · ${LABEL[metric]} · USD`
  }) as HTMLInputElement;
}

async function renderWorkspace(canEdit = true) {
  vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(snapshot());
  render(
    <ToastProvider>
      <FinanceWorkspace teamId="team" revision={0} canEdit={canEdit} />
    </ToastProvider>
  );
  await screen.findByRole('textbox', { name: new RegExp(`${LABEL.spend} · USD$`) });
}

/** Empties one field and saves it through the bar, confirming the clear. */
async function clearAndConfirm(metric: keyof typeof LABEL) {
  const user = userEvent.setup();
  await user.clear(input(metric));
  // The bar's Save; a clear is never written without its own confirmation.
  await user.click(screen.getByRole('button', { name: 'Save' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('Only the displayed day is cleared');
  expect(teamFinanceApi.set).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  return user;
}

it('saves a standalone field on Enter, keeps native Tab, and lets Escape drop the draft', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <DailyFinanceField
      metric="topup"
      field={snapshot().fields[2]}
      placementId="placement"
      canEdit
      save={save}
    />
  );
  const field = screen.getByRole('textbox') as HTMLInputElement;

  fireEvent.change(field, { target: { value: '80' } });
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(field.value).toBe('50');
  expect(save).not.toHaveBeenCalled();

  fireEvent.change(field, { target: { value: '80,5' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith('80.50', '3', expect.any(String), 'placement')
  );

  // A valid draft saves on Tab without stopping the caret moving on.
  fireEvent.change(field, { target: { value: '90' } });
  expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(true);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
});

it.each(['spend', 'balance', 'topup'] as const)(
  'clears one %s value after confirmation and puts it back with Undo',
  async metric => {
    vi.mocked(teamFinanceApi.set).mockResolvedValue({
      requestId: 'clear-request',
      fields: [],
      undoReference: 'clear-request'
    });
    vi.mocked(teamFinanceApi.undo).mockResolvedValue({
      requestId: 'undo',
      fields: [],
      undoReference: null
    });
    await renderWorkspace();

    const user = await clearAndConfirm(metric);
    await waitFor(() =>
      expect(teamFinanceApi.set).toHaveBeenCalledWith(
        'team',
        'agent',
        date,
        metric,
        null,
        '3',
        expect.any(String),
        expect.any(String),
        'placement'
      )
    );
    await screen.findByText('Value cleared');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(teamFinanceApi.undo).toHaveBeenCalledWith('team', 'clear-request', expect.any(String))
    );
    // The other two metrics were never written.
    expect(teamFinanceApi.set).toHaveBeenCalledTimes(1);
  }
);

it('offers no Undo when the clear changed nothing', async () => {
  vi.mocked(teamFinanceApi.set).mockResolvedValue({
    requestId: 'noop',
    fields: [],
    undoReference: null
  });
  await renderWorkspace();

  await clearAndConfirm('balance');
  await waitFor(() => expect(teamFinanceApi.set).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Value cleared')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
});

it('says when an Undo lost to a newer write, instead of overwriting it', async () => {
  vi.mocked(teamFinanceApi.set).mockResolvedValue({
    requestId: 'clear-request',
    fields: [],
    undoReference: 'clear-request'
  });
  vi.mocked(teamFinanceApi.undo).mockRejectedValue(new Error('FINANCE_CONFLICT'));
  await renderWorkspace();

  const user = await clearAndConfirm('topup');
  await user.click(await screen.findByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(teamFinanceApi.undo).toHaveBeenCalledTimes(1));
  // The conflict is said in a toast; nothing else is written.
  await screen.findByText(/^This value changed\./);
  expect(teamFinanceApi.set).toHaveBeenCalledTimes(1);
});

it('keeps the draft and shows the current value when the write conflicts', async () => {
  vi.mocked(teamFinanceApi.set).mockRejectedValue(new Error('FINANCE_CONFLICT'));
  await renderWorkspace();
  const user = userEvent.setup();

  await user.clear(input('spend'));
  await user.type(input('spend'), '99');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(teamFinanceApi.set).toHaveBeenCalledTimes(1));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Value changed');
  expect(alert.textContent).toContain('12,34 USD');
  expect(input('spend').value).toBe('99');
});

it('gives a viewer the figures and no way to change or clear them', async () => {
  await renderWorkspace(false);

  for (const metric of ['spend', 'balance', 'topup'] as const) {
    expect(input(metric).readOnly).toBe(true);
  }
  expect(input('spend').value).toBe('12,34');
  fireEvent.change(input('spend'), { target: { value: '1' } });
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Actions for the selected day' })).toBeNull();
  expect(teamFinanceApi.set).not.toHaveBeenCalled();
});
