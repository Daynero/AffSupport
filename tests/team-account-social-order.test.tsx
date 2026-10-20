// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamApiError } from '../apps/web/src/api/team';
import { financeToday, type FinanceSnapshot } from '@video-compressor/shared';
import { AccountSpace } from '../apps/web/src/team/accounts/AccountSpace';
import { ToastProvider } from '../apps/web/src/components/toast';
import { accountsWorkspaceApi } from '../apps/web/src/api/team-accounts-workspace';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
const scope = vi.hoisted(() => ({ canEdit: true, revision: 0 }));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => scope.canEdit, revision: scope.revision })
}));
vi.mock('../apps/web/src/team/labels/useTaskLabels', () => ({
  useTaskLabels: () => ({ labels: [] })
}));
vi.mock('../apps/web/src/api/team-finance', () => ({ teamFinanceApi: { snapshot: vi.fn() } }));
vi.mock('../apps/web/src/api/team-accounts-workspace', () => ({
  accountsWorkspaceApi: { overview: vi.fn(), reorder: vi.fn(), color: vi.fn() }
}));
vi.mock('../apps/web/src/team/accounts/analytics', () => ({
  accountFlowId: () => crypto.randomUUID(),
  emitAccountSignal: vi.fn()
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  scope.canEdit = true;
  scope.revision = 0;
});
function fixture(): Awaited<ReturnType<typeof accountsWorkspaceApi.overview>> {
  return {
    schemaVersion: 1,
    coverage: 'complete',
    socialOrderVersion: '0',
    agentOrderVersions: { one: '0', two: '0', three: '0' },
    accounts: ['one', 'two', 'three'].map((id, rank) => ({
      id,
      teamId: 'team',
      name: id,
      twoFactorSeed: null,
      sortRank: rank,
      archivedAt: null,
      lifecycleVersion: '0',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      agents: ['a', 'b'].map((suffix, index) => ({
        id: `${id}-${suffix}`,
        accountId: id,
        teamId: 'team',
        agentId: `${index + 1}926`,
        balance: null,
        topup: null,
        runs: [],
        labels: [],
        taskCount: 0,
        sortRank: index,
        nameColor: 0,
        nameColorVersion: '0',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }))
    }))
  };
}
function start(initial = fixture()) {
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(initial);
  const date = financeToday();
  const snapshot: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from: date,
    to: date,
    currency: 'USD',
    generatedAt: 'now',
    accounts: initial.accounts.map(row => ({ id: row.id, name: row.name })),
    agents: initial.accounts.flatMap(row =>
      row.agents.map(agent => ({ id: agent.id, agentId: agent.agentId }))
    ),
    fields: [],
    placements: initial.accounts.flatMap(row =>
      row.agents.map(agent => ({
        id: `p-${agent.id}`,
        agentRowId: agent.id,
        accountId: row.id,
        startsOn: '2026-01-01',
        endsOn: null,
        version: '0'
      }))
    )
  };
  vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(snapshot);
  let version = 0;
  vi.mocked(accountsWorkspaceApi.color).mockImplementation(async (_team, id, color) => ({
    agentId: id,
    color,
    version: String(++version),
    requestId: crypto.randomUUID(),
    operationId: crypto.randomUUID()
  }));
  localStorage.setItem('soty.team-accounts.collapsed:team', JSON.stringify(['two']));
  const view = render(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  return { ...view, initial };
}
function foldState(container: HTMLElement) {
  return [...container.querySelectorAll('.team-account[data-account-id]')].map(element => ({
    id: element.getAttribute('data-account-id'),
    collapsed: element.classList.contains('is-collapsed')
  }));
}
// JSDOM lacks document.getAnimations and layout geometry required by the real
// dnd-kit KeyboardSensor. We intentionally do not mock its manager, collision
// geometry or callbacks. Long-press capture, transient folding, Escape during a
// live drag and release-click suppression require the real-browser CUA checks.
it('preserves mixed fold state and scopes the accessible RK move to its own social', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const before = foldState(view.container);
  expect(before.map(row => row.collapsed)).toEqual([false, true, false]);
  vi.mocked(accountsWorkspaceApi.reorder).mockResolvedValue({
    operationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    version: '1',
    order: ['one-b', 'one-a']
  });
  const handle = view.container.querySelector<HTMLButtonElement>(
    '[data-agent-row-id="one-a"] [data-reorder-keyboard]'
  );
  if (!handle) throw new Error('Missing accessible RK move control');
  fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true });
  await waitFor(() => expect(accountsWorkspaceApi.reorder).toHaveBeenCalledTimes(1));
  expect(accountsWorkspaceApi.reorder).toHaveBeenCalledWith(
    'team',
    'agents',
    'one',
    'one-a',
    'one-b',
    'after',
    '0',
    expect.any(String)
  );
  expect(foldState(view.container)).toEqual(before);
  expect(localStorage.getItem('soty.team-accounts.collapsed:team')).toBe(JSON.stringify(['two']));
});
it('moves a social from its More trigger without visible grips or changing fold preferences', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const before = foldState(view.container);
  vi.mocked(accountsWorkspaceApi.reorder).mockResolvedValue({
    operationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    version: '1',
    order: ['two', 'one', 'three']
  });
  const more = view.container.querySelector<HTMLButtonElement>(
    '[data-account-id="one"] .team-account-head [data-reorder-keyboard]'
  );
  if (!more) throw new Error('Missing social More ordering trigger');
  expect(view.container.querySelector('.lucide-grip-vertical')).toBeNull();
  fireEvent.keyDown(more, { key: 'ArrowDown', altKey: true });
  await waitFor(() =>
    expect(accountsWorkspaceApi.reorder).toHaveBeenCalledWith(
      'team',
      'socials',
      null,
      'one',
      'two',
      'after',
      '0',
      expect.any(String)
    )
  );
  expect(Object.fromEntries(foldState(view.container).map(row => [row.id, row.collapsed]))).toEqual(
    Object.fromEntries(before.map(row => [row.id, row.collapsed]))
  );
  expect(localStorage.getItem('soty.team-accounts.collapsed:team')).toBe(JSON.stringify(['two']));
});
it('cycles and persists seven decorations plus none through the actual RK name control', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const row = view.container.querySelector<HTMLElement>('[data-agent-row-id="one-a"]');
  const name = row?.querySelector<HTMLButtonElement>('[data-name-color]');
  if (!row || !name) throw new Error('Missing RK decoration control');
  const expected = ['green', 'yellow', 'red', 'blue', 'purple', 'pink', 'orange', 'none'];
  for (const [index, color] of expected.entries()) {
    await act(async () => {
      fireEvent.click(name);
    });
    expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(index + 1);
    expect(row.dataset.nameColorValue).toBe(color);
    expect(vi.mocked(accountsWorkspaceApi.color).mock.calls[index].slice(0, 4)).toEqual([
      'team',
      'one-a',
      (index + 1) % 8,
      String(index)
    ]);
  }
  expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
  expect(foldState(view.container).map(group => group.collapsed)).toEqual([false, true, false]);
});
it('removes sorting controls after permission is revoked while preserving private decoration', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  expect(view.container.querySelector('[data-reorder-keyboard]')).toBeTruthy();
  scope.canEdit = false;
  view.rerender(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  await waitFor(() => expect(view.container.querySelector('[data-reorder-keyboard]')).toBeNull());
  const name = view.container.querySelector<HTMLButtonElement>(
    '[data-agent-row-id="one-a"] [data-name-color]'
  );
  if (!name) throw new Error('Viewer must retain their private decoration control');
  fireEvent.click(name);
  await waitFor(() => expect(accountsWorkspaceApi.color).toHaveBeenCalledTimes(1));
  expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
});
it('uses refreshed membership for accessible moves and preserves fold preferences', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const changed = fixture();
  changed.accounts[0].agents = changed.accounts[0].agents.filter(agent => agent.id !== 'one-b');
  changed.agentOrderVersions.one = '1';
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(changed);
  scope.revision += 1;
  view.rerender(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-agent-row-id="one-b"]')).toBeNull()
  );
  const row = view.container.querySelector<HTMLElement>('[data-agent-row-id="one-a"]');
  expect(row).toBeTruthy();
  // The sole remaining sibling has no valid destination; its More menu must
  // stop advertising ordering shortcuts after the membership refresh.
  expect(row?.querySelector('[data-reorder-keyboard]')).toBeNull();
  const more = row?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  if (!more) throw new Error('Missing RK More menu');
  fireEvent.keyDown(more, { key: 'ArrowDown', altKey: true });
  expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
  expect(foldState(view.container).map(group => group.collapsed)).toEqual([false, true, false]);
});

