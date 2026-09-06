import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Contract tests for the task-tag functions (018,
 * supabase/migrations/20260906200000_tasks_carry_tags.sql), run against a real
 * Postgres with every repository migration applied.
 *
 * They assert the guards and the two things the board depends on and cannot
 * see for itself: that the filter keeps a task carrying *any* of the chosen
 * tags, and that ordering by tag pages correctly — a cursor that walks the
 * wrong tuple loses tasks silently, which is the one failure a board cannot
 * show anybody.
 */

const OWNER = '18000000-0000-4000-8000-000000000001';
const VIEWER = '18000000-0000-4000-8000-000000000002';
const STRANGER = '18000000-0000-4000-8000-000000000003';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@tags.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@tags.test', displayName: 'Viewer' });
  await createUser(harness, { id: STRANGER, email: 'stranger@tags.test', displayName: 'Stranger' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function makeSpace(name: string): Promise<string> {
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    [name]
  );
  const teamId = rows[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer')`,
    [teamId, VIEWER]
  );
  return teamId;
}

async function makeTag(teamId: string, name: string, color = 'purple'): Promise<string> {
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team_label($1, $2, $3)',
    [teamId, name, color]
  );
  return rows[0]!.id;
}

async function makeTask(teamId: string, title: string): Promise<string> {
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team_task($1, $2)',
    [teamId, title]
  );
  return rows[0]!.id;
}

type ListedTag = { id: string; name: string; color: string; usage_count: string | number };
type ListedTask = { id: string; title: string; labels: { id: string; name: string }[] };

async function listTags(as: string, teamId: string): Promise<ListedTag[]> {
  return harness.asUser<ListedTag>(as, 'select * from public.list_team_labels($1)', [teamId]);
}

async function listTasks(
  teamId: string,
  options: {
    labels?: string[];
    sort?: string;
    cursor?: string;
    pageSize?: number;
    assignee?: string;
    unassigned?: boolean;
  } = {}
): Promise<ListedTask[]> {
  return harness.asUser<ListedTask>(
    OWNER,
    `select id, title, labels, assignee_id from public.list_team_tasks(
       $1, null, null, $2, $3, null, null, null, null, null, $4, $5, $6, $7
     )`,
    [
      teamId,
      options.cursor ?? null,
      options.pageSize ?? 50,
      options.labels ?? null,
      options.sort ?? 'date',
      options.assignee ?? null,
      options.unassigned ?? false
    ]
  );
}

