// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { financeToday, type FinanceSnapshot } from '@video-compressor/shared';
import { AccountSpace } from '../apps/web/src/team/accounts/AccountSpace';
import { ToastProvider } from '../apps/web/src/components/toast';
import { accountsWorkspaceApi } from '../apps/web/src/api/team-accounts-workspace';
import { teamFinanceApi } from '../apps/web/src/api/team-finance';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
import { KeyboardSensor, type Draggable, type KeyboardSensorOptions } from '@dnd-kit/dom';
import {
  AccountReorderProvider,
  useAccountReorderItem
} from '../apps/web/src/team/accounts/AccountReorderProvider';

type AdapterEvent = {
  canceled?: boolean;
  operation: {
    source: { id: string; index: number; initialIndex: number; sortable: boolean } | null;
    target: { id: string } | null;
  };
};
const drag = vi.hoisted(() => ({
  canEdit: true,
  revision: 0,
  before: null as ((event: AdapterEvent) => void) | null,
  start: null as ((event: AdapterEvent) => void) | null,
  end: null as ((event: AdapterEvent) => void) | null,
  source: null as AdapterEvent['operation']['source'],
  elements: new Map<string, Element>(),
  feedback: new Map<string, Element>(),
  sensors: [] as Array<{ plugin: unknown; options?: unknown }>,
  stop: vi.fn()
}));
// This is the dnd-kit event boundary, not a replacement gesture implementation.
// It drives the REAL AccountSpace/provider/groups/lifted finance drafts. Physical
// 500ms capture, collision geometry and pointer smoothing remain browser evidence.
vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({
    children,
    onBeforeDragStart,
    sensors,
    onDragStart,
    onDragEnd
  }: {
    children: React.ReactNode;
    onBeforeDragStart: (event: AdapterEvent) => void;
    sensors: Array<{ plugin: unknown; options?: unknown }>;
    onDragStart: (event: AdapterEvent) => void;
    onDragEnd: (event: AdapterEvent) => void;
  }) => {
    drag.before = onBeforeDragStart;
    drag.sensors = sensors;
    drag.start = onDragStart;
    drag.end = onDragEnd;
    return children;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useDragDropManager: () => ({ actions: { stop: drag.stop } })
}));
vi.mock('@dnd-kit/react/sortable', () => ({
  useSortable: ({ id }: { id: string }) => ({
    ref: (element: Element | null) => {
      if (element) drag.elements.set(id, element);
    },
    sourceRef: (element: Element | null) => {
      if (element) drag.feedback.set(id, element);
    },
    handleRef: vi.fn()
  }),
  isSortable: (source: AdapterEvent['operation']['source']) => source?.sortable === true
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => drag.canEdit, revision: drag.revision })
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
  vi.restoreAllMocks();
  vi.resetAllMocks();
  drag.canEdit = true;
  drag.revision = 0;
  drag.start = null;
  drag.before = null;
  drag.end = null;
  drag.source = null;
  drag.elements.clear();
  drag.feedback.clear();
  drag.sensors = [];
});

