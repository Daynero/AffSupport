import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Contract tests for the accounts functions (017,
 * supabase/migrations/20260905100000_team_accounts.sql), run against a real
 * Postgres with every repository migration applied.
 *
 * They assert the guards more than the happy path: a viewer reads but cannot
 * write, a stranger sees nothing, an account cannot be named twice, an agent
 * cannot drift into another space, and a blank run is stored as no run.
 */

const OWNER = '17000000-0000-4000-8000-000000000001';
const VIEWER = '17000000-0000-4000-8000-000000000002';
const STRANGER = '17000000-0000-4000-8000-000000000003';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@accounts.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@accounts.test', displayName: 'Viewer' });
  await createUser(harness, {
    id: STRANGER,
    email: 'stranger@accounts.test',
    displayName: 'Stranger'
  });
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

async function makeAccount(teamId: string, name: string): Promise<string> {
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team_account($1, $2)',
    [teamId, name]
  );
  return rows[0]!.id;
}

type ListedAccount = {
  id: string;
  name: string;
  agents: { id: string; agent_id: string; runs: { id: string; note: string }[] }[];
};

async function list(as: string, teamId: string): Promise<ListedAccount[]> {
  return harness.asUser<ListedAccount>(as, 'select * from public.list_team_accounts($1)', [teamId]);
}