it('confirms a saved decoration only after the folded RK name is presented again', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  let resolveColor!: (value: Awaited<ReturnType<typeof accountsWorkspaceApi.color>>) => void;
  vi.mocked(accountsWorkspaceApi.color).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveColor = resolve;
      })
  );
  const name = view.container.querySelector<HTMLButtonElement>(
    '[data-agent-row-id="one-a"] [data-name-color]'
  );
  if (!name) throw new Error('Missing RK decoration control');
  fireEvent.click(name);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse one' }));
  await act(async () => {
    resolveColor({ agentId: 'one-a', color: 1, version: '1', requestId: 'req', operationId: 'op' });
  });
  const phases = () =>
    vi
      .mocked(emitAccountSignal)
      .mock.calls.filter(call => call[0] === 'decoration')
      .map(call => call[1]);
  expect(phases()).toContain('accepted');
  expect(phases()).not.toContain('applied');
  fireEvent.click(screen.getByRole('button', { name: 'Expand one' }));
  await waitFor(() => expect(phases().filter(phase => phase === 'applied')).toHaveLength(1));
  const decorationCalls = vi
    .mocked(emitAccountSignal)
    .mock.calls.filter(call => call[0] === 'decoration');
  const requested = decorationCalls.find(call => call[1] === 'requested')?.[2];
  const applied = decorationCalls.find(call => call[1] === 'applied')?.[2];
  expect(applied).toMatchObject({ flowId: requested?.flowId, attemptId: requested?.attemptId });
  expect(requested?.attemptId).toBe(vi.mocked(accountsWorkspaceApi.color).mock.calls[0][4]);
  expect(
    view.container.querySelector<HTMLElement>('[data-agent-row-id="one-a"] [data-name-color]')
      ?.dataset.color
  ).toBe('green');
});