it.each([
  { name: 'locally disabled or archived item', localDisabled: true, registered: true },
  { name: 'item removed from the current order', localDisabled: false, registered: false }
])('rejects a direct keyboard move for a $name', ({ localDisabled, registered }) => {
  const first = { id: 'first', kind: 'social' as const, parent: null, label: 'First', index: 0 };
  const second = { ...first, id: 'second', label: 'Second', index: 1 };
  const item = registered ? first : { ...first, id: 'removed' };
  const onReorder = vi.fn().mockResolvedValue(undefined);
  function Shortcut() {
    const reorder = useAccountReorderItem(item, localDisabled);
    return <button onClick={() => reorder.move(1)}>Move directly</button>;
  }
  render(
    <AccountReorderProvider items={[first, second]} signature="current" onReorder={onReorder}>
      <Shortcut />
    </AccountReorderProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Move directly' }));
  expect(onReorder).not.toHaveBeenCalled();
  expect(emitAccountSignal).not.toHaveBeenCalled();
});

function fixture(): Awaited<ReturnType<typeof accountsWorkspaceApi.overview>> {
  return {
    schemaVersion: 1,
    coverage: 'complete',
    socialOrderVersion: '0',
    agentOrderVersions: { one: '0', two: '0', three: '0' },
    accounts: ['one', 'two', 'three'].map((id, sortRank) => ({
      id,
      teamId: 'team',
      twoFactorSeed: null,
      name: id,
      sortRank,
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
function start() {
  const initial = fixture();
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
    fields: [],
    accounts: initial.accounts.map(a => ({ id: a.id, name: a.name })),
    agents: initial.accounts.flatMap(a => a.agents.map(rk => ({ id: rk.id, agentId: rk.agentId }))),
    placements: initial.accounts.flatMap(a =>
      a.agents.map(rk => ({
        id: `p-${rk.id}`,
        agentRowId: rk.id,
        accountId: a.id,
        startsOn: '2026-01-01',
        endsOn: null,
        version: '0'
      }))
    )
  };
  vi.mocked(teamFinanceApi.snapshot).mockResolvedValue(snapshot);
  drag.stop.mockImplementation(async () =>
    drag.end?.({
      canceled: true,
      operation: { source: drag.source, target: null }
    })
  );
  localStorage.setItem('soty.team-accounts.collapsed:team', JSON.stringify(['two']));
  const ui = () => (
    <ToastProvider>
      <AccountSpace teamId="team" />
    </ToastProvider>
  );
  const view = render(ui());
  return { ...view, initial, ui, date };
}
function capture(id: string) {
  drag.source = { id, index: 0, initialIndex: 0, sortable: true };
  act(() => drag.start?.({ operation: { source: drag.source, target: null } }));
}
function finish(change: Partial<AdapterEvent> = {}, index = 1) {
  act(() =>
    drag.end?.({
      operation: {
        source: drag.source ? { ...drag.source, index } : null,
        target: { id: 'two' }
      },
      ...change
    })
  );
}
function folds(container: HTMLElement) {
  return [...container.querySelectorAll('.team-account[data-account-id]')].map(el => ({
    id: el.getAttribute('data-account-id'),
    collapsed: el.classList.contains('is-collapsed')
  }));
}

it.each(['cancel', 'outside', 'nonsortable', 'noop', 'missing-anchor'])(
  'restores lifted selected-day balance and spend drafts, heading focus and mixed folds after social %s',
  async exit => {
    const view = start();
    const heading = await screen.findByRole('button', { name: 'Collapse one' });
    const today = screen.getByRole('textbox', {
      name: `one · 1926 · ${view.date} · Balance · USD`
    });
    fireEvent.change(today, { target: { value: '123.45' } });
    // Both selected-day values must survive the temporary social fold;
    // their shared draft owner remains mounted while the row controls unmount.
    const spendName = `one · 1926 · ${view.date} · Spend · Today · USD`;
    const spend = screen.getByRole('textbox', { name: spendName });
    fireEvent.change(spend, { target: { value: '7.25' } });
    heading.focus();
    const before = folds(view.container);
    capture('one');
    expect(folds(view.container).every(group => group.collapsed)).toBe(true);
    expect(
      screen.queryByRole('textbox', { name: `one · 1926 · ${view.date} · Balance · USD` })
    ).toBeNull();
    // Keep the release-click inside the documented 350ms suppression window:
    // DOM accessibility queries can otherwise consume that wall-clock budget.
    const releaseClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    if (exit === 'cancel') finish({ canceled: true });
    else if (exit === 'outside') finish({ operation: { source: drag.source, target: null } });
    else if (exit === 'nonsortable')
      finish({
        operation: {
          source: { ...drag.source!, sortable: false },
          target: { id: 'two' }
        }
      });
    else finish({}, exit === 'noop' ? 0 : 99);
    expect(folds(view.container)).toEqual(before);
    expect(document.activeElement).toBe(heading);
    expect(
      screen.getByRole('textbox', { name: `one · 1926 · ${view.date} · Balance · USD` })
    ).toHaveProperty('value', '123,45');
    expect(screen.getByRole('textbox', { name: spendName })).toHaveProperty('value', '7,25');
    expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
    expect(accountsWorkspaceApi.color).not.toHaveBeenCalled();
    expect(localStorage.getItem('soty.team-accounts.collapsed:team')).toBe(JSON.stringify(['two']));
    // A captured header surface receives the release click. The explicit fold
    // button is excluded from capture and must retain its ordinary click action.
    const capturedSurface = heading.closest('.team-account-head');
    if (!capturedSurface) throw new Error('Missing captured social header');
    fireEvent.click(capturedSurface);
    releaseClock.mockRestore();
    expect(folds(view.container)).toEqual(before);
  }
);

it.each(['permission', 'membership', 'deleted-heading'])(
  'cancels a live drag on %s changes without saving an outdated scope',
  async change => {
    const view = start();
    await screen.findByRole('button', { name: 'Collapse one' });
    capture('one');
    if (change === 'permission') drag.canEdit = false;
    else {
      const next = fixture();
      next.socialOrderVersion = '1';
      if (change === 'membership') next.accounts[0]!.agents.pop();
      else next.accounts = next.accounts.filter(row => row.id !== 'one');
      vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(next);
      drag.revision++;
    }
    view.rerender(view.ui());
    await waitFor(() => expect(drag.stop).toHaveBeenCalledWith({ canceled: true }));
    await waitFor(() =>
      expect(screen.queryByText('one', { selector: '.account-drag-overlay' })).toBeNull()
    );
    expect(folds(view.container).filter(row => row.id !== 'one')).toEqual([
      { id: 'two', collapsed: true },
      { id: 'three', collapsed: false }
    ]);
    expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
    expect(emitAccountSignal).toHaveBeenCalledWith(
      'reorder',
      'terminal',
      expect.objectContaining({ result: 'cancelled' })
    );
  }
);

it('restores folds before a social save settles and adopts canonical order after a lost response', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  let reject!: (cause: Error) => void;
  vi.mocked(accountsWorkspaceApi.reorder).mockImplementationOnce(
    () =>
      new Promise((_yes, no) => {
        reject = no;
      })
  );
  const canonical = fixture();
  canonical.socialOrderVersion = '1';
  canonical.accounts[0]!.sortRank = 1;
  canonical.accounts[1]!.sortRank = 0;
  vi.mocked(accountsWorkspaceApi.overview).mockResolvedValue(canonical);
  capture('one');
  finish();
  expect(folds(view.container).map(group => group.collapsed)).toEqual([false, true, false]);
  await waitFor(() => expect(accountsWorkspaceApi.reorder).toHaveBeenCalledTimes(1));
  await act(async () => reject(new TypeError('Failed to fetch')));
  await waitFor(() =>
    expect(folds(view.container).map(group => group.id)).toEqual(['two', 'one', 'three'])
  );
  expect(folds(view.container).map(group => group.collapsed)).toEqual([true, false, false]);
  expect(accountsWorkspaceApi.reorder).toHaveBeenCalledTimes(1);
  expect(
    vi
      .mocked(emitAccountSignal)
      .mock.calls.some(([kind, phase]) => kind === 'reorder' && phase === 'applied')
  ).toBe(false);
});

it('keeps the complete captured RK and its live finance draft in the original table context', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const balanceName = `one · 1926 · ${view.date} · Balance · USD`;
  const balance = screen.getByRole('textbox', { name: balanceName });
  fireEvent.change(balance, { target: { value: '123.45' } });
  const row = balance.closest<HTMLElement>('.team-agent-row');
  if (!row?.dataset.reorderId) throw new Error('Missing sortable RK row');
  const originalParent = row.parentElement;
  const originalClass = row.className;
  const originalContent = row.textContent;
  const originalInlineStyle = row.getAttribute('style');
  const beforeFolds = folds(view.container);

  capture(row.dataset.reorderId);

  // The library must receive the original grid row, including controls and
  // inherited unified-table scope. A label-only overlay cannot satisfy this.
  expect(screen.getByRole('textbox', { name: balanceName })).toBe(balance);
  expect(balance.closest('.team-agent-row')).toBe(row);
  expect(row.parentElement).toBe(originalParent);
  expect(row.closest('.team-account-space.is-unified')).not.toBeNull();
  expect(row.className).toBe(originalClass);
  expect(row.textContent).toBe(originalContent);
  expect(row.getAttribute('style')).toBe(originalInlineStyle);
  expect(balance).toHaveProperty('value', '123,45');
  expect(folds(view.container)).toEqual(beforeFolds);
  expect(view.container.querySelector('.account-drag-overlay')).toBeNull();
  expect(view.container.querySelector('[data-dnd-overlay]')).toBeNull();

  finish({ canceled: true });
  expect(screen.getByRole('textbox', { name: balanceName })).toBe(balance);
  expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
});

it('sorts complete social siblings as the feedback source, preserving ownership after movement and cancellation', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const one = drag.elements.get('one');
  const two = drag.elements.get('two');
  expect(one).toBe(view.container.querySelector('[data-account-id="one"]'));
  expect(two).toBe(view.container.querySelector('[data-account-id="two"]'));
  expect(drag.feedback.get('one')).toBeUndefined();
  expect(one?.parentElement).toBe(two?.parentElement);
  if (!one || !two) throw new Error('Missing registered social wrappers');
  // OptimisticSortingPlugin inserts the registered sortable element beside its
  // target. Registering a nested header instead tears it out of its own group.
  two.insertAdjacentElement('afterend', one);
  one.insertAdjacentElement('beforebegin', two);
  two.insertAdjacentElement('beforebegin', one);
  for (const group of view.container.querySelectorAll('.team-account[data-account-id]')) {
    const heads = group.querySelectorAll(':scope > .team-account-head');
    expect(heads).toHaveLength(1);
    expect(heads[0]?.getAttribute('data-reorder-id')).toBe(group.getAttribute('data-account-id'));
  }
});

it('folds the picked social before feedback measurement, then folds peers only after capture and restores their exact state', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const before = folds(view.container);
  const event: AdapterEvent = {
    operation: {
      source: { id: 'one', index: 0, initialIndex: 0, sortable: true },
      target: null
    }
  };
  act(() => drag.before?.(event));
  expect(folds(view.container).map(group => group.collapsed)).toEqual([true, true, false]);
  expect(drag.elements.get('one')).toBe(view.container.querySelector('[data-account-id="one"]'));
  capture('one');
  expect(folds(view.container).every(group => group.collapsed)).toBe(true);
  finish({ canceled: true });
  expect(folds(view.container)).toEqual(before);
  expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
});

it('prepares the compact keyboard source before the library scrolls and measures its activation center', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const group = drag.elements.get('one');
  const handle = group?.querySelector<HTMLElement>('[data-reorder-keyboard]');
  if (!group || !handle) throw new Error('Missing keyboard social source');
  const options = drag.sensors.find(sensor => sensor.plugin === KeyboardSensor)
    ?.options as KeyboardSensorOptions;
  let prevented: boolean | undefined;
  let atMeasurement: ReturnType<typeof folds> | undefined;
  handle.addEventListener(
    'keydown',
    event => {
      prevented = options.preventActivation?.(event, { id: 'one', element: group } as Draggable);
      // KeyboardSensor.handleStart performs scrollIntoView and center measurement
      // immediately AFTER this real configured guard, before beforedragstart.
      atMeasurement = folds(view.container);
    },
    { once: true }
  );
  fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
  expect(prevented).toBe(false);
  expect(atMeasurement?.map(row => row.collapsed)).toEqual([true, true, false]);
  capture('one');
  finish({ canceled: true });
  expect(folds(view.container).map(row => row.collapsed)).toEqual([false, true, false]);
  expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
});

