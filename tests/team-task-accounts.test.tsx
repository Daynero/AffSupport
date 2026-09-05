// @vitest-environment jsdom
import React from 'react';
import { cleanup, render as renderRaw, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type TeamAccountSummary,
  type TeamTaskAgentTag,
  type TeamTaskSummary
} from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskCard } from '../apps/web/src/team/tasks/TaskCard';
import { TaskEditor, type TaskEditorClient } from '../apps/web/src/team/tasks/TaskEditor';
import { TaskSpace, type TaskSpaceClient } from '../apps/web/src/team/tasks/TaskSpace';

/**
 * Accounts inside tasks (017, part 2): the tag row on a card, the picker and
 * the chip panel in the editor, the account scope of the list, against a
 * stubbed client.
 */

const TEAM_ID = '17000000-0000-4000-8000-000000000020';
const TASK_ID = '17000000-0000-4000-8000-000000000021';
const V31 = '17000000-0000-4000-8000-000000000031';
const V3 = '17000000-0000-4000-8000-000000000003';
const A434 = '17000000-0000-4000-8000-000000000434';
const A401 = '17000000-0000-4000-8000-000000000401';
const A211 = '17000000-0000-4000-8000-000000000211';
const STAMP = '2026-09-05T10:00:00.000Z';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function agent(id: string, accountId: string, agentId: string, note: string | null) {
  return {
    id,
    accountId,
    teamId: TEAM_ID,
    agentId,
    runs: note === null ? [] : [{ id: `${id}-run1`, note, createdAt: STAMP }],
    taskCount: 0,
    createdAt: STAMP,
    updatedAt: STAMP
  };
}

function accounts(): TeamAccountSummary[] {
  return [
    {
      id: V31,
      teamId: TEAM_ID,
      name: 'v31',
      createdAt: STAMP,
      updatedAt: STAMP,
      agents: [
        agent(A434, V31, '1000098765434', 'Pro Caps | TR 02/09'),
        agent(A401, V31, '1000098765401', null)
      ]
    },
    {
      id: V3,
      teamId: TEAM_ID,
      name: 'v3',
      createdAt: STAMP,
      updatedAt: STAMP,
      agents: [agent(A211, V3, '1000011122211', null)]
    }
  ];
}

function tagFor(agentRowId: string): TeamTaskAgentTag {
  for (const account of accounts()) {
    const found = account.agents.find(item => item.id === agentRowId);
    if (found) {
      return {
        id: `link-${agentRowId.slice(-3)}`,
        agentRowId,
        accountId: account.id,
        accountName: account.name,
        agentId: found.agentId,
        runs: found.runs
      };
    }
  }
  throw new Error(`no agent ${agentRowId}`);
}

function task(agents: TeamTaskAgentTag[] = []): TeamTaskSummary {
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
    agents,
    createdBy: '17000000-0000-4000-8000-000000000099',
    createdAt: STAMP,
    updatedAt: STAMP,
    completedAt: null
  };
}

