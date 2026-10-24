// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { financeToday, type FinanceSnapshot } from '@video-compressor/shared';
import {
  UnifiedFinanceProvider,
  UnifiedAgentFinanceFields,
  UnifiedFinanceToolbar,
  useUnifiedFinance,
  previousFinanceDay,
  type FinanceSaveSummary
} from '../apps/web/src/team/accounts/finance/UnifiedFinance';
import { ToastProvider } from '../apps/web/src/components/toast';
import * as toastModule from '../apps/web/src/components/toast';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
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
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
const date = financeToday();
const yesterday = previousFinanceDay(date);
function fixture(): FinanceSnapshot {
  return {
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from: yesterday,
    to: date,
    currency: 'USD',
    generatedAt: 'now',
    accounts: [{ id: 'social', name: 'Social' }],
    agents: [
      { id: 'a', agentId: 'g1-926' },
      { id: 'b', agentId: 'g2-927' }
    ],
    placements: ['a', 'b'].map(id => ({
      id: `p-${id}`,
      agentRowId: id,
      accountId: 'social',
      startsOn: '2026-01-01',
      endsOn: null,
      version: '1'
    })),
    fields: []
  };
}
/** Controller recovery fixture: explicit day selection retains dated drafts. */
function DateControls() {
  const finance = useUnifiedFinance();
  return (
    <>
      <button onClick={() => finance.setDate(yesterday)}>Select previous day</button>
      <button onClick={() => finance.setDate(date)}>Return today</button>
    </>
  );
}
async function previousSpend() {
  fireEvent.click(screen.getByRole('button', { name: 'Select previous day' }));
  const input = await screen.findByRole('textbox', { name: `g1-926 · ${yesterday} · Spend · USD` });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  return input;
}
async function returnToday() {
  fireEvent.click(screen.getByRole('button', { name: 'Return today' }));
  const input = await screen.findByRole('textbox', { name: `g1-926 · ${date} · Balance · USD` });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  return input;
}
function Editor() {
  const [open, setOpen] = useState(true);
  const finance = useUnifiedFinance();
  return (
    <>
      <DateControls />
      <button onClick={() => setOpen(!open)}>Fold</button>
      <button
        onClick={() => {
          void finance.saveSubset();
        }}
      >
        Save
      </button>
      <output>{finance.getAffectedDrafts().length}</output>
      {open && (
        <>
          <UnifiedAgentFinanceFields agentRowId="a" accountId="social" contextLabel="g1-926" />
          <UnifiedAgentFinanceFields agentRowId="b" accountId="social" contextLabel="g2-927" />
        </>
      )}
    </>
  );
}
async function start() {
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...fixture(),
    from,
    to
  }));
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <Editor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  const input = await screen.findByRole('textbox', { name: `g1-926 · ${date} · Balance · USD` });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  return input;
}
it('retains explicitly selected dated drafts through unmount and saves each dated field separately', async () => {
  const balance = await start();
  fireEvent.change(balance, { target: { value: '103,20' } });
  const spend = await previousSpend();
  fireEvent.change(spend, { target: { value: '7,35' } });
  await returnToday();
  fireEvent.click(screen.getByText('Fold'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('2');
  vi.mocked(teamFinanceApi.set).mockResolvedValue({
    requestId: 'request',
    fields: [],
    undoReference: null
  });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(teamFinanceApi.set).toHaveBeenCalledTimes(2));
  expect(teamFinanceApi.set).toHaveBeenCalledWith(
    'team',
    'a',
    date,
    'balance',
    '103.20',
    '0',
    expect.any(String),
    expect.any(String),
    'p-a',
    'normal'
  );
  expect(teamFinanceApi.set).toHaveBeenCalledWith(
    'team',
    'a',
    yesterday,
    'spend',
    '7.35',
    '0',
    expect.any(String),
    expect.any(String),
    'p-a',
    'normal'
  );
});
it('restores exact raw text after a row folds and Enter moves vertically without saving', async () => {
  const input = await start();
  fireEvent.change(input, { target: { value: '12,' } });
  fireEvent.click(screen.getByText('Fold'));
  fireEvent.click(screen.getByText('Fold'));
  const restored = screen.getByRole('textbox', { name: `g1-926 · ${date} · Balance · USD` });
  expect((restored as HTMLInputElement).value).toBe('12,');
  fireEvent.change(restored, { target: { value: '12,30' } });
  restored.focus();
  fireEvent.keyDown(restored, { key: 'Enter' });
  expect(document.activeElement).toBe(
    screen.getByRole('textbox', { name: `g2-927 · ${date} · Balance · USD` })
  );
  expect(teamFinanceApi.set).not.toHaveBeenCalled();
});
it('retries an unknown transport result with the identical request id and payload', async () => {
  const input = await start();
  fireEvent.change(input, { target: { value: '12' } });
  vi.mocked(teamFinanceApi.set)
    .mockRejectedValueOnce(new Error('network disconnected'))
    .mockResolvedValueOnce({ requestId: 'request', fields: [], undoReference: null });
  fireEvent.click(screen.getByText('Save'));
  await screen.findByText('Could not save');
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(teamFinanceApi.set).toHaveBeenCalledTimes(2));
  expect(vi.mocked(teamFinanceApi.set).mock.calls[0]).toEqual(
    vi.mocked(teamFinanceApi.set).mock.calls[1]
  );
  const requests = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[0] === 'finance_edit' && call[1] === 'requested');
  expect(requests).toHaveLength(2);
  expect(requests[0]![2].attemptId).toBe(requests[1]![2].attemptId);
  expect(requests[0]![2].attemptId).not.toBe(vi.mocked(teamFinanceApi.set).mock.calls[0]![7]);
});

