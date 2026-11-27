// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchSummary } from '../packages/shared/src/team/launches';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import {
  LaunchesToTaskDialog,
  type LaunchesToTaskClient
} from '../apps/web/src/team/launches/LaunchesToTask';
import { LaunchCard } from '../apps/web/src/team/launches/LaunchCard';
import { TaskLaunches } from '../apps/web/src/team/tasks/TaskLaunches';

const api = vi.hoisted(() => ({
  listTaskLaunchIds: vi.fn(),
  detachTaskLaunch: vi.fn(),
  attachTaskLaunches: vi.fn(),
  list: vi.fn()
}));
vi.mock('../apps/web/src/api/team', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/team')>();
  return {
    ...actual,
    teamApi: {
      ...actual.teamApi,
      listTaskLaunchIds: api.listTaskLaunchIds,
      detachTaskLaunch: api.detachTaskLaunch,
      attachTaskLaunches: api.attachTaskLaunches
    },
    launchApi: { ...actual.launchApi, list: api.list }
  };
});

const TEAM = '76000000-0000-4000-8000-000000000001';

function task(id: string, title: string, updatedAt: string): TeamTaskSummary {
  return { id, title, status: 'todo', updatedAt } as TeamTaskSummary;
}

function launch(id: string, offer: string): LaunchSummary {
  return {
    id,
    version: '1',
    launchDate: '2026-11-20',
    offer,
    social: 'g1',
    accountName: 'Account 1',
    creativeAlias: 'v5',
    method: 'other',
    workStatus: 'todo',
    assigneeId: null,
    budgets: [30],
    generationState: 'succeeded'
  } as LaunchSummary;
}

function client(over: Partial<LaunchesToTaskClient> = {}): LaunchesToTaskClient {
  return {
    listTasks: vi.fn(async () => [
      task('t-old', 'Brief PL', '2026-11-01T10:00:00.000Z'),
      task('t-new', 'Brief TR', '2026-11-20T10:00:00.000Z')
    ]),
    attachTaskLaunches: vi.fn(async ({ launchIds }) => ({
      attached: launchIds,
      alreadyAttached: []
    })),
    createTaskWithLaunches: vi.fn(async ({ title }) => task('t-created', title, '2026-11-27')),
    ...over
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('076 — launches into a task', () => {
  it('puts the selected launches into a chosen task, most recent task first', async () => {
    const user = userEvent.setup();
    const done = vi.fn();
    const close = vi.fn();
    const value = client();
    render(
      <ToastProvider>
        <LaunchesToTaskDialog
          teamId={TEAM}
          launchIds={['l1', 'l2']}
          client={value}
          onDone={done}
          onClose={close}
        />
      </ToastProvider>
    );
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual([
      expect.stringContaining('Brief TR'),
      expect.stringContaining('Brief PL')
    ]);
    await user.click(options[1]!);
    await waitFor(() =>
      expect(value.attachTaskLaunches).toHaveBeenCalledWith({
        teamId: TEAM,
        taskId: 't-old',
        launchIds: ['l1', 'l2']
      })
    );
    expect(done).toHaveBeenCalledWith('t-old');
    expect(close).toHaveBeenCalled();
    expect(await screen.findByText('Added 2 to “Brief PL”')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the task' })).toBeTruthy();
  });

  it('makes a new task of them when the name is new', async () => {
    const user = userEvent.setup();
    const value = client();
    render(
      <ToastProvider>
        <LaunchesToTaskDialog
          teamId={TEAM}
          launchIds={['l1']}
          client={value}
          onDone={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    await screen.findAllByRole('option');
    await user.type(screen.getByRole('combobox'), 'Spring push');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(value.createTaskWithLaunches).toHaveBeenCalledWith({
        teamId: TEAM,
        title: 'Spring push',
        launchIds: ['l1']
      })
    );
    expect(value.attachTaskLaunches).not.toHaveBeenCalled();
  });

  it('shows the task on the launch card and opens it', async () => {
    const openTask = vi.fn();
    const openLaunch = vi.fn();
    render(
      <LaunchCard
        value={launch('l1', 'Offer A')}
        onOpen={openLaunch}
        tasks={[
          { launchId: 'l1', taskId: 't1', title: 'Brief PL', status: 'todo' },
          { launchId: 'l1', taskId: 't2', title: 'Brief TR', status: 'todo' }
        ]}
        onOpenTask={openTask}
      />
    );
    const chip = screen.getByRole('button', { name: 'In the task “Brief PL” — open' });
    expect(chip.textContent).toContain('+1');
    await userEvent.click(chip);
    expect(openTask).toHaveBeenCalledWith('t1');
    expect(openLaunch).not.toHaveBeenCalled();
  });
});

describe('076 — launches in the task', () => {
  it('lists the task’s launches in their order, adds more, and takes one out', async () => {
    const user = userEvent.setup();
    api.listTaskLaunchIds.mockResolvedValue(['l2', 'l1']);
    api.list.mockImplementation(async (_team: string, filter: { ids?: string[] }) =>
      filter.ids
        ? { items: [launch('l1', 'Offer A'), launch('l2', 'Offer B')], nextCursor: null }
        : {
            items: [launch('l1', 'Offer A'), launch('l2', 'Offer B'), launch('l3', 'Offer C')],
            nextCursor: null
          }
    );
    api.attachTaskLaunches.mockResolvedValue({ attached: ['l3'], alreadyAttached: [] });
    api.detachTaskLaunch.mockResolvedValue(undefined);
    render(<TaskLaunches teamId={TEAM} taskId="task" canEdit />);
    const cards = await screen.findAllByText(/Offer [AB]/);
    expect(cards.map(card => card.textContent)).toEqual([
      expect.stringContaining('Offer B'),
      expect.stringContaining('Offer A')
    ]);

    await user.click(screen.getByRole('button', { name: 'Add' }));
    const picker = await screen.findByRole('dialog', { name: 'Launches for the task' });
    const already = await screen.findByRole('option', { name: /Offer A/ });
    expect(already.getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('option', { name: /Offer C/ }));
    await user.click(screen.getByRole('button', { name: 'Add: 1' }));
    await waitFor(() =>
      expect(api.attachTaskLaunches).toHaveBeenCalledWith({
        teamId: TEAM,
        taskId: 'task',
        launchIds: ['l3']
      })
    );
    await waitFor(() => expect(picker.isConnected).toBe(false));

    await user.click(screen.getByRole('button', { name: 'Remove “Offer B” from the task' }));
    expect(api.detachTaskLaunch).toHaveBeenCalledWith(TEAM, 'task', 'l2');
  });

  it('offers one line to add launches when there are none', async () => {
    api.listTaskLaunchIds.mockResolvedValue([]);
    render(<TaskLaunches teamId={TEAM} taskId="task" canEdit />);
    expect(await screen.findByRole('button', { name: 'Add launches' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