/** A client whose tag state lives in a closure, so attach/detach round-trip. */
function client(
  initial: TeamTaskAgentTag[] = []
): TaskSpaceClient & { tags: () => TeamTaskAgentTag[] } {
  let tags = initial;
  const current = () => task(tags);
  return {
    tags: () => tags,
    listTasks: vi.fn(async () => [current()]),
    createTask: vi.fn(async () => current()),
    updateTask: vi.fn(async () => current()),
    getTask: vi.fn(async () => ({ task: current(), attachments: [] })),
    detachTaskMaterial: vi.fn().mockResolvedValue(true),
    attachTaskMaterials: vi
      .fn()
      .mockResolvedValue({ attached: [], alreadyAttached: [], rejected: [] }),
    listFolderPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listMembers: vi.fn().mockResolvedValue([]),
    deleteTask: vi.fn().mockResolvedValue(true),
    listAccounts: vi.fn(async () => accounts()),
    attachTaskAgent: vi.fn(async ({ agentRowId }) => {
      if (!tags.some(tag => tag.agentRowId === agentRowId)) tags = [...tags, tagFor(agentRowId)];
      return tags;
    }),
    detachTaskAgent: vi.fn(async ({ agentRowId }) => {
      tags = tags.filter(tag => tag.agentRowId !== agentRowId);
      return tags;
    }),
    // Runs live in the closure, so add / edit / delete round-trip through the tags.
    addAgentRun: vi.fn(async ({ agentRowId, note }) => {
      const tag = tags.find(item => item.agentRowId === agentRowId)!;
      const runs = [
        ...tag.runs,
        { id: `${agentRowId}-run${tag.runs.length + 1}`, note, createdAt: STAMP }
      ];
      tags = tags.map(item => (item.agentRowId === agentRowId ? { ...item, runs } : item));
      return { ...agent(agentRowId, tag.accountId, tag.agentId, null), runs };
    }),
    updateAgentRun: vi.fn(async ({ runId, note }) => {
      const tag = tags.find(item => item.runs.some(run => run.id === runId))!;
      const runs = tag.runs.map(run => (run.id === runId ? { ...run, note } : run));
      tags = tags.map(item => (item.id === tag.id ? { ...item, runs } : item));
      return { ...agent(tag.agentRowId, tag.accountId, tag.agentId, null), runs };
    }),
    deleteAgentRun: vi.fn(async ({ runId }) => {
      const tag = tags.find(item => item.runs.some(run => run.id === runId))!;
      const runs = tag.runs.filter(run => run.id !== runId);
      tags = tags.map(item => (item.id === tag.id ? { ...item, runs } : item));
      return { ...agent(tag.agentRowId, tag.accountId, tag.agentId, null), runs };
    }),
    // Attachment tiles reach for these only when a tile is rendered; none is here.
    issueDownloadGrant: vi.fn(),
    thumbnailUrl: vi.fn()
  } as unknown as TaskSpaceClient & { tags: () => TeamTaskAgentTag[] };
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

describe('a card', () => {
  it('folds a long brief behind "More" and unfolds it in place without opening the task', async () => {
    // jsdom has no layout: stand in for a clamped paragraph by hand.
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(150);
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const long = {
      ...task(),
      note: Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n')
    };
    wrap(<TaskCard task={long} canEdit onOpen={onOpen} onUpdate={vi.fn()} />);

    const more = await screen.findByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    expect(screen.getByRole('button', { name: 'Less' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('article').classList.contains('is-expanded')).toBe(true);
    // The fold is the card's own control: pressing it did not open the editor.
    expect(onOpen).not.toHaveBeenCalled();
    scroll.mockRestore();
    client.mockRestore();
  });

  it('folds the accounts past the second into a "+N" chip that names the rest', () => {
    wrap(
      <TaskCard
        task={task([tagFor(A434), tagFor(A401), tagFor(A211)])}
        canEdit
        onOpen={() => {}}
        onUpdate={vi.fn()}
      />
    );
    const row = screen.getByLabelText('Accounts');
    expect(row.querySelectorAll('.team-task-agent-chip:not(.is-more)')).toHaveLength(2);
    expect(row.querySelector('.is-more')?.textContent).toBe('+1');
    expect(row.querySelector('.is-more')?.getAttribute('aria-label')).toBe('v31-434');
  });

  it('shows the tags with the agent state, and nothing when there are none', () => {
    const tagged = task([tagFor(A434), tagFor(A401)]);
    const { unmount } = wrap(
      <TaskCard task={tagged} canEdit onOpen={() => {}} onUpdate={vi.fn()} />
    );
    const row = screen.getByLabelText('Accounts');
    expect(row.textContent).toBe('v31-401v31-434');
    // Natural order: …401 before …434; the free one is marked, the busy one names its run.
    const chips = row.querySelectorAll('.team-task-agent-chip');
    expect(chips[0]?.classList.contains('is-free')).toBe(true);
    expect(chips[1]?.classList.contains('is-free')).toBe(false);
    // The tooltip spells out what the chip abbreviates: account, full id, runs.
    expect(chips[1]?.getAttribute('title')).toBe(
      'Account: v31\nID: 1000098765434\nRun: Pro Caps | TR 02/09'
    );
    unmount();

    wrap(<TaskCard task={task()} canEdit onOpen={() => {}} onUpdate={vi.fn()} />);
    expect(screen.queryByLabelText('Accounts')).toBeNull();
  });
});

describe('the editor', () => {
  function openEditor(api: TaskEditorClient, tags: TeamTaskAgentTag[] = []) {
    const onTagsChange = vi.fn();
    wrap(
      <TaskEditor
        teamId={TEAM_ID}
        task={task(tags)}
        members={[]}
        canEdit
        client={api}
        onClose={() => {}}
        onChanged={() => {}}
        onTagsChange={onTagsChange}
      />
    );
    return onTagsChange;
  }

  it('tags a task through the picker: account, then agents, one press', async () => {
    const api = client();
    const user = userEvent.setup();
    const onTagsChange = openEditor(api);
    expect(screen.getByText('No account yet')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Account' });
    // Step one: the accounts with what is inside them.
    // By the name element, not a text prefix: "v3" + "1 agent" also reads "v31…".
    const v31Row = within(dialog).getByText('v31', { selector: 'strong' }).closest('button')!;
    expect(v31Row.textContent).toContain('2 agents');
    expect(v31Row.textContent).toContain('1 free');
    await user.click(v31Row);

    // Step two: the agents, free ones marked; "Free" narrows to them.
    expect(within(dialog).getByText('v31-434')).toBeTruthy();
    expect(within(dialog).getByText('v31-401')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Free' }));
    expect(within(dialog).queryByText('v31-434')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /v31-401/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Tag (1)' }));

    await waitFor(() =>
      expect(api.attachTaskAgent).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        taskId: TASK_ID,
        agentRowId: A401
      })
    );
    await waitFor(() => expect(onTagsChange).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /^v31-401/ })).toBeTruthy();
  });

  it('adds a run prefilled with the task title, from the chip', async () => {
    const api = client([tagFor(A401)]);
    const user = userEvent.setup();
    openEditor(api, [tagFor(A401)]);

    await user.click(screen.getByRole('button', { name: /^v31-401/ }));
    expect(screen.getByText('This agent is free.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add a run' }));
    const field = screen.getByRole('textbox', { name: 'Run to write onto the agent' });
    // Prefilled with the task's title: that is usually what launched.
    expect((field as HTMLInputElement).value).toBe('Pro Caps | TR 05/09');
    expect(document.activeElement).toBe(field);
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(api.addAgentRun).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        agentRowId: A401,
        note: 'Pro Caps | TR 05/09'
      })
    );
    await waitFor(() => expect(screen.getByText('Runs:')).toBeTruthy());
    expect(screen.getByText('Run written onto v31-401')).toBeTruthy();
    // The chip's dot follows: no longer free.
    expect(screen.getByRole('button', { name: /^v31-401/ }).classList.contains('is-free')).toBe(
      false
    );
    // Focus goes back to the plus that opened the field.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a run' }))
    );
  });

  it('lists several runs, edits one with the pencil, deletes one with the bin (undo)', async () => {
    const api = client([tagFor(A434)]);
    const user = userEvent.setup();
    openEditor(api, [tagFor(A434)]);
    await user.click(screen.getByRole('button', { name: /^v31-434/ }));
    const panel = screen.getByRole('region', { name: 'v31-434' });
    expect(within(panel).getByText('Pro Caps | TR 02/09')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'Add a run' }));
    const field = screen.getByRole('textbox', { name: 'Run to write onto the agent' });
    await user.clear(field);
    await user.type(field, 'Keto | PL 06/09{Enter}');
    await waitFor(() => expect(within(panel).getByText('Keto | PL 06/09')).toBeTruthy());
    expect(within(panel).getByText('Pro Caps | TR 02/09')).toBeTruthy();

    await user.click(
      within(panel).getByRole('button', { name: 'Edit the run: Pro Caps | TR 02/09' })
    );
    const edit = screen.getByRole('textbox', { name: 'Run to write onto the agent' });
    expect((edit as HTMLInputElement).value).toBe('Pro Caps | TR 02/09');
    await user.clear(edit);
    await user.type(edit, 'Pro Caps | TR 03/09{Enter}');
    await waitFor(() =>
      expect(api.updateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'Pro Caps | TR 03/09' })
      )
    );
    await waitFor(() => expect(within(panel).getByText('Pro Caps | TR 03/09')).toBeTruthy());

    await user.click(
      within(panel).getByRole('button', { name: 'Delete the run: Keto | PL 06/09' })
    );
    await waitFor(() => expect(within(panel).queryByText('Keto | PL 06/09')).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(within(panel).getByText('Keto | PL 06/09')).toBeTruthy());
  });

  it('removes a tag from the panel with undo, without saving the form', async () => {
    const api = client([tagFor(A434)]);
    const user = userEvent.setup();
    openEditor(api, [tagFor(A434)]);

    await user.click(screen.getByRole('button', { name: /^v31-434/ }));
    await user.click(screen.getByRole('button', { name: 'Remove from the task' }));
    await waitFor(() =>
      expect(api.detachTaskAgent).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        taskId: TASK_ID,
        agentRowId: A434
      })
    );
    expect(screen.queryByRole('button', { name: /^v31-434/ })).toBeNull();
    // Removing a tag is not saving the form: the editor stays open, untouched.
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeTruthy();
    expect(api.updateTask).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^v31-434/ })).toBeTruthy());
  });

  it('closes the run field on Escape without closing the editor', async () => {
    const api = client([tagFor(A401)]);
    const user = userEvent.setup();
    openEditor(api, [tagFor(A401)]);
    await user.click(screen.getByRole('button', { name: /^v31-401/ }));
    await user.click(screen.getByRole('button', { name: 'Add a run' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Run to write onto the agent' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeTruthy();
    expect(api.addAgentRun).not.toHaveBeenCalled();
    // Focus goes back to the button that opened the field.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a run' }))
    );
  });

  it('does not let a slow first read wipe what was typed meanwhile', async () => {
    const api = client();
    let release: (() => void) | null = null;
    // The read resolves only when the test says so — the slow backend.
    api.getTask = vi.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve({ task: task(), attachments: [] });
        })
    );
    const user = userEvent.setup();
    openEditor(api);
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Keto | PL 07/09');
    release!();
    // The server's copy arrives after the typing: the typing wins.
    await waitFor(() => expect(api.getTask).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((title as HTMLInputElement).value).toBe('Keto | PL 07/09');
  });

  it('names the agent the panel is about', async () => {
    const api = client([tagFor(A434), tagFor(A401)]);
    const user = userEvent.setup();
    openEditor(api, [tagFor(A434), tagFor(A401)]);
    await user.click(screen.getByRole('button', { name: /^v31-401/ }));
    const panel = screen.getByRole('region', { name: 'v31-401' });
    expect(within(panel).getByText('v31-401')).toBeTruthy();
    expect(within(panel).getByText('This agent is free.')).toBeTruthy();
  });

  it('offers the Free switch before an account is opened and drops fully busy accounts', async () => {
    const api = client();
    const user = userEvent.setup();
    openEditor(api);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Account' });
    await user.click(within(dialog).getByRole('button', { name: 'Free' }));
    // v31 has a free agent, v3 has one too — both stay; a fully busy one would go.
    expect(within(dialog).getByText('v31', { selector: 'strong' })).toBeTruthy();
    expect(within(dialog).getByText('v3', { selector: 'strong' })).toBeTruthy();
  });

  it('shows a viewer the tags and none of the controls', () => {
    const api = client([tagFor(A434)]);
    wrap(
      <TaskEditor
        teamId={TEAM_ID}
        task={task([tagFor(A434)])}
        members={[]}
        canEdit={false}
        client={api}
        onClose={() => {}}
        onChanged={() => {}}
      />,
      'viewer'
    );
    expect(screen.getByText('v31-434')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Account' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^v31-434/ })).toBeNull();
  });
});