it('renders period totals in the existing RK row without editable daily fields or another report table', async () => {
  const data = fixture();
  data.fields = [
    {
      agentRowId: 'a',
      date: yesterday,
      metric: 'topup',
      value: '12.00',
      currency: 'USD',
      version: '1',
      placementId: 'p-a',
      updatedAt: 'now',
      updatedBy: null
    },
    {
      agentRowId: 'a',
      date,
      metric: 'topup',
      value: '13.00',
      currency: 'USD',
      version: '1',
      placementId: 'p-a',
      updatedAt: 'now',
      updatedBy: null
    },
    {
      agentRowId: 'a',
      date,
      metric: 'balance',
      value: '99.00',
      currency: 'USD',
      version: '1',
      placementId: 'p-a',
      updatedAt: 'now',
      updatedBy: null
    }
  ];
  vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(data);
  function RangeEditor() {
    const finance = useUnifiedFinance();
    return (
      <>
        <button onClick={() => finance.setReportRange([yesterday, date])}>Range</button>
        <UnifiedFinanceToolbar />
        <UnifiedAgentFinanceFields agentRowId="a" accountId="social" contextLabel="g1-926" />
      </>
    );
  }
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <RangeEditor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  fireEvent.click(screen.getByText('Range'));
  const total = await screen.findByLabelText(`g1-926 · Top-up · ${yesterday} — ${date} · USD`);
  await waitFor(() => expect(total.textContent).toBe('25'));
  expect(screen.getByLabelText(`g1-926 · Balance · ${yesterday} — ${date} · USD`).textContent).toBe(
    '99'
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();
});

it('stops a two-field save when its provider unmounts while the first request is pending', async () => {
  const push = vi.fn().mockReturnValue(1);
  vi.spyOn(toastModule, 'useToasts').mockReturnValue({
    toasts: [],
    push,
    update: vi.fn(),
    dismiss: vi.fn()
  });
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...fixture(),
    from,
    to
  }));
  let completeFirst!: (value: Awaited<ReturnType<typeof teamFinanceApi.set>>) => void;
  vi.mocked(teamFinanceApi.set).mockImplementation(
    () =>
      new Promise(resolve => {
        completeFirst = resolve;
      })
  );
  const view = render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="old-owner" canEdit revision={0}>
        <Editor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  const balance = await screen.findByRole('textbox', { name: `g1-926 · ${date} · Balance · USD` });
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(balance, { target: { value: '125' } });
  fireEvent.change(screen.getByRole('textbox', { name: `g1-926 · ${date} · Top-up · USD` }), {
    target: { value: '40' }
  });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(teamFinanceApi.set).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => {
    completeFirst({
      requestId: 'accepted-server-receipt',
      fields: [],
      undoReference: 'accepted-clear'
    });
  });
  expect(teamFinanceApi.set).toHaveBeenCalledTimes(1);
  expect(teamFinanceApi.undo).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});
