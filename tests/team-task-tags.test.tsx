// @vitest-environment jsdom
import React from 'react';
import { cleanup, render as renderRaw, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_ROLE_PERMISSIONS,
  compareTeamTasksByLabel,
  nextTeamTaskLabelColor,
  normalizeTeamTaskLabelName,
  teamTaskLabelKey,
  type TeamTaskLabel,
  type TeamTaskLabelRef,
  type TeamTaskSummary
} from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskCard } from '../apps/web/src/team/tasks/TaskCard';
import { TaskEditor, type TaskEditorClient } from '../apps/web/src/team/tasks/TaskEditor';
import { TaskSpace, type TaskSpaceClient } from '../apps/web/src/team/tasks/TaskSpace';
import { TaskLabelsSection } from '../apps/web/src/team/labels/TaskLabelsSection';

/**
 * Tags on tasks (018): the dictionary in space settings, the chips on a card,
 * the picker in the editor, and the board's tag filter and tag order — against
 * a stubbed client.
 */

const TEAM_ID = '18000000-0000-4000-8000-000000000020';
const TASK_ID = '18000000-0000-4000-8000-000000000021';
const HOT = '18000000-0000-4000-8000-000000000031';
const UGC = '18000000-0000-4000-8000-000000000032';
const STAMP = '2026-09-06T10:00:00.000Z';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function dictionary(): TeamTaskLabel[] {
  return [
    {
      id: HOT,
      teamId: TEAM_ID,
      scope: 'task',
      name: 'Hot',
      color: 'red',
      taskCount: 2,
      createdAt: STAMP,
      updatedAt: STAMP
    },
    {
      id: UGC,
      teamId: TEAM_ID,
      scope: 'task',
      name: 'UGC',
      color: 'teal',
      taskCount: 0,
      createdAt: STAMP,
      updatedAt: STAMP
    }
  ];
}

function ref(id: string): TeamTaskLabelRef {
  const found = dictionary().find(label => label.id === id)!;
  return { id: found.id, name: found.name, color: found.color };
}

function task(labels: TeamTaskLabelRef[] = [], overrides: Partial<TeamTaskSummary> = {}) {
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
    labels,
    createdBy: '18000000-0000-4000-8000-000000000099',
    createdAt: STAMP,
    updatedAt: STAMP,
    completedAt: null,
    ...overrides
  } satisfies TeamTaskSummary;
}

/** A client whose tag state lives in a closure, so writes round-trip. */
function client(options: { labels?: TeamTaskLabel[]; onTask?: TeamTaskLabelRef[] } = {}) {
  let available = options.labels ?? dictionary();
  let onTask = options.onTask ?? [];
  const current = () => task(onTask);
  const listTasks = vi.fn(async () => [current()]);
  return {
    listTasks,
    dictionary: () => available,
    createTask: vi.fn(async () => current()),
    updateTask: vi.fn(async () => current()),
    getTask: vi.fn(async () => ({ task: current(), attachments: [] })),
    detachTaskMaterial: vi.fn().mockResolvedValue(true),
    attachTaskMaterials: vi
      .fn()
      .mockResolvedValue({ attached: [], alreadyAttached: [], rejected: [] }),
    listFolderPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listMembers: vi.fn().mockResolvedValue([
      {
        membershipId: 'm1',
        userId: 'u-anna',
        displayName: 'Анна',
        email: 'anna@example.test',
        role: 'editor',
        baseRole: 'editor',
        permissionOverrides: {},
        effectivePermissions: DEFAULT_ROLE_PERMISSIONS.editor,
        joinedAt: STAMP
      },
      {
        membershipId: 'm2',
        userId: 'u-bogdan',
        displayName: 'Богдан',
        email: 'bogdan@example.test',
        role: 'viewer',
        baseRole: 'viewer',
        permissionOverrides: {},
        effectivePermissions: DEFAULT_ROLE_PERMISSIONS.viewer,
        joinedAt: STAMP
      }
    ]),
    deleteTask: vi.fn().mockResolvedValue(true),
    listAccounts: vi.fn(async () => []),
    attachTaskAgent: vi.fn(async () => []),
    detachTaskAgent: vi.fn(async () => []),
    addAgentRun: vi.fn(),
    updateAgentRun: vi.fn(),
    deleteAgentRun: vi.fn(),
    listTaskLabels: vi.fn(async () => available),
    createTaskLabel: vi.fn(async ({ name, color }) => {
      const created: TeamTaskLabel = {
        id: `new-${name}`,
        teamId: TEAM_ID,
        scope: 'task',
        name,
        color,
        taskCount: 0,
        createdAt: STAMP,
        updatedAt: STAMP
      };
      available = [...available, created];
      return created;
    }),
    updateTaskLabel: vi.fn(async ({ labelId, name, color }) => {
      available = available.map(label =>
        label.id === labelId ? { ...label, name, color } : label
      );
      return available.find(label => label.id === labelId)!;
    }),
    deleteTaskLabel: vi.fn(async ({ labelId }) => {
      available = available.filter(label => label.id !== labelId);
      return true as const;
    }),
    attachTaskLabel: vi.fn(async ({ labelId }) => {
      if (!onTask.some(label => label.id === labelId)) onTask = [...onTask, ref(labelId)];
      return onTask;
    }),
    detachTaskLabel: vi.fn(async ({ labelId }) => {
      onTask = onTask.filter(label => label.id !== labelId);
      return onTask;
    }),
    issueDownloadGrant: vi.fn(),
    thumbnailUrl: vi.fn()
  } as unknown as TaskSpaceClient &
    TaskEditorClient & { dictionary: () => TeamTaskLabel[]; listTasks: ReturnType<typeof vi.fn> };
}

