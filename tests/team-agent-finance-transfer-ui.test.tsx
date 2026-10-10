// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FinanceSnapshot } from '@video-compressor/shared';
import { MoveAgentDialog } from '../apps/web/src/team/accounts/finance/MoveAgentDialog';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
vi.mock('../apps/web/src/api/team-finance', () => ({
  teamFinanceApi: { transferEligibility: vi.fn(), move: vi.fn() }
}));
vi.mock('../apps/web/src/components/ui/index', async () => {
  const original = await vi.importActual<typeof import('../apps/web/src/components/ui/index')>(
    '../apps/web/src/components/ui/index'
  );
  return {
    ...original,
    Select: ({
      options,
      placeholder,
      value,
      onChange,
      disabled,
      ...props
    }: {
      options: { value: string; label: string }[];
      placeholder: string;
      value: string;
      onChange: (value: string) => void;
      disabled: boolean;
    }) => (
      <select {...props} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  };
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const snapshot: FinanceSnapshot = {
  schemaVersion: 1,
  teamId: 't',
  teamName: 'T',
  from: '2026-10-03',
  to: '2026-10-03',
  currency: 'USD',
  generatedAt: 'now',
  accounts: [
    { id: 'x', name: 'Source' },
    { id: 'y', name: 'Target' },
    { id: 'z', name: 'Other' }
  ],
  agents: [{ id: 'a', agentId: '001234' }],
  placements: [
    { id: 'p', agentRowId: 'a', accountId: 'x', startsOn: '2026-01-01', endsOn: null, version: '1' }
  ],
  fields: []
};
const eligible = {
  accountId: 'x',
  placementId: 'p',
  placementVersion: '1',
  minDate: '2026-01-01',
  blockers: []
};
const ui = (data = snapshot, onMoved = vi.fn()) => (
  <MoveAgentDialog
    snapshot={data}
    agent="a"
    today="2026-10-03"
    timezone="UTC"
    onClose={vi.fn()}
    onMoved={onMoved}
  />
);
it('labels the RK, filters actual targets and warns that every amount moves with it', async () => {
  vi.mocked(teamFinanceApi.transferEligibility).mockResolvedValue(eligible);
  render(ui());
  await waitFor(() =>
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false)
  );
  expect(screen.getByRole('heading', { name: /Transfer ad account/ }).textContent).toContain(
    'Transfer ad account 001234 from social account Source'
  );
  expect(screen.getByLabelText('001234').querySelector('.team-agent-tail')?.textContent).toBe(
    '234'
  );
  expect(screen.getByRole('note').textContent).toBe(
    'All of this ad account’s amounts — balances, top-ups and spend, for all time — will move to the new social account and will no longer count toward Source.'
  );
  // No date to pick: nothing blocks a transfer any more.
  expect(screen.queryByRole('grid')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'target' } });
  expect(screen.getByRole('option', { name: 'Target' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Other' })).toBeNull();
  expect(screen.getByText(/Matching social accounts: 1/)).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Move to another account' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'y' } });
  expect((button as HTMLButtonElement).disabled).toBe(false);
});
it('retries the exact original move after a lost response and a refreshed placement', async () => {
  vi.mocked(teamFinanceApi.transferEligibility).mockResolvedValue(eligible);
  const move = vi
    .mocked(teamFinanceApi.move)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({});
  const moved = vi.fn();
  const view = render(ui(snapshot, moved));
  await waitFor(() =>
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false)
  );
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'y' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move to another account' }));
  await screen.findByText(/The response was lost/);
  view.rerender(
    ui(
      {
        ...snapshot,
        placements: [{ ...snapshot.placements[0]!, id: 'new', accountId: 'y', version: '2' }]
      },
      moved
    )
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
  await waitFor(() => expect(moved).toHaveBeenCalledTimes(1));
  expect(move.mock.calls).toHaveLength(2);
  expect(move.mock.calls[1]).toEqual(move.mock.calls[0]);
  expect(move.mock.calls[0]!.slice(0, 6)).toEqual(['t', 'a', 'y', '2026-10-03', 'p', '1']);
});
