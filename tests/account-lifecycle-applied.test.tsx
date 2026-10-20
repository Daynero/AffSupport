// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { financeToday, type FinanceSnapshot } from '@video-compressor/shared';
import { TeamApiError } from '../apps/web/src/api/team';
import { AccountSpace } from '../apps/web/src/team/accounts/AccountSpace';
import { ToastProvider } from '../apps/web/src/components/toast';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
import { accountsWorkspaceApi } from '../apps/web/src/api/team-accounts-workspace';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
const permissions = vi.hoisted(() => ({ edit: true }));
/** Recovery fixture uses the real controller; dated drafts can predate the selected view. */
vi.mock('../apps/web/src/team/accounts/finance/UnifiedFinance', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../apps/web/src/team/accounts/finance/UnifiedFinance')>();
  function Dates() {
    const finance = actual.useUnifiedFinance();
    return (
      <>
        <button onClick={() => finance.setDate(actual.previousFinanceDay(finance.today))}>
          Select previous day
        </button>
        <button onClick={() => finance.setDate(finance.today)}>Return today</button>
      </>
    );
  }
  return {
    ...actual,
    UnifiedFinanceProvider: ({
      children,
      ...props
    }: Parameters<typeof actual.UnifiedFinanceProvider>[0]) => (
      <actual.UnifiedFinanceProvider {...props}>
        <Dates />
        {children}
      </actual.UnifiedFinanceProvider>
    )
  };
});
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({
    can: (permission: string) => permission !== 'edit' || permissions.edit,
    revision: 0
  })
}));
vi.mock('../apps/web/src/team/labels/useTaskLabels', () => ({
  useTaskLabels: () => ({ labels: [] })
}));
vi.mock('../apps/web/src/api/team-finance', () => ({
  teamFinanceApi: { snapshot: vi.fn(), set: vi.fn() }
}));
vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({
  accountsWorkspaceApi: { overview: vi.fn(), preflight: vi.fn(), archive: vi.fn() }
}));
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
afterEach(() => {
  permissions.edit = true;
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
const date = financeToday();
const timestamp = `${date}T01:00:00.000Z`;
function overview(archived = false): Awaited<ReturnType<typeof accountsWorkspaceApi.overview>> {
  return {
    schemaVersion: 1,
    coverage: 'complete',
    socialOrderVersion: '0',
    agentOrderVersions: { social: '0' },
    accounts: [
      {
        id: 'social',
        teamId: 'team',
        name: 'Social',
        twoFactorSeed: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: timestamp,
        archivedAt: archived ? timestamp : null,
        lifecycleVersion: archived ? '2' : '1',
        agents: [
          {
            id: 'rk',
            accountId: 'social',
            teamId: 'team',
            agentId: '123',
            runs: [],
            labels: [],
            balance: null,
            topup: null,
            taskCount: 0,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: timestamp,
            archivedAt: null,
            lifecycleVersion: '1'
          }
        ]
      }
    ]
  };
}
function snapshot(archived: boolean, explicit: boolean): FinanceSnapshot {
  return {
    schemaVersion: 2,
    teamId: 'team',
    teamName: 'Team',
    from: date,
    to: date,
    currency: 'USD',
    generatedAt: timestamp,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    accounts: [{ id: 'social', name: 'Social' }],
    agents: [{ id: 'rk', agentId: '123' }],
    placements: [
      {
        id: 'placement',
        accountId: 'social',
        agentRowId: 'rk',
        startsOn: '2026-01-01',
        endsOn: null,
        version: '1'
      }
    ],
    fields: explicit
      ? [
          {
            agentRowId: 'rk',
            date,
            metric: 'spend',
            value: '100.00',
            currency: 'USD',
            version: '1',
            placementId: 'placement',
            updatedAt: timestamp,
            updatedBy: null
          }
        ]
      : [],
    lifecycle: {
      accounts: [
        {
          id: 'social',
          createdAt: '2026-01-01T00:00:00Z',
          archivedAt: archived ? timestamp : null,
          version: archived ? '2' : '1',
          sortRank: 0
        }
      ],
      agents: [
        {
          id: 'rk',
          accountId: 'social',
          createdAt: '2026-01-01T00:00:00Z',
          archivedAt: null,
          version: '1',
          sortRank: 0
        }
      ],
      events: archived
        ? [{ entityId: 'social', entityKind: 'social', archived: true, occurredAt: timestamp }]
        : [],
      parents: []
    }
  };
}
function configure() {
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(overview(false));
  vi.mocked(accountsWorkspaceApi.preflight).mockResolvedValue({
    entityId: 'social',
    entityKind: 'social',
    lifecycleVersion: '1',
    token: 'before',
    archivedAt: null,
    effectiveArchived: false,
    childCount: 1
  });
  vi.mocked(accountsWorkspaceApi.archive).mockImplementation(async () => {
    vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(overview(true));
    return {
      entityId: 'social',
      entityKind: 'social',
      lifecycleVersion: '2',
      token: 'after',
      archivedAt: timestamp,
      effectiveArchived: true,
      childCount: 1,
      requestId: crypto.randomUUID(),
      operationId: crypto.randomUUID()
    };
  });
  vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(snapshot(false, false));
  return render(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
}
async function openArchiveDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'More actions for Social' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive Social' }));
}
async function selectPreviousSpend(previous: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Select previous day' }));
  const input = await screen.findByRole('textbox', {
    name: new RegExp(`${previous} · Spend · USD$`)
  });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  return input;
}
async function returnTodayBalance() {
  fireEvent.click(screen.getByRole('button', { name: 'Return today' }));
  const input = await screen.findByRole('textbox', {
    name: new RegExp(`${date} · Balance · USD$`)
  });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  return input;
}
async function startArchive() {
  await openArchiveDialog();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Archive$/ }));
}
function applied() {
  return vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(([action, stage]) => action === 'lifecycle' && stage === 'applied');
}
it.each([false, true])(
  'waits for matching finance lifecycle and classifies actual committed projection (explicit=%s)',
  async explicit => {
    const view = configure();
    await screen.findByRole('button', { name: 'Collapse Social' });
    let release: (value: FinanceSnapshot) => void = () => {
      throw new Error('No pending snapshot');
    };
    const fresh = new Promise<FinanceSnapshot>(resolve => {
      release = resolve;
    });
    vi.mocked(teamFinanceApi.snapshot).mockReturnValue(fresh);
    await startArchive();
    await waitFor(() => expect(accountsWorkspaceApi.archive).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(accountsWorkspaceApi.overview).toHaveBeenCalledTimes(2));
    expect(applied()).toHaveLength(0);
    await act(async () => {
      release(snapshot(true, explicit));
    });
    await waitFor(() => expect(applied()).toHaveLength(1));
    expect(applied()[0][2].result).toBe(
      explicit ? 'retained_period_data' : 'hidden_no_period_data'
    );
    expect(Boolean(view.container.querySelector('[data-account-id="social"]'))).toBe(explicit);
  }
);
it('does not submit a deferred preflight archive after the workspace unmounts', async () => {
  const view = configure();
  let release: (value: Awaited<ReturnType<typeof accountsWorkspaceApi.preflight>>) => void = () => {
    throw new Error('No preflight');
  };
  vi.mocked(accountsWorkspaceApi.preflight).mockReturnValue(
    new Promise(resolve => {
      release = resolve;
    })
  );
  await startArchive();
  await waitFor(() => expect(accountsWorkspaceApi.preflight).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => {
    release({
      entityId: 'social',
      entityKind: 'social',
      lifecycleVersion: '1',
      token: 'before',
      archivedAt: null,
      effectiveArchived: false,
      childCount: 1
    });
  });
  expect(accountsWorkspaceApi.archive).not.toHaveBeenCalled();
  expect(applied()).toHaveLength(0);
});

