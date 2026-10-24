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
  };
}

function open(api: ReturnType<typeof client>, onClose = vi.fn(), initialTask = task()) {
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
          task={initialTask}
          members={[]}
          canEdit
          client={api as never}
          onClose={onClose}
          onChanged={vi.fn()}
        />
      </TeamProvider>
    </ToastProvider>
  );
  return { onClose };
}

beforeEach(() => localStorage.setItem('language', 'en'));
it('serializes a status choice behind an in-flight text save using the returned version', async () => {
  let finish!: (value: TeamTaskSummary) => void;
  const updatedAt = '2026-09-05T10:01:00.000Z';
  const api = client({
    updateTask: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<TeamTaskSummary>(resolve => {
            finish = resolve;
          })
      )
      .mockImplementationOnce(async (_team, _id, patch) =>
        task({ title: 'Named', ...patch, updatedAt: '2026-09-05T10:02:00.000Z' })
      )
  });
  open(api);
  await act(async () => {});
  fireEvent.change(document.querySelector('#team-task-title')!, { target: { value: 'Named' } });
  fireEvent.blur(document.querySelector('#team-task-title')!);
  await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'In progress' }));
  expect(api.updateTask).toHaveBeenCalledTimes(1);
  await act(async () => finish(task({ title: 'Named', updatedAt })));
  await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(2));
  expect(api.updateTask).toHaveBeenLastCalledWith(
    TEAM_ID,
    TASK_ID,
    expect.objectContaining({ status: 'in_progress', expectedUpdatedAt: updatedAt })
  );
  expect(screen.getByRole('button', { name: 'In progress' }).getAttribute('aria-pressed')).toBe(
    'true'
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the task editor saves itself', () => {
  const taggedTask = () =>
    task({
      agents: [
        {
          id: 'link',
          agentRowId: 'agent',
          accountId: 'account',
          accountName: 'g10',
          agentId: '542',
          runs: []
        }
      ],
      labels: [{ id: 'label', name: 'Feed', color: 'teal' }]
    });

  it.each(['title', 'status', 'progress'] as const)(
    'keeps accounts and tags visible after saving %s',
    async field => {
      const initial = taggedTask();
      const api = client({ getTask: vi.fn(async () => ({ task: initial, attachments: [] })) });
      open(api, vi.fn(), initial);
      await screen.findByText('Feed');
      await waitFor(() => expect(api.getTask).toHaveBeenCalledOnce());
      if (field === 'title') {
        fireEvent.change(document.querySelector('#team-task-title')!, {
          target: { value: 'Named' }
        });
        fireEvent.blur(document.querySelector('#team-task-title')!);
        await screen.findByText('Saved');
      } else if (field === 'status') {
        fireEvent.click(screen.getByRole('button', { name: 'In progress' }));
      } else {
        fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
      }
      await waitFor(() => expect(api.updateTask).toHaveBeenCalledOnce());
      await waitFor(() => {
        expect(screen.getByText('Feed')).toBeTruthy();
        expect(screen.getByText('g10-542')).toBeTruthy();
      });
    }
  );

  it('does not restore a removed tag when an older opening read arrives', async () => {
    const initial = taggedTask();
    let finish!: (value: { task: TeamTaskSummary; attachments: [] }) => void;
    const api = client({
      getTask: vi.fn(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      ),
      detachTaskLabel: vi.fn(async () => [])
    });
    open(api, vi.fn(), initial);
    fireEvent.click(await screen.findByRole('button', { name: 'Take «Feed» off this task' }));
    await waitFor(() => expect(screen.queryByText('Feed')).toBeNull());
    await act(async () => finish({ task: initial, attachments: [] }));
    expect(screen.queryByText('Feed')).toBeNull();
  });

  it.each(['title', 'status'] as const)(
    'keeps newer account and tag changes while saving %s',
    async field => {
      const initial = taggedTask();
      let finish!: (value: TeamTaskSummary) => void;
      const api = client({
        getTask: vi.fn(async () => ({ task: initial, attachments: [] })),
        updateTask: vi.fn(
          () =>
            new Promise<TeamTaskSummary>(resolve => {
              finish = resolve;
            })
        ),
        detachTaskLabel: vi.fn(async () => []),
        detachTaskAgent: vi.fn(async () => [])
      });
      open(api, vi.fn(), initial);
      await act(async () => {});
      if (field === 'title') {
        fireEvent.change(document.querySelector('#team-task-title')!, {
          target: { value: 'Named' }
        });
        fireEvent.blur(document.querySelector('#team-task-title')!);
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'In progress' }));
      }
      await waitFor(() => expect(api.updateTask).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole('button', { name: 'Take «Feed» off this task' }));
      fireEvent.click(screen.getByRole('button', { name: /^g10-542/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove from the task' }));
      await waitFor(() => {
        expect(screen.queryByText('Feed')).toBeNull();
        expect(screen.queryByText('g10-542')).toBeNull();
      });
      await act(async () => finish(task({ title: 'Named', status: 'in_progress' })));
      expect(screen.queryByText('Feed')).toBeNull();
      expect(screen.queryByText('g10-542')).toBeNull();
    }
  );

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
    await user.click(screen.getByRole('button', { name: /September 18, 2026/ }));

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
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('DRIVE_UNAVAILABLE'))
      .mockResolvedValue(task({ title: 'Still here' }));
    const api = client({ updateTask: write });
    open(api);
    await screen.findByRole('heading', { name: 'Task details' });

    const title = document.querySelector('#team-task-title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Still here' } });
    fireEvent.blur(title);

    const failure = await screen.findByText('Could not save the latest task changes.');
    const retry = within(failure).getByRole('button', { name: 'Try again' });
    expect(retry).toBeTruthy();
    // The value the person typed is not rolled back under them.
    expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe(
      'Still here'
    );
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[2]).toMatchObject({
      title: 'Still here',
      expectedUpdatedAt: STAMP
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it.each(['Take their version', 'Cancel'])(
    'applies every reviewed server field when choosing %s',
    async choice => {
      const theirs = task({
        title: 'Peer title',
        note: 'Peer brief',
        status: 'in_progress',
        assigneeId: 'peer',
        assigneeLabelSnapshot: 'Peer member',
        dateOn: '2026-09-18',
        progressMax: 50,
        progressValue: 5,
        updatedAt: '2026-09-05T11:00:00.000Z'
      });
      const api = client({
        updateTask: vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')),
        getTask: vi
          .fn()
          .mockResolvedValueOnce({ task: task(), attachments: [] })
          .mockResolvedValue({ task: theirs, attachments: [] })
      });
      const user = userEvent.setup();
      open(api);
      const title = await screen.findByDisplayValue(task().title);
      fireEvent.change(title, { target: { value: 'My draft' } });
      fireEvent.blur(title);
      await screen.findByRole('heading', { name: 'Somebody else changed this task' });
      await user.click(
        within(screen.getByRole('dialog', { name: 'Somebody else changed this task' })).getByRole(
          'button',
          { name: choice }
        )
      );
      expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe(
        'Peer title'
      );
      expect((document.querySelector('#team-task-description') as HTMLTextAreaElement).value).toBe(
        'Peer brief'
      );
      expect(screen.getByRole('button', { name: 'In progress' }).getAttribute('aria-pressed')).toBe(
        'true'
      );
      expect(screen.getByLabelText('Assignee').textContent).toContain('Peer member');
      expect(screen.getByRole('button', { name: /^Date: / }).getAttribute('aria-label')).toContain(
        '18'
      );
      expect((document.querySelector('#team-task-progress-max') as HTMLInputElement).value).toBe(
        '50'
      );
      expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('5');
      expect(api.updateTask).toHaveBeenCalledOnce();
    }
  );

  it('retries local edits against the explicitly reviewed newer version when choosing Keep mine', async () => {
    const theirs = task({ title: 'Peer title', updatedAt: '2026-09-05T11:00:00.000Z' });
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('SOURCE_CHANGED'))
      .mockImplementation(async (_team: string, _id: string, patch: Record<string, unknown>) => {
        if (patch.expectedUpdatedAt !== theirs.updatedAt) throw new Error('SOURCE_CHANGED');
        return task({ title: String(patch.title), updatedAt: '2026-09-05T11:01:00.000Z' });
      });
    const api = client({
      updateTask: write,
      getTask: vi
        .fn()
        .mockResolvedValueOnce({ task: task(), attachments: [] })
        .mockResolvedValue({ task: theirs, attachments: [] })
    });
    const user = userEvent.setup();
    open(api);
    const title = await screen.findByDisplayValue(task().title);
    fireEvent.change(title, { target: { value: 'My draft' } });
    fireEvent.blur(title);
    await screen.findByRole('heading', { name: 'Somebody else changed this task' });
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1]?.[2]).toMatchObject({
      title: 'My draft',
      expectedUpdatedAt: theirs.updatedAt
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Somebody else changed this task' })).toBeNull()
    );
    expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe('My draft');
  });

  it('preserves another concurrency check after choosing Keep mine', async () => {
    const signals: Array<{ event: string; step: unknown }> = [];
    vi.spyOn(analytics, 'track').mockImplementation((event, props) => {
      signals.push({ event, step: props && 'flow_step' in props ? props.flow_step : null });
    });
    const theirs = task({ title: 'Peer first', updatedAt: '2026-09-05T11:00:00.000Z' });
    const newest = task({ title: 'Peer second', updatedAt: '2026-09-05T12:00:00.000Z' });
    const write = vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED'));
    const api = client({
      updateTask: write,
      getTask: vi
        .fn()
        .mockResolvedValueOnce({ task: task(), attachments: [] })
        .mockResolvedValueOnce({ task: theirs, attachments: [] })
        .mockResolvedValue({ task: newest, attachments: [] })
    });
    const user = userEvent.setup();
    open(api);
    const title = await screen.findByDisplayValue(task().title);
    fireEvent.change(title, { target: { value: 'My draft' } });
    fireEvent.blur(title);
    await screen.findByRole('heading', { name: 'Somebody else changed this task' });
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    await screen.findByText('Peer second');
    expect(write.mock.calls[1]?.[2]).toMatchObject({
      title: 'My draft',
      expectedUpdatedAt: theirs.updatedAt
    });
    expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe('My draft');
  });

  it('preserves the draft when the reviewed server version could not be read', async () => {
    const api = client({
      updateTask: vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED')),
      getTask: vi
        .fn()
        .mockResolvedValueOnce({ task: task(), attachments: [] })
        .mockRejectedValue(new Error('NETWORK_FAILED'))
    });
    const user = userEvent.setup();
    open(api);
    const title = await screen.findByDisplayValue(task().title);
    fireEvent.change(title, { target: { value: 'My draft' } });
    fireEvent.blur(title);
    const dialog = await screen.findByRole('dialog', { name: 'Somebody else changed this task' });
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Take their version'
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      (within(dialog).getByRole('button', { name: 'Keep mine' }) as HTMLButtonElement).disabled
    ).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((document.querySelector('#team-task-title') as HTMLInputElement).value).toBe('My draft');
    expect(
      await screen.findByText('Could not refresh this task. Nothing you typed was lost.')
    ).toBeTruthy();
    expect(api.updateTask).toHaveBeenCalledOnce();
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
