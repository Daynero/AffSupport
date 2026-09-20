// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskEditor } from '../apps/web/src/team/tasks/TaskEditor';

/**
 * T167 — a task reads as a brief, not a form (024, US12).
 *
 * The beta walk found the editor's layout deciding against it: a red delete
 * button in the middle of the form, a twelve-row box pushing the materials
 * below the fold, and a status control broken into vertical letters by a
 * window-wide breakpoint inside a narrow dialog.
 */

const TEAM_ID = '24000000-0000-4000-8000-000000000010';
const TASK_ID = '24000000-0000-4000-8000-000000000011';
const STAMP = '2026-09-05T10:00:00.000Z';

function task(over: Partial<TeamTaskSummary> = {}): TeamTaskSummary {
  return {
    id: TASK_ID,
    teamId: TEAM_ID,
    title: 'Pro Caps | TR 05/09',
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
    createdBy: '24000000-0000-4000-8000-000000000099',
    createdAt: STAMP,
    updatedAt: STAMP,
    completedAt: null,
    ...over
  };
}

function client(over: Record<string, unknown> = {}) {
  return {
    listTasks: vi.fn(async () => [task()]),
    createTask: vi.fn(async () => task()),
    updateTask: vi.fn(async (_team: string, _id: string, patch: Record<string, unknown>) => ({
      ...task(),
      ...patch,
      updatedAt: new Date(Date.parse(STAMP) + 1_000).toISOString()
    })),
    getTask: vi.fn(async () => ({ task: task(), attachments: [] })),
    detachTaskMaterial: vi.fn().mockResolvedValue(true),
    attachTaskMaterials: vi
      .fn()
      .mockResolvedValue({ attached: [], alreadyAttached: [], rejected: [] }),
    listFolderPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listMaterials: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    deleteTask: vi.fn().mockResolvedValue(true),
    listAccounts: vi.fn().mockResolvedValue([]),
    issueDownloadGrant: vi.fn(),
    thumbnailUrl: vi.fn(),
    ...over
  };
}

function open(onDelete?: () => Promise<void>) {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  render(
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
        <TaskEditor
          teamId={TEAM_ID}
          task={task()}
          members={[
            { userId: 'u1', displayName: 'Olena', email: null } as never,
            { userId: 'u2', displayName: 'Taras', email: null } as never
          ]}
          canEdit
          client={client() as never}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onDelete={onDelete}
        />
      </TeamProvider>
    </ToastProvider>
  );
}

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the task editor as a brief', () => {
  it('reads title, the facts line, accounts and tags, the brief, then the work', async () => {
    open();
    await screen.findByDisplayValue('Pro Caps | TR 05/09');
    const editor = document.querySelector('.team-task-editor')!;
    // Accounts and tags sit under the facts (024): which agent a launch is on is the task's
    // main fact, and it used to follow a tall drop tile in the other column.
    const order = [
      '#team-task-title',
      '.team-task-editor-facts',
      '.team-task-editor-tags',
      '#team-task-description',
      '.team-task-editor-progress-group',
      '.team-task-attachments'
    ]
      .map(selector => editor.querySelector(selector))
      .filter((node): node is Element => node !== null);
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    // The facts are one line: state, who, when.
    const facts = editor.querySelector('.team-task-editor-facts')!;
    expect(facts.querySelector('.team-task-status-control')).toBeTruthy();
    expect(facts.querySelector('.team-task-status-select')).toBeTruthy();
    expect(facts.querySelector('#team-task-assignee')).toBeTruthy();
    // The brief is short until it is written.
    expect(screen.getByLabelText('Description').getAttribute('rows')).toBe('3');
  });

  it('keeps delete in the editor menu, and still confirms', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    open(onDelete);
    await screen.findByDisplayValue('Pro Caps | TR 05/09');
    expect(screen.queryByRole('button', { name: 'Delete task' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Task actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete task' }));
    // A task cannot be given back whole, so this still asks (021, R3).
    expect(await screen.findByText('Delete this task?')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