it('keeps focus on invalid raw money on Enter and Shift+Enter without submitting it', async () => {
  const balance = await start();
  fireEvent.change(balance, { target: { value: '12,,3' } });
  balance.focus();
  fireEvent.keyDown(balance, { key: 'Enter' });
  expect(document.activeElement).toBe(balance);
  expect(screen.getByText('Invalid amount')).toBeTruthy();
  fireEvent.keyDown(balance, { key: 'Enter', shiftKey: true });
  expect(document.activeElement).toBe(balance);
  expect(teamFinanceApi.set).not.toHaveBeenCalled();
});

it('never copies a completed report after the initiating finance scope unmounts', async () => {
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...fixture(),
    from,
    to
  }));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  function CopyEditor() {
    const finance = useUnifiedFinance();
    return (
      <button
        onClick={() => {
          void finance.copyTopups('account');
        }}
      >
        Copy report
      </button>
    );
  }
  const view = render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <CopyEditor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  await waitFor(() => expect(teamFinanceApi.snapshot).toHaveBeenCalledTimes(1));
  let completeRead!: (value: FinanceSnapshot) => void;
  vi.mocked(teamFinanceApi.snapshot).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        completeRead = resolve;
      })
  );
  fireEvent.click(screen.getByText('Copy report'));
  await waitFor(() => expect(teamFinanceApi.snapshot).toHaveBeenCalledTimes(2));
  view.unmount();
  const report = fixture();
  report.fields.push({
    agentRowId: 'a',
    date,
    metric: 'topup',
    value: '40.00',
    currency: 'USD',
    version: '1',
    placementId: 'p-a',
    updatedAt: 'now',
    updatedBy: null
  });
  await act(async () => {
    completeRead(report);
  });
  expect(writeText).not.toHaveBeenCalled();
  Reflect.deleteProperty(navigator, 'clipboard');
});

it('reports export receipt and its unobservable OS boundary without inventing applied delivery', async () => {
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...fixture(),
    from,
    to
  }));
  let receiveBinary!: () => void;
  vi.mocked(teamFinanceApi.export).mockImplementation(
    () =>
      new Promise<void>(resolve => {
        receiveBinary = resolve;
      })
  );
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <UnifiedFinanceToolbar />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  const button = screen.getByRole('button', { name: 'Export Excel' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(teamFinanceApi.export).toHaveBeenCalledOnce());
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.filter(call => call[2].operation === 'financeExport')
      .map(call => call[1])
  ).toEqual(['requested']);
  await act(async () => {
    receiveBinary();
  });
  const calls = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[2].operation === 'financeExport');
  expect(calls.map(call => call[1])).toEqual(['requested', 'accepted', 'terminal']);
  expect(calls.at(-1)?.[2]).toMatchObject({ result: 'partial', outcome: 'success' });
  expect(new Set(calls.map(call => call[2].flowId)).size).toBe(1);
  expect(calls.some(call => call[1] === 'applied')).toBe(false);
  expect(JSON.stringify(calls)).not.toContain(date);
});
it('confirms clear and Undo only after canonical returned field versions reach the visible row', async () => {
  const data = fixture();
  const field = {
    agentRowId: 'a',
    date,
    metric: 'balance' as const,
    value: '125.00',
    currency: 'USD' as const,
    version: '1',
    placementId: 'p-a',
    updatedAt: 'now',
    updatedBy: null
  };
  data.fields = [field];
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...data,
    from,
    to,
    fields: [...data.fields]
  }));
  vi.mocked(teamFinanceApi.clear).mockImplementation(async () => {
    data.fields = [{ ...field, value: null, version: '2' }];
    return { requestId: 'clear', fields: data.fields, undoReference: 'clear' };
  });
  vi.mocked(teamFinanceApi.undo).mockImplementation(async () => {
    data.fields = [{ ...field, version: '3' }];
    return { requestId: 'undo', fields: data.fields, undoReference: null };
  });
  function ClearEditor() {
    const finance = useUnifiedFinance();
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(!open)}>Fold financial row</button>
        <button onClick={() => finance.setClearing('balance')}>Clear field</button>
        {open && (
          <UnifiedAgentFinanceFields agentRowId="a" accountId="social" contextLabel="g1-926" />
        )}
      </>
    );
  }
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <ClearEditor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  const input = await screen.findByRole('textbox', { name: `g1-926 · ${date} · Balance · USD` });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('125'));
  fireEvent.click(screen.getByText('Fold financial row'));
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByText('Clear field'));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.filter(call => call[2].operation === 'financeClear')
      .map(call => call[1])
  ).toEqual(['requested', 'accepted', 'terminal']);
  fireEvent.click(screen.getByText('Fold financial row'));
  const clearedInput = await screen.findByRole('textbox', {
    name: `g1-926 · ${date} · Balance · USD`
  });
  await waitFor(() => expect((clearedInput as HTMLInputElement).value).toBe(''));
  expect(
    clearedInput.closest('[data-finance-field-version]')?.getAttribute('data-finance-field-version')
  ).toBe('2');
  const cleared = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[2].operation === 'financeClear');
  expect(cleared.map(call => call[1])).toEqual(['requested', 'accepted', 'terminal', 'applied']);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect((clearedInput as HTMLInputElement).value).toBe('125'));
  const undone = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[2].operation === 'financeUndo');
  expect(undone.map(call => call[1])).toEqual(['requested', 'accepted', 'terminal', 'applied']);
  expect(new Set(undone.map(call => call[2].flowId)).size).toBe(1);
  expect(undone[0]![2].flowId).not.toBe(cleared[0]![2].flowId);
  expect(JSON.stringify([...cleared, ...undone])).not.toMatch(/p-a|owner|g1-926/);
  expect(JSON.stringify([...cleared, ...undone])).not.toContain('125.00');
});