function wrap(ui: React.ReactElement, role: 'editor' | 'viewer' = 'editor') {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  const team = {
    id: TEAM_ID,
    name: 'Media buyers',
    role,
    permissions: DEFAULT_ROLE_PERMISSIONS[role],
    connectionState: 'connected' as const
  };
  return renderRaw(
    <ToastProvider>
      <TeamProvider initialTeams={[team]} realtime={false}>
        {ui}
      </TeamProvider>
    </ToastProvider>
  );
}

describe('the contract', () => {
  it('normalizes a name and refuses one that is blank or too long', () => {
    expect(normalizeTeamTaskLabelName('  Hot   sale ')).toBe('Hot sale');
    expect(normalizeTeamTaskLabelName('   ')).toBeNull();
    expect(normalizeTeamTaskLabelName('x'.repeat(25))).toBeNull();
  });

  it('offers the colour the space uses least', () => {
    expect(nextTeamTaskLabelColor([])).toBe('purple');
    expect(nextTeamTaskLabelColor([{ color: 'purple' }])).toBe('blue');
  });

  it('orders by first tag and sinks the untagged, whatever their date', () => {
    const tagged = task([ref(UGC)], { id: 'b', createdAt: '2026-09-01T10:00:00.000Z' });
    const untagged = task([], { id: 'c', createdAt: '2026-09-06T10:00:00.000Z' });
    const hot = task([ref(HOT)], { id: 'a', createdAt: '2026-09-02T10:00:00.000Z' });
    expect(teamTaskLabelKey(untagged)).toBeNull();
    expect([untagged, tagged, hot].sort(compareTeamTasksByLabel).map(item => item.id)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });
});

describe('the dictionary in settings', () => {
  it('makes a tag, renames it, and deletes it once the confirmation names the cost', async () => {
    const user = userEvent.setup();
    const api = client();
    wrap(<TaskLabelsSection teamId={TEAM_ID} client={api} />);

    await screen.findByText('Hot');
    await user.type(screen.getByLabelText('Name'), 'Cold');
    await user.click(screen.getByRole('radio', { name: 'Blue' }));
    await user.click(screen.getByRole('button', { name: /Add tag/u }));
    await waitFor(() =>
      expect(api.createTaskLabel).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        name: 'Cold',
        color: 'blue',
        scope: 'task'
      })
    );
    // The field empties: a dictionary is written several tags at a time.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');

    await user.click(screen.getByRole('button', { name: 'Edit the tag: Hot' }));
    // The row's field is named for the row, not just "Name": the create form
    // carries that label already.
    const field = screen.getByRole('textbox', { name: 'Name: Hot' });
    await user.clear(field);
    await user.type(field, 'Warm');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateTaskLabel).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        labelId: HOT,
        name: 'Warm',
        color: 'red'
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Delete the tag: Warm' }));
    // The confirmation says what it costs — two tasks lose the tag, and keep
    // everything else. (The row behind it says "2 tasks" too, hence the scope.)
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 tasks/u)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete the tag' }));
    await waitFor(() =>
      expect(api.deleteTaskLabel).toHaveBeenCalledWith({ teamId: TEAM_ID, labelId: HOT })
    );
  });

  it('says a duplicate name in the tags\u2019 own words, not the file copy', async () => {
    const user = userEvent.setup();
    const api = client();
    (api.createTaskLabel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('NAME_CONFLICT'), { code: 'NAME_CONFLICT' })
    );
    wrap(<TaskLabelsSection teamId={TEAM_ID} client={api} />);

    await screen.findByText('Hot');
    await user.type(screen.getByLabelText('Name'), 'Hot');
    await user.click(screen.getByRole('button', { name: /Add tag/u }));
    expect(await screen.findByText('This space already has a tag by that name.')).toBeTruthy();
  });

  it('shows a viewer the tags and none of the controls', async () => {
    wrap(<TaskLabelsSection teamId={TEAM_ID} client={client()} />, 'viewer');
    await screen.findByText('Hot');
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete the tag/u })).toBeNull();
  });
});