it('recovers a rejected accessible move from canonical overview without claiming applied', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const original = [...view.container.querySelectorAll('[data-agent-row-id]')].map(row =>
    row.getAttribute('data-agent-row-id')
  );
  vi.mocked(accountsWorkspaceApi.reorder).mockRejectedValueOnce(
    new TeamApiError('ACCOUNT_ORDER_CONFLICT', false)
  );
  const handle = view.container.querySelector<HTMLButtonElement>(
    '[data-agent-row-id="one-a"] [data-reorder-keyboard]'
  );
  if (!handle) throw new Error('Missing accessible move');
  const beforeReads = vi.mocked(accountsWorkspaceApi.overview).mock.calls.length;
  fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true });
  await waitFor(() =>
    expect(vi.mocked(accountsWorkspaceApi.overview).mock.calls.length).toBeGreaterThan(beforeReads)
  );
  await waitFor(() =>
    expect(emitAccountSignal).toHaveBeenCalledWith(
      'reorder',
      'terminal',
      expect.objectContaining({ result: 'conflict', code: 'ACCOUNT_ORDER_CONFLICT' })
    )
  );
  expect(
    [...view.container.querySelectorAll('[data-agent-row-id]')].map(row =>
      row.getAttribute('data-agent-row-id')
    )
  ).toEqual(original);
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.some(([action, stage]) => action === 'reorder' && stage === 'applied')
  ).toBe(false);
});
it('does not claim applied when an accepted move cannot reread canonical overview', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  vi.mocked(accountsWorkspaceApi.reorder).mockResolvedValueOnce({
    operationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    version: '1',
    order: ['one-b', 'one-a']
  });
  vi.mocked(accountsWorkspaceApi.overview).mockRejectedValueOnce(
    new TeamApiError('PERMISSION_DENIED', false)
  );
  const handle = view.container.querySelector<HTMLButtonElement>(
    '[data-agent-row-id="one-a"] [data-reorder-keyboard]'
  );
  if (!handle) throw new Error('Missing accessible move');
  fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true });
  await waitFor(() =>
    expect(emitAccountSignal).toHaveBeenCalledWith(
      'overview',
      'terminal',
      expect.objectContaining({ result: 'failed', code: 'PERMISSION_DENIED' })
    )
  );
  expect(emitAccountSignal).toHaveBeenCalledWith(
    'reorder',
    'accepted',
    expect.objectContaining({ outcome: 'success' })
  );
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.some(([action, stage]) => action === 'reorder' && stage === 'applied')
  ).toBe(false);
});