describe('the list', () => {
  it('narrows to an agent through the filter and reports the scope', async () => {
    const api = client([tagFor(A434)]);
    const user = userEvent.setup();
    const onScopeChange = vi.fn();
    wrap(
      <TaskSpace
        teamId={TEAM_ID}
        client={api}
        scope={{ kind: 'all' }}
        onScopeChange={onScopeChange}
      />
    );
    await screen.findByText('v31-434');
    await user.click(
      await screen.findByRole('button', { name: 'Only tasks of an account or agent' })
    );
    const list = screen.getByRole('listbox');
    expect(within(list).getByRole('option', { name: 'v31' })).toBeTruthy();
    await user.click(within(list).getByRole('option', { name: /v31-434/ }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'agent', agentRowId: A434 });
  });

  it('asks the server for the scoped page and names the scope on the pill', async () => {
    const api = client([tagFor(A434)]);
    wrap(
      <TaskSpace
        teamId={TEAM_ID}
        client={api}
        scope={{ kind: 'agent', agentRowId: A434 }}
        onScopeChange={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(api.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ agentRowId: A434, accountId: null })
      )
    );
    const pill = await screen.findByRole('button', { name: 'Only tasks of an account or agent' });
    await waitFor(() => expect(pill.textContent).toBe('v31-434'));
    expect(screen.getByRole('button', { name: 'Show every account' })).toBeTruthy();
  });
});
