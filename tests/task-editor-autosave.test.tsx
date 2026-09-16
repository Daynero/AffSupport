// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskEditor } from '../apps/web/src/team/tasks/TaskEditor';

/**
 * T079 — the editor saves itself (024, US3).
 *
 * Four mechanisms went to make this true: a staged attachment, a draft in
 * sessionStorage, a dirty flag, and a dialog in the doorway. All four existed
 * to protect work the product could simply have kept, and all four taught the
 * reader that this dialog was different from the status control sitting inside
 * it, which had always saved on change.
 *
 * What is pinned here is the promise, not the mechanism: a field commits, no
 * Save button exists, closing asks nothing, and a teammate's edit is a choice
 * rather than a snap-back.
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
  } as never;
}

function open(api: ReturnType<typeof client>, onClose = vi.fn()) {
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
          members={[]}
          canEdit
          client={api}
          onClose={onClose}
          onChanged={vi.fn()}
        />
      </TeamProvider>
    </ToastProvider>
  );
  return { onClose };
}

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the task editor saves itself', () => {
  it('has no Save button, and no prompt standing in the doorway', async () => {
    const api = client();
    const { onClose } = open(api);
    await screen.findByRole('heading', { name: 'Task details' });

    expect(screen.queryByRole('button', { name: 'Save task' })).toBeNull();

    fireEvent.change(document.querySelector('#team-task-title') as HTMLInputElement, {
      target: { value: 'A different name' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'You have unsaved changes' })).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    // And the half-typed word went with it rather than being dropped.
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(
        TEAM_ID,
        TASK_ID,
        expect.objectContaining({ title: 'A different name' })
      )
    );
  });

  it('writes a picked value at once — the gesture is the decision', async () => {
    const api = client();
    const user = userEvent.setup();
    open(api);
    await screen.findByRole('heading', { name: 'Task details' });

    await user.click(await screen.findByRole('button', { name: /^Date: / }));
    await user.click(screen.getByRole('button', { name: '2026-09-18' }));

    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(
        TEAM_ID,
        TASK_ID,
        expect.objectContaining({ dateOn: '2026-09-18' })
      )
    );
  });

  it('says so quietly when a write lands', async () => {
    const api = client();
    open(api);
    await screen.findByRole('heading', { name: 'Task details' });

    fireEvent.change(document.querySelector('#team-task-title') as HTMLInputElement, {
      target: { value: 'Named' }
    });
    fireEvent.blur(document.querySelector('#team-task-title') as HTMLInputElement);
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('keeps the words on screen and offers the retry when a write fails', async () => {
    const api = client({ updateTask: vi.fn().mockRejectedValue(new Error('DRIVE_UNAVAILABLE')) });
    open(api);
    await screen.findByRole('heading', { name: 'Task details' });

    const title = document.querySelector('#team-task-title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Still here' } });
    fireEvent.blur(title);

    expect(await screen.findByText('Could not save the latest task changes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The value the person typed is not rolled back under them.
    expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe(
      'Still here'
    );
  });

  it('offers a choice rather than a snap-back when somebody else got there first', async () => {
    const theirs = task({ title: 'What they called it', updatedAt: '2026-09-05T11:00:00.000Z' });
    const api = client({
      updateTask: vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')),
      getTask: vi.fn(async () => ({ task: theirs, attachments: [] }))
    });
    open(api);
    await screen.findByRole('heading', { name: 'Task details' });

    const title = document.querySelector('#team-task-title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'What I called it' } });
    fireEvent.blur(title);

    expect(
      await screen.findByRole('heading', { name: 'Somebody else changed this task' })
    ).toBeTruthy();
    expect(screen.getByText('What they called it')).toBeTruthy();
    // Mine is still in the field while I decide.
    expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe(
      'What I called it'
    );
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take their version' })).toBeTruthy();
  });
});
