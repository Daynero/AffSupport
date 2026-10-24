// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { analytics } from '../apps/web/src/analytics/service';
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

function diagnosticStep(value: unknown, expected: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'flow_step' in value &&
    value.flow_step === expected
  );
}

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

function open(
  onDelete?: () => Promise<void>,
  taskOverride: Partial<TeamTaskSummary> = {},
  api = client({ getTask: vi.fn(async () => ({ task: task(taskOverride), attachments: [] })) })
) {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  const view = (currentTask: TeamTaskSummary) => (
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
          task={currentTask}
          members={[
            { userId: 'u1', displayName: 'Olena', email: null } as never,
            { userId: 'u2', displayName: 'Taras', email: null } as never
          ]}
          canEdit
          client={api as never}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onDelete={onDelete}
        />
      </TeamProvider>
    </ToastProvider>
  );
  const rendered = render(view(task(taskOverride)));
  return { ...rendered, remote: (next: TeamTaskSummary) => rendered.rerender(view(next)) };
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
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

  it('retains the stored assignee label when the current directory is unavailable', async () => {
    open(undefined, { assigneeId: 'former-member', assigneeLabelSnapshot: 'Editor B' });
    expect((await screen.findByLabelText('Assignee')).textContent).toContain('Editor B');
  });

  it('updates the open editor when the board receives another user’s task status', async () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
    const view = open();
    await screen.findByDisplayValue('Pro Caps | TR 05/09');
    view.remote(task({ status: 'done', updatedAt: '2026-09-05T10:01:00.000Z' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true')
    );
    expect(
      track.mock.calls.some(
        ([event, props]) =>
          event === 'operation_completed' && diagnosticStep(props, 'task_editor_refresh')
      )
    ).toBe(true);
    view.remote(task({ status: 'in_progress', updatedAt: '2026-09-05T10:02:00.000Z' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'In progress' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
  });

  it('keeps local typing and its original conflict version while showing a remote status', async () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
    const api = client();
    const view = open(undefined, {}, api);
    const title = await screen.findByDisplayValue('Pro Caps | TR 05/09');
    fireEvent.change(title, { target: { value: 'My unsaved title' } });
    view.remote(
      task({ status: 'done', title: 'Teammate title', updatedAt: '2026-09-05T10:01:00.000Z' })
    );
    expect(screen.getByDisplayValue('My unsaved title')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true')
    );
    expect(
      track.mock.calls.some(
        ([event, props]) =>
          event === 'operation_completed' && diagnosticStep(props, 'task_editor_preserve_draft')
      )
    ).toBe(true);
    fireEvent.blur(title);
    await waitFor(() => expect(api.updateTask).toHaveBeenCalled());
    expect(api.updateTask.mock.calls[0]?.[2]).toMatchObject({
      title: 'My unsaved title',
      expectedUpdatedAt: STAMP
    });
  });

  it('does not report delivery in a hidden tab and records cancellation on close', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
    const view = open();
    await waitFor(() =>
      expect(
        track.mock.calls.some(
          ([event, props]) =>
            event === 'operation_stage_completed' && diagnosticStep(props, 'task_editor_refresh')
        )
      ).toBe(true)
    );
    expect(
      track.mock.calls.some(
        ([event, props]) =>
          event === 'operation_completed' && diagnosticStep(props, 'task_editor_refresh')
      )
    ).toBe(false);
    view.unmount();
    expect(
      track.mock.calls.some(
        ([event, props]) =>
          event === 'operation_cancelled' && diagnosticStep(props, 'task_editor_refresh')
      )
    ).toBe(true);
  });

  it('observes two teammate updates in one millisecond and rejects the older version', async () => {
    const initial = { updatedAt: '2026-09-05T10:00:00.000100Z' };
    const view = open(undefined, initial);
    await screen.findByDisplayValue('Pro Caps | TR 05/09');
    view.remote(task({ status: 'done', updatedAt: '2026-09-05T10:00:00.000200Z' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true')
    );
    view.remote(task({ status: 'in_progress', updatedAt: '2026-09-05T10:00:00.000300Z' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'In progress' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    view.remote(task({ status: 'done', updatedAt: '2026-09-05T10:00:00.000200Z' }));
    expect(screen.getByRole('button', { name: 'In progress' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });

  it('does not create a delivery receipt for a read resolving after the editor closed', async () => {
    let resolve!: (value: { task: TeamTaskSummary; attachments: never[] }) => void;
    const api = client({
      getTask: vi.fn(
        () =>
          new Promise(value => {
            resolve = value;
          })
      )
    });
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
    const view = open(undefined, {}, api);
    view.unmount();
    await act(async () => {
      resolve({ task: task(), attachments: [] });
    });
    expect(track.mock.calls.some(([, props]) => diagnosticStep(props, 'task_editor_refresh'))).toBe(
      false
    );
  });

  it('completes a committed hidden-tab receipt only after the tab becomes visible', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
    open();
    await waitFor(() =>
      expect(
        track.mock.calls.some(
          ([event, props]) =>
            event === 'operation_stage_completed' && diagnosticStep(props, 'task_editor_refresh')
        )
      ).toBe(true)
    );
    expect(
      track.mock.calls.some(
        ([event, props]) =>
          event === 'operation_completed' && diagnosticStep(props, 'task_editor_refresh')
      )
    ).toBe(false);
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() =>
      expect(
        track.mock.calls.some(
          ([event, props]) =>
            event === 'operation_completed' && diagnosticStep(props, 'task_editor_refresh')
        )
      ).toBe(true)
    );
  });

  it('takes a newer confirmed peer snapshot when another update arrived during the conflict dialog', async () => {
    const reviewed = task({
      title: 'Reviewed peer',
      note: 'Reviewed brief',
      updatedAt: '2026-09-05T11:00:00.000Z'
    });
    const latest = task({
      title: 'Latest peer',
      note: 'Latest brief',
      status: 'done',
      updatedAt: '2026-09-05T12:00:00.000Z'
    });
    const api = client({
      updateTask: vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')),
      getTask: vi
        .fn()
        .mockResolvedValueOnce({ task: task(), attachments: [] })
        .mockResolvedValue({ task: reviewed, attachments: [] })
    });
    const view = open(undefined, {}, api);
    const title = await screen.findByDisplayValue(task().title);
    fireEvent.change(title, { target: { value: 'My draft' } });
    fireEvent.blur(title);
    await screen.findByRole('dialog', { name: 'Somebody else changed this task' });
    view.remote(latest);
    const user = userEvent.setup();
    await user.click(
      within(screen.getByRole('dialog', { name: 'Somebody else changed this task' })).getByRole(
        'button',
        { name: 'Take their version' }
      )
    );
    expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe(
      'Latest peer'
    );
    expect((document.querySelector('#team-task-description') as HTMLTextAreaElement).value).toBe(
      'Latest brief'
    );
    expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true');
    expect(api.updateTask).toHaveBeenCalledOnce();
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