describe('accounts', () => {
  it('creates, lists with nested agents, renames and deletes', async () => {
    const teamId = await makeSpace('accounts-crud');
    const accountId = await makeAccount(teamId, '  v31 ');

    await harness.asUser(OWNER, 'select * from public.add_team_account_agent($1, $2, $3, $4)', [
      teamId,
      accountId,
      '1000098765434',
      'Pro Caps | TR 02/09'
    ]);
    await harness.asUser(OWNER, 'select * from public.add_team_account_agent($1, $2, $3)', [
      teamId,
      accountId,
      '1000098765401'
    ]);

    const listed = await list(OWNER, teamId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('v31');
    expect(
      listed[0]?.agents.map(agent => [agent.agent_id, agent.runs.map(run => run.note)])
    ).toEqual([
      ['1000098765434', ['Pro Caps | TR 02/09']],
      ['1000098765401', []]
    ]);

    const renamed = await harness.asUser<{ name: string }>(
      OWNER,
      'select name from public.rename_team_account($1, $2, $3)',
      [teamId, accountId, 'v32']
    );
    expect(renamed[0]?.name).toBe('v32');

    const deleted = await harness.asUser<{ ok: boolean }>(
      OWNER,
      'select * from public.delete_team_account($1, $2)',
      [teamId, accountId]
    );
    expect(deleted[0]?.ok).toBe(true);
    // The agents went with it.
    const agents = await harness.root(
      `select id from public.team_account_agents where account_id = $1`,
      [accountId]
    );
    expect(agents).toHaveLength(0);
  });

  it('refuses a second account with the same name, however cased', async () => {
    const teamId = await makeSpace('accounts-conflict');
    await makeAccount(teamId, 'v31');
    await expect(makeAccount(teamId, 'V31')).rejects.toThrow(/NAME_CONFLICT/);
    // The same name in another space is fine: names are per space.
    const other = await makeSpace('accounts-conflict-other');
    await expect(makeAccount(other, 'v31')).resolves.toBeTruthy();
  });

  it('refuses an empty name and one with brackets', async () => {
    const teamId = await makeSpace('accounts-invalid');
    await expect(makeAccount(teamId, '   ')).rejects.toThrow(/INVALID_INPUT/);
    await expect(makeAccount(teamId, '[v31]')).rejects.toThrow(/INVALID_INPUT/);
  });

  it('lets a viewer read but not write', async () => {
    const teamId = await makeSpace('accounts-viewer');
    const accountId = await makeAccount(teamId, 'v31');
    await expect(list(VIEWER, teamId)).resolves.toHaveLength(1);
    await expect(
      harness.asUser(VIEWER, 'select * from public.create_team_account($1, $2)', [teamId, 'v32'])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(VIEWER, 'select * from public.add_team_account_agent($1, $2, $3)', [
        teamId,
        accountId,
        '1'
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(VIEWER, 'select * from public.delete_team_account($1, $2)', [
        teamId,
        accountId
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('shows a stranger nothing, and the same answer for an absent space', async () => {
    const teamId = await makeSpace('accounts-stranger');
    await makeAccount(teamId, 'v31');
    const existing = await list(STRANGER, teamId).catch((error: unknown) => String(error));
    const absent = await list(STRANGER, '17000000-0000-4000-8000-0000000000ff').catch(
      (error: unknown) => String(error)
    );
    expect(existing).toMatch(/PERMISSION_DENIED/);
    expect(existing).toEqual(absent);
  });
});

describe('agents', () => {
  it('keeps several runs on an agent, edits and deletes them, and clears them all', async () => {
    const teamId = await makeSpace('agents-runs');
    const accountId = await makeAccount(teamId, 'v31');
    type AgentJson = { id: string; runs: { id: string; note: string }[] };
    // A blank first run is no run at all.
    const created = await harness.asUser<{ agent: AgentJson }>(
      OWNER,
      'select public.add_team_account_agent($1, $2, $3, $4) as agent',
      [teamId, accountId, '1000098765434', '   ']
    );
    const agentRowId = created[0]!.agent.id;
    expect(created[0]?.agent.runs).toEqual([]);

    const one = await harness.asUser<{ agent: AgentJson }>(
      OWNER,
      'select public.add_team_agent_run($1, $2, $3) as agent',
      [teamId, agentRowId, '  Pro Caps  |  TR 02/09 ']
    );
    expect(one[0]?.agent.runs.map(run => run.note)).toEqual(['Pro Caps | TR 02/09']);
    const two = await harness.asUser<{ agent: AgentJson }>(
      OWNER,
      'select public.add_team_agent_run($1, $2, $3) as agent',
      [teamId, agentRowId, 'Keto | PL 06/09']
    );
    expect(two[0]?.agent.runs.map(run => run.note)).toEqual([
      'Pro Caps | TR 02/09',
      'Keto | PL 06/09'
    ]);

    const runId = two[0]!.agent.runs[0]!.id;
    const edited = await harness.asUser<{ agent: AgentJson }>(
      OWNER,
      'select public.update_team_agent_run($1, $2, $3) as agent',
      [teamId, runId, 'Pro Caps | TR 03/09']
    );
    expect(edited[0]?.agent.runs[0]?.note).toBe('Pro Caps | TR 03/09');
    await expect(
      harness.asUser(OWNER, 'select public.update_team_agent_run($1, $2, $3)', [
        teamId,
        runId,
        '  '
      ])
    ).rejects.toThrow(/INVALID_INPUT/);

    const less = await harness.asUser<{ agent: AgentJson }>(
      OWNER,
      'select public.delete_team_agent_run($1, $2) as agent',
      [teamId, runId]
    );
    expect(less[0]?.agent.runs.map(run => run.note)).toEqual(['Keto | PL 06/09']);

    const freed = await harness.asUser<{ agent: AgentJson }>(
      OWNER,
      'select public.clear_team_agent_runs($1, $2) as agent',
      [teamId, agentRowId]
    );
    expect(freed[0]?.agent.runs).toEqual([]);
    // Runs go with their agent.
    await harness.asUser(OWNER, 'select public.add_team_agent_run($1, $2, $3)', [
      teamId,
      agentRowId,
      'x'
    ]);
    await harness.asUser(OWNER, 'select * from public.delete_team_account_agent($1, $2)', [
      teamId,
      agentRowId
    ]);
    const orphans = await harness.root(
      `select id from public.team_agent_runs where agent_row_id = $1`,
      [agentRowId]
    );
    expect(orphans).toHaveLength(0);
  });

  it('refuses a viewer and a foreign run', async () => {
    const teamId = await makeSpace('agents-runs-guards');
    const other = await makeSpace('agents-runs-guards-other');
    const accountId = await makeAccount(teamId, 'v31');
    const created = await harness.asUser<{ id: string }>(
      OWNER,
      "select (public.add_team_account_agent($1, $2, $3, $4)->>'id') as id",
      [teamId, accountId, '1000098765434', 'Pro Caps']
    );
    const runs = await harness.root<{ id: string }>(
      `select id from public.team_agent_runs where agent_row_id = $1`,
      [created[0]!.id]
    );
    await expect(
      harness.asUser(VIEWER, 'select public.add_team_agent_run($1, $2, $3)', [
        teamId,
        created[0]!.id,
        'x'
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(OWNER, 'select public.update_team_agent_run($1, $2, $3)', [
        other,
        runs[0]!.id,
        'x'
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    await expect(
      harness.asUser(OWNER, 'select public.delete_team_agent_run($1, $2)', [other, runs[0]!.id])
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('refuses an id with whitespace and a duplicate within the account', async () => {
    const teamId = await makeSpace('agents-invalid');
    const accountId = await makeAccount(teamId, 'v31');
    await expect(
      harness.asUser(OWNER, 'select * from public.add_team_account_agent($1, $2, $3)', [
        teamId,
        accountId,
        '1000 0987'
      ])
    ).rejects.toThrow(/INVALID_INPUT/);
    await harness.asUser(OWNER, 'select * from public.add_team_account_agent($1, $2, $3)', [
      teamId,
      accountId,
      '1000098765434'
    ]);
    await expect(
      harness.asUser(OWNER, 'select * from public.add_team_account_agent($1, $2, $3)', [
        teamId,
        accountId,
        '1000098765434'
      ])
    ).rejects.toThrow(/NAME_CONFLICT/);
    // The same id under another account of the space is allowed.
    const other = await makeAccount(teamId, 'v32');
    await expect(
      harness.asUser(OWNER, 'select * from public.add_team_account_agent($1, $2, $3)', [
        teamId,
        other,
        '1000098765434'
      ])
    ).resolves.toHaveLength(1);
  });

  it('cannot put an agent into an account of another space', async () => {
    const teamId = await makeSpace('agents-cross-a');
    const other = await makeSpace('agents-cross-b');
    const foreign = await makeAccount(other, 'v31');
    await expect(
      harness.asUser(OWNER, 'select * from public.add_team_account_agent($1, $2, $3)', [
        teamId,
        foreign,
        '1000098765434'
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    // Nor edit or delete one through the wrong space.
    const rows = await harness.asUser<{ id: string }>(
      OWNER,
      "select (public.add_team_account_agent($1, $2, $3)->>'id') as id",
      [other, foreign, '1000098765434']
    );
    await expect(
      harness.asUser(OWNER, 'select public.update_team_account_agent($1, $2, $3)', [
        teamId,
        rows[0]!.id,
        '1'
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    await expect(
      harness.asUser(OWNER, 'select * from public.delete_team_account_agent($1, $2)', [
        teamId,
        rows[0]!.id
      ])
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('deletes one agent and leaves the account', async () => {
    const teamId = await makeSpace('agents-delete');
    const accountId = await makeAccount(teamId, 'v31');
    const rows = await harness.asUser<{ id: string }>(
      OWNER,
      "select (public.add_team_account_agent($1, $2, $3)->>'id') as id",
      [teamId, accountId, '1000098765434']
    );
    const deleted = await harness.asUser<{ ok: boolean }>(
      OWNER,
      'select * from public.delete_team_account_agent($1, $2)',
      [teamId, rows[0]!.id]
    );
    expect(deleted[0]?.ok).toBe(true);
    const listed = await list(OWNER, teamId);
    expect(listed[0]?.agents).toEqual([]);
  });
});

describe('least privilege', () => {
  it('grants no direct writes on either table', async () => {
    const privileges = await harness.root<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
       from information_schema.role_table_grants
       where grantee = 'authenticated'
         and table_schema = 'public'
         and table_name in ('team_accounts', 'team_account_agents')`
    );
    expect(privileges.every(row => row.privilege_type === 'SELECT')).toBe(true);
  });

  it('keeps created_by off the viewer projection', async () => {
    const columns = await harness.root<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where grantee = 'authenticated' and table_schema = 'public'
         and table_name = 'team_accounts' and privilege_type = 'SELECT'`
    );
    expect(columns.map(row => row.column_name)).not.toContain('created_by');
  });
});

describe('tags on tasks (017, part 2)', () => {
  async function makeTask(teamId: string, title: string): Promise<string> {
    const rows = await harness.asUser<{ id: string }>(
      OWNER,
      'select id from public.create_team_task($1, $2)',
      [teamId, title]
    );
    return rows[0]!.id;
  }
  async function makeAgent(teamId: string, accountId: string, agentId: string): Promise<string> {
    const rows = await harness.asUser<{ id: string }>(
      OWNER,
      "select (public.add_team_account_agent($1, $2, $3)->>'id') as id",
      [teamId, accountId, agentId]
    );
    return rows[0]!.id;
  }
  type Tag = {
    id: string;
    agent_row_id: string;
    account_name: string;
    agent_id: string;
    runs: { id: string; note: string }[];
  };
  type TaskRow = { id: string; agents: Tag[] };

  it('tags a task, lists the tag with the task, and untags it', async () => {
    const teamId = await makeSpace('tags-crud');
    const accountId = await makeAccount(teamId, 'v31');
    const agentRowId = await makeAgent(teamId, accountId, '1000098765434');
    const taskId = await makeTask(teamId, 'Launch');

    const tagged = await harness.asUser<{ attach_team_task_agent: Tag[] }>(
      OWNER,
      'select public.attach_team_task_agent($1, $2, $3)',
      [teamId, taskId, agentRowId]
    );
    expect(tagged[0]?.attach_team_task_agent).toMatchObject([
      { agent_row_id: agentRowId, account_name: 'v31', agent_id: '1000098765434', runs: [] }
    ]);
    // Twice is once: a double press is not an error.
    const again = await harness.asUser<{ attach_team_task_agent: Tag[] }>(
      OWNER,
      'select public.attach_team_task_agent($1, $2, $3)',
      [teamId, taskId, agentRowId]
    );
    expect(again[0]?.attach_team_task_agent).toHaveLength(1);

    const listed = await harness.asUser<TaskRow>(
      OWNER,
      'select id, agents from public.list_team_tasks($1)',
      [teamId]
    );
    expect(listed.find(row => row.id === taskId)?.agents).toHaveLength(1);

    const detail = await harness.asUser<{ get_team_task: { task: { agents: Tag[] } } }>(
      OWNER,
      'select public.get_team_task($1, $2)',
      [teamId, taskId]
    );
    expect(detail[0]?.get_team_task.task.agents).toHaveLength(1);

    const untagged = await harness.asUser<{ detach_team_task_agent: Tag[] }>(
      OWNER,
      'select public.detach_team_task_agent($1, $2, $3)',
      [teamId, taskId, agentRowId]
    );
    expect(untagged[0]?.detach_team_task_agent).toEqual([]);
  });

  it('narrows the task list to one agent or one account', async () => {
    const teamId = await makeSpace('tags-scope');
    const v31 = await makeAccount(teamId, 'v31');
    const v3 = await makeAccount(teamId, 'v3');
    const a434 = await makeAgent(teamId, v31, '1000098765434');
    const a401 = await makeAgent(teamId, v31, '1000098765401');
    const a211 = await makeAgent(teamId, v3, '1000011122211');
    const first = await makeTask(teamId, 'First');
    const second = await makeTask(teamId, 'Second');
    const third = await makeTask(teamId, 'Third');
    await harness.asUser(OWNER, 'select public.attach_team_task_agent($1, $2, $3)', [
      teamId,
      first,
      a434
    ]);
    await harness.asUser(OWNER, 'select public.attach_team_task_agent($1, $2, $3)', [
      teamId,
      second,
      a401
    ]);
    await harness.asUser(OWNER, 'select public.attach_team_task_agent($1, $2, $3)', [
      teamId,
      third,
      a211
    ]);

    const byAgent = await harness.asUser<TaskRow>(
      OWNER,
      'select id, agents from public.list_team_tasks($1, p_agent => $2)',
      [teamId, a434]
    );
    expect(byAgent.map(row => row.id)).toEqual([first]);
    const byAccount = await harness.asUser<TaskRow>(
      OWNER,
      'select id, agents from public.list_team_tasks($1, p_account => $2)',
      [teamId, v31]
    );
    expect(byAccount.map(row => row.id).sort()).toEqual([first, second].sort());
    const all = await harness.asUser<TaskRow>(
      OWNER,
      'select id, agents from public.list_team_tasks($1)',
      [teamId]
    );
    expect(all).toHaveLength(3);

    // The accounts list counts the tasks per agent.
    const accounts = await list(OWNER, teamId);
    const agents = accounts.flatMap(account => account.agents) as unknown as {
      id: string;
      task_count: number;
    }[];
    expect(agents.find(agent => agent.id === a434)?.task_count).toBe(1);
    expect(agents.find(agent => agent.id === a401)?.task_count).toBe(1);
  });

  it('follows a rename and drops the tag with the agent', async () => {
    const teamId = await makeSpace('tags-derived');
    const accountId = await makeAccount(teamId, 'v31');
    const agentRowId = await makeAgent(teamId, accountId, '1000098765434');
    const taskId = await makeTask(teamId, 'Launch');
    await harness.asUser(OWNER, 'select public.attach_team_task_agent($1, $2, $3)', [
      teamId,
      taskId,
      agentRowId
    ]);

    await harness.asUser(OWNER, 'select * from public.rename_team_account($1, $2, $3)', [
      teamId,
      accountId,
      'v32'
    ]);
    let listed = await harness.asUser<TaskRow>(
      OWNER,
      'select id, agents from public.list_team_tasks($1)',
      [teamId]
    );
    expect(listed[0]?.agents[0]?.account_name).toBe('v32');

    await harness.asUser(OWNER, 'select * from public.delete_team_account_agent($1, $2)', [
      teamId,
      agentRowId
    ]);
    listed = await harness.asUser<TaskRow>(
      OWNER,
      'select id, agents from public.list_team_tasks($1)',
      [teamId]
    );
    expect(listed[0]?.agents).toEqual([]);
  });

  it('refuses a viewer, a foreign agent and a foreign task', async () => {
    const teamId = await makeSpace('tags-guards');
    const other = await makeSpace('tags-guards-other');
    const accountId = await makeAccount(teamId, 'v31');
    const agentRowId = await makeAgent(teamId, accountId, '1000098765434');
    const taskId = await makeTask(teamId, 'Launch');
    const foreignAccount = await makeAccount(other, 'v31');
    const foreignAgent = await makeAgent(other, foreignAccount, '1000098765434');

    await expect(
      harness.asUser(VIEWER, 'select public.attach_team_task_agent($1, $2, $3)', [
        teamId,
        taskId,
        agentRowId
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(OWNER, 'select public.attach_team_task_agent($1, $2, $3)', [
        teamId,
        taskId,
        foreignAgent
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    await expect(
      harness.asUser(OWNER, 'select public.attach_team_task_agent($1, $2, $3)', [
        other,
        taskId,
        foreignAgent
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    // A viewer still reads the tags.
    const listed = await harness.asUser<TaskRow>(
      VIEWER,
      'select id, agents from public.list_team_tasks($1)',
      [teamId]
    );
    expect(listed).toHaveLength(1);
  });
});