it('correlates two dated partial saves to one lifecycle flow with separate private child attempts', async () => {
  const parentFlow = '78500000-0000-4000-8000-000000000011';
  const data = fixture();
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...data,
    from,
    to,
    fields: [...data.fields]
  }));
  const summaries: Readonly<FinanceSaveSummary>[] = [];
  let saved: boolean | undefined;
  vi.mocked(teamFinanceApi.set).mockImplementation(
    async (_team, agent, entryDate, metric, value) => {
      if (entryDate === yesterday) throw new Error('FINANCE_CONFLICT');
      const canonical = {
        agentRowId: agent,
        date: entryDate,
        metric,
        value,
        currency: 'USD' as const,
        version: '1',
        placementId: 'p-a',
        updatedAt: 'now',
        updatedBy: null
      };
      data.fields = [canonical];
      return { requestId: 'receipt', fields: [canonical], undoReference: null };
    }
  );
  function ArchiveSaveEditor() {
    const finance = useUnifiedFinance();
    return (
      <>
        <button
          onClick={() => {
            void finance
              .saveSubset(['a'], {
                flowId: parentFlow,
                onSummary: summary => summaries.push(summary)
              })
              .then(result => {
                saved = result;
              });
          }}
        >
          Resolve archive drafts
        </button>
        <DateControls />
        <output aria-label="Remaining drafts">{finance.getAffectedDrafts(['a']).length}</output>
        <UnifiedAgentFinanceFields agentRowId="a" accountId="social" contextLabel="g1-926" />
      </>
    );
  }
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <ArchiveSaveEditor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  const balance = await screen.findByRole('textbox', { name: `g1-926 · ${date} · Balance · USD` });
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(balance, { target: { value: '125' } });
  fireEvent.change(await previousSpend(), { target: { value: '7,35' } });
  await returnToday();
  fireEvent.click(screen.getByText('Resolve archive drafts'));
  await waitFor(() => expect(saved).toBe(false));
  expect(summaries).toEqual([
    { attempted: 2, accepted: 1, failed: 1, unknown: 0, firstFailureCode: 'VERSION_CONFLICT' }
  ]);
  expect(screen.getByLabelText('Remaining drafts').textContent).toBe('1');
  const signals = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[0] === 'finance_edit');
  expect(signals.every(call => call[2].flowId === parentFlow)).toBe(true);
  const requests = signals.filter(call => call[1] === 'requested');
  expect(new Set(requests.map(call => call[2].attemptId)).size).toBe(2);
  expect(requests.map(call => call[2].day)).toEqual(['today', 'previous']);
  for (const request of requests) {
    const child = signals.filter(call => call[2].attemptId === request[2].attemptId);
    expect(child.every(call => call[2].day === request[2].day)).toBe(true);
    expect(child.map(call => call[1])).toEqual(
      request[2].day === 'today' ? ['requested', 'accepted', 'applied'] : ['requested', 'terminal']
    );
  }
  expect(JSON.stringify(signals)).not.toMatch(/g1-926|p-a|125\.00|7\.35/);
  expect(JSON.stringify(summaries)).not.toContain(yesterday);
});
it('reports an empty save subset safely without inventing a finance request or changing boolean ABI', async () => {
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...fixture(),
    from,
    to
  }));
  const summaries: Readonly<FinanceSaveSummary>[] = [];
  let saved: boolean | undefined;
  function EmptyEditor() {
    const finance = useUnifiedFinance();
    return (
      <button
        onClick={() => {
          void finance
            .saveSubset(['a'], {
              flowId: '78500000-0000-4000-8000-000000000012',
              onSummary: summary => summaries.push(summary)
            })
            .then(result => {
              saved = result;
            });
        }}
      >
        Save empty subset
      </button>
    );
  }
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <EmptyEditor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  fireEvent.click(screen.getByText('Save empty subset'));
  await waitFor(() => expect(saved).toBe(true));
  expect(summaries).toEqual([{ attempted: 0, accepted: 0, failed: 0, unknown: 0 }]);
  expect(teamFinanceApi.set).not.toHaveBeenCalled();
  expect(
    vi.mocked(emitAccountSignal).mock.calls.filter(call => call[0] === 'finance_edit')
  ).toEqual([]);
});
it('marks an actual archived historical correction accepted then applied only with its canonical displayed version', async () => {
  const historicalDate = previousFinanceDay(previousFinanceDay(previousFinanceDay(date)));
  const data = fixture();
  data.schemaVersion = 2;
  data.lifecycle = {
    accounts: [
      {
        id: 'social',
        createdAt: '2026-01-01T00:00:00Z',
        archivedAt: null,
        version: '0',
        sortRank: '0'
      }
    ],
    agents: ['a', 'b'].map(id => ({
      id,
      accountId: 'social',
      createdAt: '2026-01-01T00:00:00Z',
      archivedAt: id === 'a' ? `${date}T07:00:00Z` : null,
      version: '1',
      sortRank: '0'
    })),
    events: [],
    parents: []
  };
  const oldField = {
    agentRowId: 'a',
    date: historicalDate,
    metric: 'spend' as const,
    value: '5.00',
    currency: 'USD' as const,
    version: '1',
    placementId: 'p-a',
    updatedAt: 'now',
    updatedBy: null
  };
  data.fields = [oldField];
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...data,
    from,
    to,
    fields: data.fields.filter(field => field.date >= from && field.date <= to)
  }));
  vi.mocked(teamFinanceApi.set).mockImplementation(async () => {
    data.fields = [{ ...oldField, value: '7.50', version: '2' }];
    return { requestId: 'correction-receipt', fields: data.fields, undoReference: null };
  });
  function CorrectionEditor() {
    const finance = useUnifiedFinance();
    return (
      <button onClick={() => finance.setCorrection({ agent: 'a', date: historicalDate })}>
        Correct archived day
      </button>
    );
  }
  render(
    <ToastProvider>
      <UnifiedFinanceProvider teamId="team" userId="owner" canEdit revision={0}>
        <CorrectionEditor />
      </UnifiedFinanceProvider>
    </ToastProvider>
  );
  fireEvent.click(screen.getByText('Correct archived day'));
  const dialog = await screen.findByRole('dialog');
  const input = within(dialog).getByRole('textbox', {
    name: new RegExp(`${historicalDate} · Spend · USD$`)
  });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(input, { target: { value: '7,50' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(
      input.closest('[data-finance-field-version]')?.getAttribute('data-finance-field-version')
    ).toBe('2')
  );
  expect(vi.mocked(teamFinanceApi.set).mock.calls[0]!.at(-1)).toBe('historical_correction');
  // DOM commit and the provider's passive delivery-proof effect are separate
  // observations. Seeing version 2 does not synchronously flush that effect.
  await waitFor(() =>
    expect(
      vi
        .mocked(emitAccountSignal)
        .mock.calls.filter(call => call[0] === 'finance_edit')
        .map(call => call[1])
    ).toEqual(['requested', 'accepted', 'applied'])
  );
  const signals = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[0] === 'finance_edit');
  expect(signals.map(call => call[1])).toEqual(['requested', 'accepted', 'applied']);
  expect(signals.every(call => call[2].day === 'historical')).toBe(true);
  expect(new Set(signals.map(call => call[2].attemptId)).size).toBe(1);
  expect(JSON.stringify(signals)).not.toContain(historicalDate);
  expect(JSON.stringify(signals)).not.toMatch(/p-a|7\.50|g1-926/);
});