it('keeps linked launch identities after a rename and exposes unmatched historical launches', async () => {
  const initial = fixture();
  initial.launchCoverage = 'partial';
  const launch = {
    id: 'launch-a',
    agentRowId: 'one-a',
    accountId: 'one',
    revisionId: null,
    launchDate: '2026-10-18',
    workStatus: 'draft',
    hasResult: false,
    creativeAlias: 'Alpha',
    method: 'other',
    unmatchedReason: null
  };
  initial.launchSummaries = [
    launch,
    { ...launch, id: 'launch-b', creativeAlias: 'Beta', launchDate: null, workStatus: 'running' },
    {
      ...launch,
      id: 'launch-old',
      agentRowId: null,
      creativeAlias: 'Historical',
      unmatchedReason: 'missing_agent'
    }
  ];
  const view = start(initial);
  const linked = await screen.findByRole('link', { name: 'Alpha · 2026-10-18' }, { timeout: 750 });
  expect(linked.getAttribute('href')).toContain('launch-a');
  expect(screen.getByRole('link', { name: 'Beta · running' }).getAttribute('href')).toContain(
    'launch-b'
  );
  const historical = screen.getByRole('link', { name: /Historical ·/ });
  expect(historical.getAttribute('href')).toContain('launch-old');
  expect(view.container.querySelector('.account-unmatched-launches')).toBeTruthy();
  const renamed = {
    ...initial,
    accounts: initial.accounts.map(account => ({
      ...account,
      agents: account.agents.map(agent =>
        agent.id === 'one-a' ? { ...agent, agentId: 'renamed-926' } : agent
      )
    }))
  };
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(renamed);
  scope.revision += 1;
  view.rerender(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  await waitFor(() => expect(accountsWorkspaceApi.overview).toHaveBeenCalledTimes(2), {
    timeout: 750
  });
  expect(
    view.container
      .querySelector('[data-agent-row-id="one-a"] [data-name-color]')
      ?.getAttribute('title')
  ).toContain('renamed-926');
  expect(screen.getByRole('link', { name: 'Alpha · 2026-10-18' })).toBeTruthy();
  const previousURL = window.location.href;
  try {
    fireEvent.click(linked);
    expect(window.location.href).toContain('launch-a');
    fireEvent.click(historical);
    expect(window.location.href).toContain('launch-old');
  } finally {
    window.history.replaceState({}, '', previousURL);
  }
});

it('recovers the unified overview after an explicit source retry', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  vi.mocked(accountsWorkspaceApi.overview).mockRejectedValue(
    new TeamApiError('DRIVE_UNAVAILABLE', true)
  );
  scope.revision += 1;
  view.rerender(
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  const retry = await screen.findByRole('button', { name: 'Repeat' }, { timeout: 750 });
  const reads = vi.mocked(accountsWorkspaceApi.overview).mock.calls.length;
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(fixture());
  fireEvent.click(retry);
  await waitFor(() => expect(accountsWorkspaceApi.overview).toHaveBeenCalledTimes(reads + 1));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Collapse one' })).toBeTruthy();
});