it('keeps visibility unknown when the canonical post-archive account refresh fails', async () => {
  configure();
  await screen.findByRole('button', { name: 'Collapse Social' });
  vi.mocked(accountsWorkspaceApi.overview).mockRejectedValueOnce(new Error('INVALID_RESPONSE'));
  vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(snapshot(true, false));
  await startArchive();
  await waitFor(() => expect(accountsWorkspaceApi.overview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(teamFinanceApi.snapshot).toHaveBeenCalledTimes(2));
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.some(([action, stage]) => action === 'lifecycle' && stage === 'accepted')
  ).toBe(true);
  expect(applied()).toHaveLength(0);
});

it('cancels archive on permission loss and releases its local busy state', async () => {
  const view = configure();
  let release!: (value: Awaited<ReturnType<typeof accountsWorkspaceApi.preflight>>) => void;
  vi.mocked(accountsWorkspaceApi.preflight).mockReturnValue(
    new Promise(resolve => {
      release = resolve;
    })
  );
  await startArchive();
  await waitFor(() => expect(accountsWorkspaceApi.preflight).toHaveBeenCalledTimes(1));
  permissions.edit = false;
  view.rerender(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  await act(async () => {
    release({
      entityId: 'social',
      entityKind: 'social',
      lifecycleVersion: '1',
      token: 'before',
      archivedAt: null,
      effectiveArchived: false,
      childCount: 1
    });
  });
  expect(accountsWorkspaceApi.archive).not.toHaveBeenCalled();
  expect(applied()).toHaveLength(0);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('retains a partial two-date finance save and releases frozen editors without starting archive preflight', async () => {
  configure();
  const yesterdayDate = new Date(`${date}T00:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const confirmed: FinanceSnapshot['fields'] = [];
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...snapshot(false, false),
    from,
    to,
    fields: [...confirmed]
  }));
  let rejectSecond!: (cause: Error) => void;
  vi.mocked(teamFinanceApi.set)
    .mockImplementationOnce(async (_team, agent, entryDate, metric, value) => {
      const field = {
        agentRowId: agent,
        date: entryDate,
        metric,
        value,
        currency: 'USD' as const,
        version: '1',
        placementId: 'placement',
        updatedAt: timestamp,
        updatedBy: null
      };
      confirmed.push(field);
      return { requestId: 'confirmed-finance-receipt', fields: [field], undoReference: null };
    })
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSecond = reject;
        })
    );
  let balance = await screen.findByRole('textbox', {
    name: new RegExp(`${date} · Balance · USD$`)
  });
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(balance, { target: { value: '125' } });
  fireEvent.change(await selectPreviousSpend(yesterday), { target: { value: '7,35' } });
  balance = await returnTodayBalance();
  await openArchiveDialog();
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save and archive' }));
  await waitFor(() => expect(teamFinanceApi.set).toHaveBeenCalledTimes(2));
  expect((balance as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('textbox', { name: new RegExp(`${yesterday} · Spend`) })).toBeNull();
  expect(
    (
      screen.getByRole('textbox', {
        name: new RegExp(`${date} · Spend · Today · USD$`)
      }) as HTMLInputElement
    ).disabled
  ).toBe(true);
  expect(accountsWorkspaceApi.preflight).not.toHaveBeenCalled();
  expect(accountsWorkspaceApi.archive).not.toHaveBeenCalled();
  await act(async () => {
    rejectSecond(new TeamApiError('FINANCE_CONFLICT', false));
  });
  await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy());
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  expect((balance as HTMLInputElement).disabled).toBe(false);
  expect((balance as HTMLInputElement).value).toBe('125');
  expect(balance.closest('[data-finance-state]')?.getAttribute('data-finance-state')).toBe('saved');
  expect(accountsWorkspaceApi.preflight).not.toHaveBeenCalled();
  expect(accountsWorkspaceApi.archive).not.toHaveBeenCalled();
  const lifecycle = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(([action]) => action === 'lifecycle');
  expect(lifecycle.map(call => call[1])).toEqual(['draft_resolution', 'terminal']);
  const terminal = lifecycle.at(-1)![2];
  expect(terminal).toMatchObject({
    outcome: 'failure',
    result: 'partial',
    count: 1,
    code: 'VERSION_CONFLICT'
  });
  const children = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(([action]) => action === 'finance_edit');
  expect(children.every(call => call[2].flowId === terminal.flowId)).toBe(true);
  const requested = children.filter(call => call[1] === 'requested');
  expect(requested).toHaveLength(2);
  expect(new Set(requested.map(call => call[2].attemptId)).size).toBe(2);
  expect(requested.map(call => call[2].day)).toEqual(['today', 'previous']);
  expect(children.filter(call => call[1] === 'accepted')).toHaveLength(1);
  expect(children.find(call => call[1] === 'terminal')?.[2]).toMatchObject({
    code: 'VERSION_CONFLICT',
    result: 'conflict'
  });
  expect(JSON.stringify([...lifecycle, ...children])).not.toMatch(/125\.00|7\.35|placement|Social/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  const retainedSpend = await selectPreviousSpend(yesterday);
  expect((retainedSpend as HTMLInputElement).value).toBe('7,35');
  expect(retainedSpend.closest('[data-finance-state]')?.getAttribute('data-finance-state')).toBe(
    'dirty'
  );
});

it('saves both dated fields before archive preflight and proves retained canonical display', async () => {
  configure();
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const yesterday = previous.toISOString().slice(0, 10);
  const confirmed: FinanceSnapshot['fields'] = [];
  let archived = false;
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => ({
    ...snapshot(archived, false),
    from,
    to,
    fields: [...confirmed]
  }));
  vi.mocked(teamFinanceApi.set).mockImplementation(
    async (_team, agent, entryDate, metric, value) => {
      const field: FinanceSnapshot['fields'][number] = {
        agentRowId: agent,
        date: entryDate,
        metric,
        value,
        currency: 'USD',
        version: '1',
        placementId: 'placement',
        updatedAt: timestamp,
        updatedBy: null
      };
      confirmed.push(field);
      return { requestId: crypto.randomUUID(), fields: [field], undoReference: null };
    }
  );
  const balance = await screen.findByRole('textbox', {
    name: new RegExp(`${date} · Balance · USD$`)
  });
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(balance, { target: { value: '125' } });
  fireEvent.change(await selectPreviousSpend(yesterday), { target: { value: '7,35' } });
  await returnTodayBalance();
  const originalPreflight = vi.mocked(accountsWorkspaceApi.preflight).getMockImplementation();
  vi.mocked(accountsWorkspaceApi.preflight).mockImplementation(async (...args) => {
    expect(confirmed.map(field => field.date).sort()).toEqual([yesterday, date].sort());
    if (!originalPreflight) throw new Error('Missing configured preflight');
    return originalPreflight(...args);
  });
  const originalArchive = vi.mocked(accountsWorkspaceApi.archive).getMockImplementation();
  vi.mocked(accountsWorkspaceApi.archive).mockImplementation(async (...args) => {
    archived = true;
    if (!originalArchive) throw new Error('Missing configured archive');
    return originalArchive(...args);
  });
  await openArchiveDialog();
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Save and archive' })
  );
  await waitFor(() => expect(applied()).toHaveLength(1));
  expect(teamFinanceApi.set).toHaveBeenCalledTimes(2);
  expect(accountsWorkspaceApi.archive).toHaveBeenCalledTimes(1);
  expect(applied()[0][2].result).toBe('retained_period_data');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.filter(([action, stage]) => action === 'finance_edit' && stage === 'accepted')
  ).toHaveLength(2);
});

it('shows a rejected preflight, releases the input freeze and retries a fresh preflight', async () => {
  configure();
  // configure uses mockResolvedValue, so keep its canonical typed value explicitly.
  vi.mocked(accountsWorkspaceApi.preflight).mockRejectedValueOnce(
    new TeamApiError('ACCOUNT_LIFECYCLE_CONFLICT', false)
  );
  await startArchive();
  const dialog = screen.getByRole('dialog');
  await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy());
  expect(accountsWorkspaceApi.archive).not.toHaveBeenCalled();
  expect(applied()).toHaveLength(0);
  const balance = screen.getByRole('textbox', { name: new RegExp(`${date} · Balance · USD$`) });
  await waitFor(() => expect((balance as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(within(dialog).getByRole('button', { name: /^Archive$/ }));
  await waitFor(() => expect(accountsWorkspaceApi.archive).toHaveBeenCalledTimes(1));
  expect(accountsWorkspaceApi.preflight).toHaveBeenCalledTimes(2);
  // No matching finance lifecycle supplied in this scenario, therefore no false applied.
  expect(applied()).toHaveLength(0);
});

it('uses the accepted archive receipt for Undo and rereads both canonical sources', async () => {
  configure();
  await startArchive();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const callsBefore = vi.mocked(teamFinanceApi.snapshot).mock.calls.length;
  vi.mocked(accountsWorkspaceApi.archive).mockImplementationOnce(
    async (_team, kind, id, archived, version, token) => {
      expect({ kind, id, archived, version, token }).toEqual({
        kind: 'social',
        id: 'social',
        archived: false,
        version: '2',
        token: 'after'
      });
      vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(overview(false));
      vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(snapshot(false, false));
      return {
        entityId: id,
        entityKind: kind,
        lifecycleVersion: '3',
        token: 'restored',
        archivedAt: null,
        effectiveArchived: false,
        childCount: 1,
        requestId: crypto.randomUUID(),
        operationId: crypto.randomUUID()
      };
    }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(accountsWorkspaceApi.archive).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(accountsWorkspaceApi.overview).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(vi.mocked(teamFinanceApi.snapshot).mock.calls.length).toBeGreaterThan(callsBefore)
  );
});

it('does not execute an archived toast Undo after edit permission is revoked', async () => {
  const view = configure();
  await startArchive();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  permissions.edit = false;
  view.rerender(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(accountsWorkspaceApi.archive).toHaveBeenCalledTimes(1);
});

it('preserves the archived canonical state when Undo conflicts and surfaces its failure', async () => {
  configure();
  await startArchive();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  vi.mocked(accountsWorkspaceApi.archive).mockRejectedValueOnce(
    new TeamApiError('ACCOUNT_LIFECYCLE_CONFLICT', false)
  );
  const overviewCalls = vi.mocked(accountsWorkspaceApi.overview).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(accountsWorkspaceApi.archive).toHaveBeenCalledTimes(2));
  await screen.findByText(
    'This account changed in another session. Review the current data and try again.'
  );
  expect(accountsWorkspaceApi.overview).toHaveBeenCalledTimes(overviewCalls);
});

it('discards only the archived social drafts and preserves a different social draft', async () => {
  let archived = false;
  const initial = overview(false);
  const original = initial.accounts[0];
  const other = {
    ...original,
    id: 'other',
    name: 'Other',
    agents: [{ ...original.agents[0], id: 'other-rk', accountId: 'other', agentId: '456' }]
  };
  vi.mocked(accountsWorkspaceApi.overview).mockImplementation(async () => ({
    ...overview(archived),
    accounts: [...overview(archived).accounts, other],
    agentOrderVersions: { social: '0', other: '0' }
  }));
  vi.mocked(teamFinanceApi.snapshot).mockImplementation(async (_team, from, to) => {
    const base = snapshot(archived, false);
    if (!base.lifecycle) throw new Error('Lifecycle fixture required');
    return {
      ...base,
      from,
      to,
      accounts: [...base.accounts, { id: 'other', name: 'Other' }],
      agents: [...base.agents, { id: 'other-rk', agentId: '456' }],
      placements: [
        ...base.placements,
        { ...base.placements[0], id: 'other-placement', accountId: 'other', agentRowId: 'other-rk' }
      ],
      lifecycle: {
        ...base.lifecycle,
        accounts: [
          ...base.lifecycle.accounts,
          { ...base.lifecycle.accounts[0], id: 'other', archivedAt: null, version: '1' }
        ],
        agents: [
          ...base.lifecycle.agents,
          { ...base.lifecycle.agents[0], id: 'other-rk', accountId: 'other' }
        ]
      }
    };
  });
  vi.mocked(accountsWorkspaceApi.preflight).mockResolvedValue({
    entityId: 'social',
    entityKind: 'social',
    lifecycleVersion: '1',
    token: 'before',
    archivedAt: null,
    effectiveArchived: false,
    childCount: 1
  });
  vi.mocked(accountsWorkspaceApi.archive).mockImplementation(async () => {
    archived = true;
    return {
      entityId: 'social',
      entityKind: 'social',
      lifecycleVersion: '2',
      token: 'after',
      archivedAt: timestamp,
      effectiveArchived: true,
      childCount: 1,
      requestId: crypto.randomUUID(),
      operationId: crypto.randomUUID()
    };
  });
  const view = render(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  const social = await waitFor(() => {
    const element = view.container.querySelector<HTMLElement>('[data-account-id="social"]');
    if (!element) throw new Error('Missing social');
    return element;
  });
  const otherSocial = view.container.querySelector<HTMLElement>('[data-account-id="other"]');
  if (!otherSocial) throw new Error('Missing unrelated social');
  const target = within(social).getByRole('textbox', {
    name: new RegExp(`${date} · Balance · USD$`)
  });
  const unrelated = within(otherSocial).getByRole('textbox', {
    name: new RegExp(`${date} · Balance · USD$`)
  });
  await waitFor(() => expect((target as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(target, { target: { value: '111' } });
  fireEvent.change(unrelated, { target: { value: '222' } });
  await openArchiveDialog();
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect((target as HTMLInputElement).value).toBe('111');
  expect((unrelated as HTMLInputElement).value).toBe('222');
  expect(accountsWorkspaceApi.preflight).not.toHaveBeenCalled();
  await openArchiveDialog();
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard drafts and archive' })
  );
  await waitFor(() => expect(applied()).toHaveLength(1));
  expect(applied()[0][2].result).toBe('hidden_no_period_data');
  expect(view.container.querySelector('[data-account-id="social"]')).toBeNull();
  const remaining = view.container.querySelector<HTMLElement>('[data-account-id="other"]');
  if (!remaining) throw new Error('Unrelated social disappeared');
  const retained = within(remaining).getByRole('textbox', {
    name: new RegExp(`${date} · Balance · USD$`)
  });
  expect((retained as HTMLInputElement).value).toBe('222');
  expect(retained.closest('[data-finance-state]')?.getAttribute('data-finance-state')).toBe(
    'dirty'
  );
  expect(teamFinanceApi.set).not.toHaveBeenCalled();
});
