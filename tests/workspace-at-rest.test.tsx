// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskSpace } from '../apps/web/src/team/tasks/TaskSpace';

import { TaskEditor } from '../apps/web/src/team/tasks/TaskEditor';

/**
 * T174 / T177 — calm at rest, and solo is not a smaller team (024, US13, US14).
 *
 * A board with nothing on it offered the same "create" twice; a person working
 * alone read "not assigned" on every task they had and an invitation they had
 * no one to send. What is pinned here is what a screen shows before anything is
 * pressed.
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
  };
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
        <TaskSpace teamId={TEAM_ID} client={api as never} />
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

function editor(members: { userId: string; displayName: string; email: null }[]) {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  return render(
    <ToastProvider>
      <TeamProvider
        initialTeams={[
          {
            id: TEAM_ID,
            name: 'Media buyers',
            role: 'owner',
            permissions: DEFAULT_ROLE_PERMISSIONS.owner,
            connectionState: 'connected' as const
          }
        ]}
        realtime={false}
      >
        <TaskEditor
          teamId={TEAM_ID}
          task={task('a')}
          members={members as never}
          canEdit
          client={client() as never}
          onClose={vi.fn()}
          onChanged={vi.fn()}
        />
      </TeamProvider>
    </ToastProvider>
  );
}

describe('the board at rest', () => {
  it('offers one way to start when there is nothing on it', async () => {
    board(client({ listTasks: vi.fn(async () => []) }));
    expect(await screen.findByRole('button', { name: 'Create your first task' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'New task — type its name' })).toBeNull();
  });

  it(
    'adds tasks by typing, without opening them, and keeps the field for the next',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      const api = client();
      board(api);
      await screen.findByText('Task a');
      const field = screen.getByRole('textbox', { name: 'New task — type its name' });
      for (const title of ['Catalog', 'Transcript']) {
        await user.type(field, `${title}{Enter}`);
        await waitFor(() =>
          expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ title }))
        );
        expect((field as HTMLInputElement).value).toBe('');
        expect(document.activeElement).toBe(field);
      }
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  );
});

describe('a space of one', () => {
  it('keeps the assignee in the editor even when the person works alone (024, the owner)', async () => {
    editor([{ userId: 'u1', displayName: 'Olena', email: null }]);
    await screen.findByDisplayValue('Task a');
    expect(document.querySelector('#team-task-assignee')).toBeTruthy();
  });
});
