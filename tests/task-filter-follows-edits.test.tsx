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
 * A board filter follows the edits made under it (024).
 *
 * Two reports from the owner, the same mistake from both sides: a card set to
 * "Done" under an "In progress" filter stayed on the board until a reload, and
 * the same change made from the open task closed the task under the person's
 * hands — then sprang it open again when "Done" was chosen, because the address
 * still named it.
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

const TASKS = [task('a', { status: 'in_progress' }), task('b', { status: 'in_progress' })];

function client(over: Record<string, unknown> = {}) {
  return {
    listTasks: vi.fn(async (input: { status?: string | null }) =>
      TASKS.filter(item => !input?.status || item.status === input.status)
    ),
    createTask: vi.fn(async () => TASKS[0]!),
    updateTask: vi.fn(async (_team: string, id: string, patch: Record<string, unknown>) => ({
      ...TASKS.find(item => item.id === id)!,
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
  };
}

function board(api: ReturnType<typeof client>, children?: React.ReactNode) {
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
        {children ?? <TaskSpace teamId={TEAM_ID} client={api as never} />}
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

function filterPill(name: string) {
  return screen
    .getAllByRole('button', { name })
    .find(button => !button.closest('article') && !button.closest('[role="dialog"]'))!;
}

describe('a board filtered by status', () => {
  it('lets a card go the moment its status leaves the filter', async () => {
    const user = userEvent.setup();
    board(client());
    await screen.findByText('Task a');
    await user.click(filterPill('In progress'));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));

    const card = screen.getAllByRole('article').find(item => item.textContent?.includes('Task a'))!;
    await user.click(within(card).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(screen.queryByText('Task a')).toBeNull());
    expect(screen.getByText('Task b')).toBeTruthy();
  });

  it('keeps the open task open when its own status takes it out of the filter', async () => {
    const user = userEvent.setup();
    const api = client();
    let openId: string | null = null;
    function Controlled() {
      const [id, setId] = React.useState<string | null>(null);
      openId = id;
      return (
        <TaskSpace
          teamId={TEAM_ID}
          client={api as never}
          openTaskId={id}
          onOpenTaskChange={setId}
        />
      );
    }
    board(api, <Controlled />);
    await screen.findByText('Task a');
    await user.click(filterPill('In progress'));
    await user.click(screen.getByText('Task a'));
    const dialog = await screen.findByRole('dialog');

    // The board refetches under the filter and no longer holds the task.
    api.listTasks.mockImplementation(async () => [TASKS[1]!]);
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(api.updateTask).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(openId).toBe('a');
  });
});

describe('a task made from files', () => {
  it('is made once, even when the effect runs twice, and again when the same files are sent again', async () => {
    const api = client();
    const asset = { ids: ['m1', 'm2'], name: 'clip та ще 1' };
    const { rerender } = board(
      api,
      <React.StrictMode>
        <TaskSpace teamId={TEAM_ID} client={api as never} createFromAsset={asset} />
      </React.StrictMode>
    );
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(api.createTask).toHaveBeenCalledTimes(1);

    // The same selection sent a second time is a second request, not a repeat.
    rerender(
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
          <React.StrictMode>
            <TaskSpace teamId={TEAM_ID} client={api as never} createFromAsset={{ ...asset }} />
          </React.StrictMode>
        </TeamProvider>
      </ToastProvider>
    );
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
  });
});