describe('the tag dictionary', () => {
  it('creates, lists with a count, renames, recolours and deletes', async () => {
    const teamId = await makeSpace('tags-crud');
    const tagId = await makeTag(teamId, '  Hot  ', 'red');
    const taskId = await makeTask(teamId, 'A task');
    await harness.asUser(OWNER, 'select public.attach_team_task_label($1, $2, $3)', [
      teamId,
      taskId,
      tagId
    ]);

    const listed = await listTags(OWNER, teamId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('Hot');
    expect(listed[0]?.color).toBe('red');
    expect(Number(listed[0]?.usage_count)).toBe(1);

    const updated = await harness.asUser<{ name: string; color: string }>(
      OWNER,
      'select name, color from public.update_team_label($1, $2, $3, $4)',
      [teamId, tagId, 'Warm', 'honey']
    );
    expect(updated[0]).toEqual({ name: 'Warm', color: 'honey' });
    // A rename reaches the task without touching the link.
    const afterRename = await listTasks(teamId);
    expect(afterRename[0]?.labels.map(label => label.name)).toEqual(['Warm']);

    const deleted = await harness.asUser<{ ok: boolean }>(
      OWNER,
      'select * from public.delete_team_label($1, $2)',
      [teamId, tagId]
    );
    expect(deleted[0]?.ok).toBe(true);
    // The tag left the task; the task itself stayed.
    const afterDelete = await listTasks(teamId);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.labels).toEqual([]);
  });

  it('refuses a second tag with the same name, however cased', async () => {
    const teamId = await makeSpace('tags-conflict');
    await makeTag(teamId, 'UGC');
    await expect(makeTag(teamId, 'ugc')).rejects.toThrow(/NAME_CONFLICT/);
    const other = await makeSpace('tags-conflict-other');
    await expect(makeTag(other, 'UGC')).resolves.toBeTruthy();
  });

  it('refuses a blank name, a name over the length, and a colour it does not know', async () => {
    const teamId = await makeSpace('tags-invalid');
    await expect(makeTag(teamId, '   ')).rejects.toThrow(/INVALID_INPUT/);
    await expect(makeTag(teamId, 'x'.repeat(25))).rejects.toThrow(/INVALID_INPUT/);
    await expect(makeTag(teamId, 'Fine', 'chartreuse')).rejects.toThrow(/INVALID_INPUT/);
  });

  it('stops at the cap, with a code the interface has a sentence for', async () => {
    const teamId = await makeSpace('tags-cap');
    for (let index = 0; index < 60; index += 1) await makeTag(teamId, `Tag ${index}`);
    // Not a bespoke code: an unregistered one would reach the person as
    // "something went wrong".
    await expect(makeTag(teamId, 'One too many')).rejects.toThrow(/WRONG_STATE/);
  }, 30_000);

  it('lets a viewer read but not write, and shows a stranger nothing', async () => {
    const teamId = await makeSpace('tags-permissions');
    const tagId = await makeTag(teamId, 'Hot');
    const taskId = await makeTask(teamId, 'A task');
    await expect(listTags(VIEWER, teamId)).resolves.toHaveLength(1);
    await expect(
      harness.asUser(VIEWER, 'select * from public.create_team_label($1, $2, $3)', [
        teamId,
        'Cold',
        'blue'
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(VIEWER, 'select public.attach_team_task_label($1, $2, $3)', [
        teamId,
        taskId,
        tagId
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(VIEWER, 'select * from public.delete_team_label($1, $2)', [teamId, tagId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(listTags(STRANGER, teamId)).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('cannot hang another space’s tag on a task', async () => {
    const teamId = await makeSpace('tags-isolation');
    const other = await makeSpace('tags-isolation-other');
    const foreign = await makeTag(other, 'Foreign');
    const taskId = await makeTask(teamId, 'A task');
    await expect(
      harness.asUser(OWNER, 'select public.attach_team_task_label($1, $2, $3)', [
        teamId,
        taskId,
        foreign
      ])
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('tags on a task', () => {
  it('is idempotent, detaches, and returns the whole list each time', async () => {
    const teamId = await makeSpace('tags-links');
    const hot = await makeTag(teamId, 'Hot');
    const ugc = await makeTag(teamId, 'UGC');
    const taskId = await makeTask(teamId, 'A task');

    const attach = async (labelId: string) =>
      (
        await harness.asUser<{ labels: { name: string }[] }>(
          OWNER,
          'select public.attach_team_task_label($1, $2, $3) as labels',
          [teamId, taskId, labelId]
        )
      )[0]!.labels.map(label => label.name);

    expect(await attach(hot)).toEqual(['Hot']);
    // Pressing twice is the same tag, not an error.
    expect(await attach(hot)).toEqual(['Hot']);
    expect(await attach(ugc)).toEqual(['Hot', 'UGC']);

    const detached = await harness.asUser<{ labels: { name: string }[] }>(
      OWNER,
      'select public.detach_team_task_label($1, $2, $3) as labels',
      [teamId, taskId, hot]
    );
    expect(detached[0]?.labels.map(label => label.name)).toEqual(['UGC']);
  });

  it('does not touch the task itself, so tagging cannot lose an edit', async () => {
    const teamId = await makeSpace('tags-no-bump');
    const tagId = await makeTag(teamId, 'Hot');
    const taskId = await makeTask(teamId, 'A task');
    const before = await harness.root<{ updated_at: string }>(
      'select updated_at from public.team_tasks where id = $1',
      [taskId]
    );
    await harness.asUser(OWNER, 'select public.attach_team_task_label($1, $2, $3)', [
      teamId,
      taskId,
      tagId
    ]);
    const after = await harness.root<{ updated_at: string }>(
      'select updated_at from public.team_tasks where id = $1',
      [taskId]
    );
    expect(after[0]?.updated_at).toEqual(before[0]?.updated_at);
  });
});

describe('the board', () => {
  it('keeps the tasks carrying any of the chosen tags', async () => {
    const teamId = await makeSpace('tags-filter');
    const hot = await makeTag(teamId, 'Hot');
    const ugc = await makeTag(teamId, 'UGC');
    const hotTask = await makeTask(teamId, 'Hot one');
    const ugcTask = await makeTask(teamId, 'UGC one');
    await makeTask(teamId, 'Untagged one');
    await harness.asUser(OWNER, 'select public.attach_team_task_label($1, $2, $3)', [
      teamId,
      hotTask,
      hot
    ]);
    await harness.asUser(OWNER, 'select public.attach_team_task_label($1, $2, $3)', [
      teamId,
      ugcTask,
      ugc
    ]);

    expect((await listTasks(teamId, { labels: [hot] })).map(task => task.title)).toEqual([
      'Hot one'
    ]);
    const either = await listTasks(teamId, { labels: [hot, ugc] });
    expect(either.map(task => task.title).sort()).toEqual(['Hot one', 'UGC one']);
    expect(await listTasks(teamId, { labels: [] }).catch(String)).toMatch(/INVALID_INPUT/);
  });

  it('orders by tag, puts the untagged last, and pages without losing a task', async () => {
    const teamId = await makeSpace('tags-order');
    const alpha = await makeTag(teamId, 'Alpha');
    const beta = await makeTag(teamId, 'Beta');
    const titles = ['a1', 'a2', 'b1', 'none1', 'none2'];
    const tasks: Record<string, string> = {};
    for (const title of titles) tasks[title] = await makeTask(teamId, title);
    for (const [title, tagId] of [
      ['a1', alpha],
      ['a2', alpha],
      ['b1', beta]
    ] as const) {
      await harness.asUser(OWNER, 'select public.attach_team_task_label($1, $2, $3)', [
        teamId,
        tasks[title],
        tagId
      ]);
    }

    const ordered = await listTasks(teamId, { sort: 'label' });
    // Alpha's two first (newest of them first), then Beta's, then the untagged.
    expect(ordered.map(task => task.title)).toEqual(['a2', 'a1', 'b1', 'none2', 'none1']);

    // The same order walked two at a time: every task appears exactly once.
    const paged: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const rows = await listTasks(teamId, { sort: 'label', pageSize: 2, cursor });
      if (rows.length === 0) break;
      paged.push(...rows.map(task => task.title));
      cursor = rows.at(-1)!.id;
    }
    expect(paged).toEqual(ordered.map(task => task.title));
  });

  it('narrows to one person, and to the tasks nobody is on', async () => {
    const teamId = await makeSpace('tasks-assignee');
    const mine = await makeTask(teamId, 'Mine');
    const theirs = await makeTask(teamId, 'Theirs');
    await makeTask(teamId, 'Nobody\u2019s');
    await harness.asUser(OWNER, `select public.update_team_task($1, $2, $3::jsonb)`, [
      teamId,
      mine,
      JSON.stringify({ assigneeId: OWNER })
    ]);
    await harness.asUser(OWNER, `select public.update_team_task($1, $2, $3::jsonb)`, [
      teamId,
      theirs,
      JSON.stringify({ assigneeId: VIEWER })
    ]);

    expect((await listTasks(teamId, { assignee: OWNER })).map(task => task.title)).toEqual([
      'Mine'
    ]);
    expect((await listTasks(teamId, { assignee: VIEWER })).map(task => task.title)).toEqual([
      'Theirs'
    ]);
    expect((await listTasks(teamId, { unassigned: true })).map(task => task.title)).toEqual([
      'Nobody\u2019s'
    ]);
    // One person or nobody: asking for both is asking for nothing.
    await expect(listTasks(teamId, { assignee: OWNER, unassigned: true })).rejects.toThrow(
      /INVALID_INPUT/
    );
  });

  it('refuses an order it does not know', async () => {
    const teamId = await makeSpace('tags-order-invalid');
    await expect(listTasks(teamId, { sort: 'colour' })).rejects.toThrow(/INVALID_INPUT/);
  });
});