describe('a card', () => {
  it('shows the tags it carries and folds the rest into a "+N"', () => {
    const many: TeamTaskLabelRef[] = [
      { id: '1', name: 'Alpha', color: 'purple' },
      { id: '2', name: 'Beta', color: 'blue' },
      { id: '3', name: 'Gamma', color: 'teal' },
      { id: '4', name: 'Delta', color: 'green' }
    ];
    wrap(<TaskCard task={task(many)} canEdit onOpen={() => {}} onUpdate={vi.fn()} />);
    // Natural order, not the order they arrived in: the fourth to read is the
    // one that folds away.
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Delta')).toBeTruthy();
    expect(screen.queryByText('Gamma')).toBeNull();
    expect(screen.getByLabelText('Gamma')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
  });
});

describe('the editor', () => {
  it('hangs a tag the moment it is pressed, and takes it off with the chip’s ×', async () => {
    const user = userEvent.setup();
    const api = client();
    const onLabelsChange = vi.fn();
    wrap(
      <TaskEditor
        teamId={TEAM_ID}
        task={task()}
        members={[]}
        canEdit
        client={api}
        labels={dictionary()}
        onClose={() => {}}
        onChanged={() => {}}
        onLabelsChange={onLabelsChange}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Tag' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /Hot/u }));
    await waitFor(() =>
      expect(api.attachTaskLabel).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        taskId: TASK_ID,
        labelId: HOT
      })
    );
    expect(onLabelsChange).toHaveBeenCalledWith([ref(HOT)]);

    await user.click(await screen.findByRole('button', { name: 'Take «Hot» off this task' }));
    await waitFor(() =>
      expect(api.detachTaskLabel).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        taskId: TASK_ID,
        labelId: HOT
      })
    );
    // Taking one off offers to put it back: the press is one gesture and the
    // tag is not on screen to find again.
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('sends a viewer no way to change the tags', async () => {
    wrap(
      <TaskEditor
        teamId={TEAM_ID}
        task={task([ref(HOT)])}
        members={[]}
        canEdit={false}
        client={client()}
        labels={dictionary()}
        onClose={() => {}}
        onChanged={() => {}}
      />,
      'viewer'
    );
    expect(await screen.findByText('Hot')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tag' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Take «Hot» off/u })).toBeNull();
  });
});

describe('the board', () => {
  it('narrows to the chosen tags and asks the server for them', async () => {
    const user = userEvent.setup();
    const api = client();
    wrap(<TaskSpace teamId={TEAM_ID} client={api} />);

    await user.click(await screen.findByRole('button', { name: 'Only tasks carrying these tags' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /Hot/u }));
    await waitFor(() =>
      expect(api.listTasks).toHaveBeenCalledWith(expect.objectContaining({ labelIds: [HOT] }))
    );
    // The pill says which tag is in force, and offers the way back out.
    expect(screen.getByRole('button', { name: 'Show tasks with any tag' })).toBeTruthy();
  });

  it('puts the progress scales away with the eye, and remembers the choice', async () => {
    const user = userEvent.setup();
    const api = client();
    const { unmount } = wrap(<TaskSpace teamId={TEAM_ID} client={api} />);

    await screen.findByRole('article');
    expect(screen.getAllByRole('slider').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Hide the progress scales' }));
    expect(screen.queryByRole('slider')).toBeNull();

    // The choice is this browser's, and it survives leaving the section.
    unmount();
    wrap(<TaskSpace teamId={TEAM_ID} client={api} />);
    await screen.findByRole('article');
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the progress scales' })).toBeTruthy();
  });

  it('narrows to one person, and to the tasks nobody is on', async () => {
    const user = userEvent.setup();
    const api = client();
    wrap(<TaskSpace teamId={TEAM_ID} client={api} />);

    await user.click(await screen.findByRole('button', { name: 'Only one person’s tasks' }));
    await user.click(screen.getByRole('option', { name: /Анна/u }));
    await waitFor(() =>
      expect(api.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: 'u-anna', unassigned: false })
      )
    );

    await user.click(screen.getByRole('button', { name: 'Only one person’s tasks' }));
    await user.click(screen.getByRole('option', { name: 'Nobody yet' }));
    await waitFor(() =>
      expect(api.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: null, unassigned: true })
      )
    );
    // The pill offers the way back out, and it is not the same as "nobody".
    expect(screen.getByRole('button', { name: 'Show everyone’s tasks' })).toBeTruthy();
  });

  it('asks the server to order by tag when the board is switched to it', async () => {
    const user = userEvent.setup();
    const api = client();
    wrap(<TaskSpace teamId={TEAM_ID} client={api} />);

    await user.click(await screen.findByRole('button', { name: 'By tag' }));
    await waitFor(() =>
      expect(api.listTasks).toHaveBeenCalledWith(expect.objectContaining({ sort: 'label' }))
    );
  });
});
