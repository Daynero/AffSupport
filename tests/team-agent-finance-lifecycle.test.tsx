// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  financeToday,
  type FinanceSnapshot,
  type TeamAccountAgentSummary
} from '@video-compressor/shared';
import { LegacyFinanceReview } from '../apps/web/src/team/accounts/finance/LegacyFinanceReview';
import { FinanceWorkspace } from '../apps/web/src/team/accounts/finance/FinanceWorkspace';
import { ToastProvider } from '../apps/web/src/components/toast';
import * as clipboard from '../apps/web/src/two-factor/clipboard';
const api = vi.hoisted(() => ({
  legacy: vi.fn(),
  importLegacy: vi.fn(),
  snapshot: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
  undo: vi.fn()
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
});

/*
 * The day's corrections and copies in the workspace (027 T035): a bulk clear
 * names the day, the metric and how many entries it takes, sends exactly the
 * versions it showed, and offers its own Undo; copying the day's top-ups out,
 * under either grouping, writes nothing.
 */
const today = financeToday();

function daySnapshot(): FinanceSnapshot {
  const placement = (id: string, accountId: string, agentRowId: string) => ({
    id,
    accountId,
    agentRowId,
    startsOn: '2026-01-01',
    endsOn: null,
    version: '1'
  });
  const field = (
    agentRowId: string,
    placementId: string,
    metric: 'balance' | 'topup',
    value: string | null,
    version: string
  ) => ({
    agentRowId,
    date: today,
    metric,
    value,
    currency: 'USD' as const,
    version,
    placementId,
    updatedAt: 'now',
    updatedBy: null
  });
  return {
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from: today,
    to: today,
    currency: 'USD',
    generatedAt: 'now',
    accounts: [
      { id: 'v31', name: 'v31' },
      { id: 'f40', name: 'f40' }
    ],
    agents: [
      { id: 'a1', agentId: '111' },
      { id: 'a2', agentId: '222' },
      { id: 'a3', agentId: '333' }
    ],
    placements: [
      placement('p1', 'v31', 'a1'),
      placement('p2', 'v31', 'a2'),
      placement('p3', 'f40', 'a3')
    ],
    fields: [
      field('a1', 'p1', 'topup', '50.00', '4'),
      field('a2', 'p2', 'topup', '0.00', '2'),
      field('a3', 'p3', 'topup', '100.00', '7'),
      field('a3', 'p3', 'balance', '20.00', '5'),
      // Already cleared: not an entry the bulk clear can take.
      field('a1', 'p1', 'balance', null, '9')
    ]
  };
}

function summary(id: string, labels: string[]): TeamAccountAgentSummary {
  return {
    id,
    accountId: 'v31',
    teamId: 'team',
    agentId: id,
    runs: [],
    labels: labels.map(name => ({ id: name, name, color: 'purple' as const })),
    balance: null,
    topup: null,
    taskCount: 0,
    createdAt: 'now',
    updatedAt: 'now'
  };
}

async function workspace() {
  api.snapshot.mockResolvedValue(daySnapshot());
  render(
    <ToastProvider>
      <FinanceWorkspace
        teamId="team"
        revision={0}
        canEdit
        agents={[summary('a1', ['#2']), summary('a2', ['#2']), summary('a3', [])]}
      />
    </ToastProvider>
  );
  await screen.findByRole('button', { name: 'Actions for the selected day' });
}

it("clears the day's top-ups after naming the day and the count, and undoes only that clear", async () => {
  api.clear.mockResolvedValue({ requestId: 'bulk', fields: [], undoReference: 'bulk' });
  api.undo.mockResolvedValue({ requestId: 'undo', fields: [], undoReference: null });
  await workspace();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Actions for the selected day' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Clear top-ups for this day' }));
  const dialog = await screen.findByRole('dialog');
  // Three top-ups are written today (the explicit zero is one); none is sent yet.
  expect(dialog.textContent).toContain(`${today} · 3 ad accounts.`);
  expect(api.clear).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Clear top-ups for this day' }));

  await waitFor(() =>
    expect(api.clear).toHaveBeenCalledWith(
      'team',
      today,
      'topup',
      [
        { agent: 'a1', expectedVersion: '4' },
        { agent: 'a2', expectedVersion: '2' },
        { agent: 'a3', expectedVersion: '7' }
      ],
      expect.any(String),
      expect.any(String)
    )
  );
  await screen.findByText('Value cleared');
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.undo).toHaveBeenCalledWith('team', 'bulk', expect.any(String)));
  expect(api.set).not.toHaveBeenCalled();
});

it("copies the day's top-ups by social account and by tag, and never clears them", async () => {
  const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
  await workspace();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Copy top-ups by social account' }));
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
  expect(copy.mock.calls[0]![0]).toBe(
    [`${today} · USD`, '', 'f40', '333 - $100', '', 'v31', '111 - $50'].join('\n')
  );
  await screen.findByText('Copied — 2 ad accounts');

  await user.click(screen.getByRole('button', { name: 'Copy top-ups by tag' }));
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
  expect(copy.mock.calls[1]![0]).toBe(
    [`${today} · USD`, '', '#2', '111 - $50', '', 'No tag', '333 - $100'].join('\n')
  );
  expect(api.clear).not.toHaveBeenCalled();
  expect(api.set).not.toHaveBeenCalled();
});
