// @vitest-environment jsdom
import React from 'react';
import { FinanceWorkspace } from '../apps/web/src/team/accounts/finance/FinanceWorkspace';
import { ToastProvider } from '../apps/web/src/components/toast';
import { financeToday } from '@video-compressor/shared';
import * as clipboard from '../apps/web/src/two-factor/clipboard';
import {
  act,
  cleanup,
  renderHook,
  render,
  screen,
  fireEvent,
  waitFor
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FinanceSnapshot } from '@video-compressor/shared';
import { useAgentFinance } from '../apps/web/src/team/accounts/finance/useAgentFinance';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
vi.mock('../apps/web/src/api/team-finance', () => ({
  teamFinanceApi: { snapshot: vi.fn(), set: vi.fn() }
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const snapshot = (teamId: string): FinanceSnapshot => ({
  schemaVersion: 1,
  teamId,
  teamName: teamId,
  from: '2026-09-01',
  to: '2026-09-30',
  currency: 'USD',
  generatedAt: '2026-10-03T10:00:00Z',
  accounts: [],
  agents: [],
  placements: [],
  fields: []
});
it('coalesces a burst during an in-flight read into one follow-up and accepts later events', async () => {
  vi.useFakeTimers();
  let resolve: (s: FinanceSnapshot) => void = () => {};
  const read = vi.mocked(teamFinanceApi.snapshot);
  read
    .mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    )
    .mockResolvedValue(snapshot('a'));
  const view = renderHook(() => useAgentFinance('a', '2026-09-01', '2026-09-30', 'UTC', 0));
  for (let n = 0; n < 20; n++)
    act(() => window.dispatchEvent(new CustomEvent('soty:accounts-finance', { detail: 'a' })));
  await act(async () => resolve(snapshot('a')));
  await act(async () => vi.advanceTimersByTimeAsync(301));
  expect(read).toHaveBeenCalledTimes(2);
  act(() => window.dispatchEvent(new CustomEvent('soty:accounts-finance', { detail: 'a' })));
  await act(async () => vi.advanceTimersByTimeAsync(301));
  expect(read).toHaveBeenCalledTimes(3);
  expect(view.result.current.snapshot?.teamId).toBe('a');
});
it('drops late responses from another team and clears a revoked snapshot', async () => {
  vi.useFakeTimers();
  let resolve: (s: FinanceSnapshot) => void = () => {};
  const read = vi.mocked(teamFinanceApi.snapshot);
  read
    .mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    )
    .mockResolvedValueOnce(snapshot('b'));
  const view = renderHook(
    ({ team }) => useAgentFinance(team, '2026-09-01', '2026-09-30', 'UTC', 0),
    { initialProps: { team: 'a' } }
  );
  await act(async () => view.rerender({ team: 'b' }));
  await act(async () => resolve(snapshot('a')));
  expect(view.result.current.snapshot?.teamId).toBe('b');
  read.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
  act(() => view.result.current.refresh());
  await act(async () => vi.advanceTimersByTimeAsync(301));
  expect(view.result.current.snapshot).toBe(null);
});

it('keeps unsaved finance input and its original version while a workspace revision refreshes the table', async () => {
  const date = financeToday();
  const initial: FinanceSnapshot = {
    ...snapshot('a'),
    from: date,
    to: date,
    accounts: [{ id: 'account', name: 'Account' }],
    agents: [{ id: 'agent', agentId: '123' }],
    placements: [
      {
        id: 'placement',
        agentRowId: 'agent',
        accountId: 'account',
        startsOn: date,
        endsOn: null,
        version: '1'
      }
    ],
    fields: [
      {
        agentRowId: 'agent',
        date,
        metric: 'spend',
        value: '12.34',
        currency: 'USD',
        version: '1',
        placementId: 'placement',
        updatedAt: 'now',
        updatedBy: null
      }
    ]
  };
  let resolve!: (value: FinanceSnapshot) => void;
  const read = vi.mocked(teamFinanceApi.snapshot).mockReset();
  read.mockResolvedValueOnce(initial).mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r;
      })
  );
  const save = vi
    .mocked(teamFinanceApi.set)
    .mockResolvedValue({ requestId: 'request', fields: [], undoReference: null });
  const ui = (revision: number) => (
    <ToastProvider>
      <FinanceWorkspace teamId="a" revision={revision} canEdit />
    </ToastProvider>
  );
  const view = render(ui(0));
  const input = await screen.findByRole('textbox', { name: /Spend.*USD/ });
  const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
  const copySpend = screen.getByRole('button', { name: 'Copy amount: Spend' });
  expect(copySpend.parentElement?.parentElement?.firstElementChild?.textContent).toBe(date);
  fireEvent.click(copySpend);
  await waitFor(() => expect(copy).toHaveBeenCalledWith('12.34'));
  expect(
    (screen.getByRole('button', { name: 'Copy amount: Top-up' }) as HTMLButtonElement).disabled
  ).toBe(true);
  input.focus();
  fireEvent.change(input, { target: { value: '125,50' } });
  view.rerender(ui(1));
  expect(screen.getByRole('textbox', { name: /Spend.*USD/ })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('125,50');
  expect(document.activeElement).toBe(input);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('textbox', { name: /Spend.*USD/ })).toBe(input);
  await act(async () =>
    resolve({ ...initial, fields: [{ ...initial.fields[0]!, value: '50.00', version: '2' }] })
  );
  expect((input as HTMLInputElement).value).toBe('125,50');
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      'a',
      'agent',
      date,
      'spend',
      '125.50',
      '1',
      expect.any(String),
      expect.any(String),
      'placement'
    )
  );
});
it('keeps an edited row mounted in its original account after an external transfer', async () => {
  const date = financeToday();
  const initial: FinanceSnapshot = {
    ...snapshot('a'),
    from: date,
    to: date,
    accounts: [
      { id: 'old', name: 'Original' },
      { id: 'new', name: 'Destination' }
    ],
    agents: [{ id: 'agent', agentId: '123' }],
    placements: [
      {
        id: 'old-placement',
        agentRowId: 'agent',
        accountId: 'old',
        startsOn: date,
        endsOn: null,
        version: '1'
      }
    ],
    fields: []
  };
  const read = vi.mocked(teamFinanceApi.snapshot).mockReset().mockResolvedValue(initial);
  const save = vi
    .mocked(teamFinanceApi.set)
    .mockReset()
    .mockRejectedValue(new Error('PLACEMENT_CONFLICT'));
  render(
    <ToastProvider>
      <FinanceWorkspace teamId="a" revision={0} canEdit />
    </ToastProvider>
  );
  const input = await screen.findByRole('textbox', { name: /Top-up.*USD/ });
  fireEvent.change(input, { target: { value: '250' } });
  read.mockResolvedValue({
    ...initial,
    placements: [{ ...initial.placements[0]!, id: 'new-placement', accountId: 'new' }]
  });
  act(() => window.dispatchEvent(new CustomEvent('soty:accounts-finance', { detail: 'a' })));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('textbox', { name: /Top-up.*USD/ })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('250');
  expect(screen.getByText(/An account association changed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/The ad account moved to another account/);
  expect(save).toHaveBeenCalledWith(
    'a',
    'agent',
    date,
    'topup',
    '250.00',
    '0',
    expect.any(String),
    expect.any(String),
    'old-placement'
  );
  expect(screen.getByRole('textbox', { name: /Top-up.*USD/ })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('250');
});