it('reveals search results after a preserved daily canvas was scrolled to the bottom', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const table = view.container.querySelector<HTMLElement>('.team-accounts-table');
  const list = view.container.querySelector<HTMLElement>('.team-accounts-list');
  const surface = view.container.querySelector<HTMLElement>('.team-account-space.is-unified');
  if (!table || !list || !surface) throw new Error('Missing daily table canvas');
  list.style.minHeight = '673px';
  surface.style.minHeight = '900px';
  table.scrollTop = 371;
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search accounts' }), {
    target: { value: 'one' }
  });
  await waitFor(() => expect(table.scrollTop).toBe(0));
  expect(list.style.minHeight).toBe('');
  expect(surface.style.minHeight).toBe('');
  expect(view.container.querySelectorAll('.team-agent-row')).toHaveLength(2);
});

it('anchors a middle social to its flow placeholder while peers fold and restores the expanded viewport on cancel', async () => {
  const view = start();
  await screen.findByRole('button', { name: 'Collapse one' });
  const table = view.container.querySelector<HTMLElement>('.team-accounts-table');
  const group = drag.elements.get('three');
  const heading = group?.querySelector<HTMLElement>('.team-account-head');
  if (!table || !group || !heading) throw new Error('Missing middle social');
  const rectangle = (top: number) => ({
    top,
    left: 0,
    width: 900,
    height: 54,
    bottom: top + 54,
    right: 900,
    x: 0,
    y: top,
    toJSON: () => ({})
  });
  vi.spyOn(table, 'getBoundingClientRect').mockImplementation(() => rectangle(100));
  // Feedback keeps the original heading fixed under the pointer. Its hidden
  // proxy occupies the changing document flow when the preceding bodies fold.
  vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(() => rectangle(400));
  const proxy = group.cloneNode(true) as HTMLElement;
  proxy.setAttribute('data-dnd-placeholder', 'hidden');
  group.insertAdjacentElement('afterend', proxy);
  const proxyHeading = proxy.querySelector<HTMLElement>('.team-account-head');
  if (!proxyHeading) throw new Error('Missing feedback flow proxy');
  vi.spyOn(proxyHeading, 'getBoundingClientRect').mockImplementation(() => {
    const collapsed = view.container
      .querySelector('[data-account-id="one"]')
      ?.classList.contains('is-collapsed');
    return rectangle((collapsed ? 600 : 1400) - table.scrollTop);
  });
  const list = table.querySelector<HTMLElement>('.team-accounts-list');
  if (!list) throw new Error('Missing retained list canvas');
  list.style.minHeight = '71900px';
  Object.defineProperty(table, 'clientHeight', { configurable: true, value: 333 });
  table.scrollTop = 1000;
  capture('three');
  expect(list.style.minHeight).toBe('333px');
  expect(table.scrollTop).toBe(200);
  expect(proxyHeading.getBoundingClientRect().top).toBe(400);
  finish({ canceled: true });
  expect(table.scrollTop).toBe(1000);
  expect(list.style.minHeight).toBe('71900px');
  expect(accountsWorkspaceApi.reorder).not.toHaveBeenCalled();
  proxy.remove();
});
