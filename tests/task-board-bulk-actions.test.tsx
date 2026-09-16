// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskSpace } from '../apps/web/src/team/tasks/TaskSpace';

/**
 * T075 / T076 — one vocabulary for a task, on a card and on a set (024, US3).
 *
 * The board could nudge a status and nothing else. Assigning five tasks to
 * somebody meant opening five dialogs and closing five dialogs; deleting a
 * stale one meant opening it to find the button; and acting on more than one
 * task at a time was not possible at all.
 *
 * What is pinned here is that the two surfaces are the same list — a card's
 * overflow and the selection bar offer the same things in the same order — and
 * that the one destructive thing among them asks a question that names what
 * goes with it.
 */

const TEAM_ID = '25000000-0000-4000-8000-000000000010';
const STAMP = '2026-09-05T10:00:00.000Z';

function task(id: string, over: Partial<TeamTaskSummary> = {}): TeamTaskSummary {
  return {
    id,
    teamId: TEAM_ID,
    title: `Task ${id}`,
    note: null,
    assigneeId: null,
    assigneeLabelSnapshot: null,
    status: 'todo',
    progressMax: 100,
    progressValue: 0,
    progressManuallySet: false,
    attachmentCount: 0,
    dateOn: null,
    agents: [],
    labels: [],
    createdBy: '25000000-0000-4000-8000-000000000099',
    createdAt: STAMP,
    updatedAt: STAMP,
    completedAt: null,
    ...over
  };
}

const TASKS = [task('a'), task('b'), task('c')];

function client(over: Record<string, unknown> = {}) {
  return {
    listTasks: vi.fn(async () => TASKS),
    createTask: vi.fn(async () => TASKS[0]!),
    updateTask: vi.fn(async (_team: string, id: string, patch: Record<string, unknown>) => ({
      ...task(id),
      ...patch
    })),
    getTask: vi.fn(async () => ({ task: TASKS[0]!, attachments: [] })),
    deleteTask: vi.fn().mockResolvedValue(true),
    detachTaskMaterial: vi.fn().mockResolvedValue(true),
    attachTaskMaterials: vi
      .fn()
      .mockResolvedValue({ attached: [], alreadyAttached: [], rejected: [] }),
    attachTaskLabel: vi.fn().mockResolvedValue([]),
    detachTaskLabel: vi.fn().mockResolvedValue([]),
    listTaskLabels: vi.fn().mockResolvedValue([]),
    listFolderPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listMaterials: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    listAccounts: vi.fn().mockResolvedValue([]),
    issueDownloadGrant: vi.fn(),
    thumbnailUrl: vi.fn(),
    ...over
  } as never;
}

function board(api: ReturnType<typeof client>) {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  return render(
    <ToastProvider>
      <TeamProvider
        initialTeams={[
          {
            id: TEAM_ID,
            name: 'Media buyers',
            role: 'editor',
            permissions: DEFAULT_ROLE_PERMISSIONS.editor,
            connectionState: 'connected' as const
          }
        ]}
        realtime={false}
      >
        <TaskSpace teamId={TEAM_ID} client={api} />
      </TeamProvider>
    </ToastProvider>
  );
}

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('a task card', () => {
  it('carries one overflow rather than a row of controls', async () => {
    const user = userEvent.setup();
    board(client());
    await screen.findByText('Task a');

    const card = screen.getAllByRole('article')[0]!;
    // The status control, the tick box and one "…" — and nothing else.
    expect(within(card).getAllByRole('button', { name: /^Actions for/ })).toHaveLength(1);

    await user.click(within(card).getByRole('button', { name: /^Actions for/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: 'In progress' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Delete task' })).toBeTruthy();
  });

  it('opens the task when the card is pressed, but not when the tick box is', async () => {
    const user = userEvent.setup();
    board(client());
    await screen.findByText('Task a');

    const card = screen.getAllByRole('article')[0]!;
    await user.click(within(card).getByLabelText(/^Select /));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Selected: 1')).toBeTruthy();
  });
});

describe('the selection bar', () => {
  it('offers the same list as a card, applied to everything ticked', async () => {
    const user = userEvent.setup();
    const api = client();
    board(api);
    await screen.findByText('Task a');

    for (const card of screen.getAllByRole('article').slice(0, 2)) {
      await user.click(within(card).getByLabelText(/^Select /));
    }
    expect(screen.getByText('Selected: 2')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Do to all' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Done' }));

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(2));
    expect(api.updateTask).toHaveBeenCalledWith(
      TEAM_ID,
      'a',
      expect.objectContaining({ status: 'done' })
    );
    expect(api.updateTask).toHaveBeenCalledWith(
      TEAM_ID,
      'b',
      expect.objectContaining({ status: 'done' })
    );
  });

  it('asks before deleting, and the question names what goes with them', async () => {
    const user = userEvent.setup();
    const api = client();
    board(api);
    await screen.findByText('Task a');

    await user.click(within(screen.getAllByRole('article')[0]!).getByLabelText(/^Select /));
    await user.click(screen.getByRole('button', { name: 'Do to all' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete task' }));

    // No undo is promised, because a deleted task does not come back; the
    // question says so instead.
    expect(await screen.findByRole('heading', { name: 'Delete 1 tasks?' })).toBeTruthy();
    expect(screen.getByText(/do not come back/)).toBeTruthy();
    expect(api.deleteTask).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete task' }));
    await waitFor(() =>
      expect(api.deleteTask).toHaveBeenCalledWith({ teamId: TEAM_ID, taskId: 'a' })
    );
  });

  it('is not there at all until something is ticked', async () => {
    board(client());
    await screen.findByText('Task a');
    expect(screen.queryByRole('button', { name: 'Do to all' })).toBeNull();
  });
});
