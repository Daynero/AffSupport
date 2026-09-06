import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Contract tests for the money and agent tags on an agent (019,
 * supabase/migrations/20260906220000_agents_carry_money_and_tags.sql), against
 * a real Postgres with every repository migration applied.
 *
 * The one that matters most is the clear: it returns what the top-ups *were*,
 * and an implementation built on `RETURNING` would hand back the nulls it had
 * just written — an undo that restores nothing and says it worked.
 */

const OWNER = '19000000-0000-4000-8000-000000000001';
const VIEWER = '19000000-0000-4000-8000-000000000002';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@money.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@money.test', displayName: 'Viewer' });
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

async function makeAgent(teamId: string, accountName: string, agentId: string): Promise<string> {
  const account = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team_account($1, $2)',
    [teamId, accountName]
  );
  // The write returns the agent as JSON (017 part 3), not as a row.
  const agent = await harness.asUser<{ id: string }>(
    OWNER,
    `select public.add_team_account_agent($1, $2, $3) ->> 'id' as id`,
    [teamId, account[0]!.id, agentId]
  );
  return agent[0]!.id;
}

type AgentJson = {
  id: string;
  balance: number | null;
  topup: number | null;
  labels: { id: string; name: string; color: string }[];
};

async function setMoney(
  teamId: string,
  agentRowId: string,
  balance: number | null,
  topup: number | null
): Promise<AgentJson> {
  const rows = await harness.asUser<{ agent: AgentJson }>(
    OWNER,
    'select public.set_team_agent_money($1, $2, $3, $4) as agent',
    [teamId, agentRowId, balance, topup]
  );
  return rows[0]!.agent;
}

describe('the money on an agent', () => {
  it('writes both figures, clears them with null, and refuses one out of range', async () => {
    const teamId = await makeSpace('money-basics');
    const agentRowId = await makeAgent(teamId, 'v31', '1000098765434');

    expect(await setMoney(teamId, agentRowId, 120, 50)).toMatchObject({ balance: 120, topup: 50 });
    expect(await setMoney(teamId, agentRowId, null, null)).toMatchObject({
      balance: null,
      topup: null
    });
    await expect(setMoney(teamId, agentRowId, 10_000, null)).rejects.toThrow(/INVALID_INPUT|22023/);
    await expect(setMoney(teamId, agentRowId, -1, null)).rejects.toThrow(/INVALID_INPUT|22023/);
  });

  it('lets a viewer read the figures and not write them', async () => {
    const teamId = await makeSpace('money-viewer');
    const agentRowId = await makeAgent(teamId, 'v31', '1000098765434');
    await setMoney(teamId, agentRowId, 100, 50);

    const seen = await harness.asUser<{ balance: number; topup: number }>(
      VIEWER,
      `select (agents -> 0 ->> 'balance')::int as balance, (agents -> 0 ->> 'topup')::int as topup
       from public.list_team_accounts($1)`,
      [teamId]
    );
    expect(seen[0]).toEqual({ balance: 100, topup: 50 });
    await expect(
      harness.asUser(VIEWER, 'select public.set_team_agent_money($1, $2, $3, $4)', [
        teamId,
        agentRowId,
        0,
        0
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('clears every top-up at once and hands back what they were', async () => {
    const teamId = await makeSpace('money-clear');
    const first = await makeAgent(teamId, 'v31', '1000098765434');
    const second = await makeAgent(teamId, 'f40', '1000011122117');
    await setMoney(teamId, first, 300, 50);
    await setMoney(teamId, second, 90, 150);

    const cleared = await harness.asUser<{ agent_row_id: string; topup: number }>(
      OWNER,
      'select * from public.clear_team_agent_topups($1)',
      [teamId]
    );
    expect(cleared).toHaveLength(2);
    expect(new Map(cleared.map(row => [row.agent_row_id, row.topup]))).toEqual(
      new Map([
        [first, 50],
        [second, 150]
      ])
    );

    // The balances are untouched: only what was owed is gone.
    const after = await harness.root<{ balance: number | null; topup: number | null }>(
      'select balance, topup from public.team_account_agents where team_id = $1 order by agent_id',
      [teamId]
    );
    expect(after.map(row => row.topup)).toEqual([null, null]);
    expect(after.every(row => row.balance !== null)).toBe(true);

    // A second press is not an error, and says nothing was there.
    const again = await harness.asUser(OWNER, 'select * from public.clear_team_agent_topups($1)', [
      teamId
    ]);
    expect(again).toHaveLength(0);
  });

  it('clears the balances on their own, and hands back what they were', async () => {
    const teamId = await makeSpace('money-clear-balances');
    const first = await makeAgent(teamId, 'v31', '1000098765434');
    const second = await makeAgent(teamId, 'f40', '1000011122117');
    await setMoney(teamId, first, 300, 50);
    await setMoney(teamId, second, 90, null);

    const cleared = await harness.asUser<{ agent_row_id: string; balance: number }>(
      OWNER,
      'select * from public.clear_team_agent_balances($1)',
      [teamId]
    );
    expect(new Map(cleared.map(row => [row.agent_row_id, row.balance]))).toEqual(
      new Map([
        [first, 300],
        [second, 90]
      ])
    );

    // The top-ups stayed: the two figures are cleared for different reasons.
    const after = await harness.root<{ balance: number | null; topup: number | null }>(
      'select balance, topup from public.team_account_agents where team_id = $1 order by agent_id',
      [teamId]
    );
    expect(after.map(row => row.balance)).toEqual([null, null]);
    expect(after.some(row => row.topup === 50)).toBe(true);

    const again = await harness.asUser(
      OWNER,
      'select * from public.clear_team_agent_balances($1)',
      [teamId]
    );
    expect(again).toHaveLength(0);
  });

  it('lets only an editor clear the balances', async () => {
    const teamId = await makeSpace('money-clear-balances-viewer');
    await expect(
      harness.asUser(VIEWER, 'select * from public.clear_team_agent_balances($1)', [teamId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe('the tags on an agent', () => {
  async function makeLabel(teamId: string, name: string, scope: string): Promise<string> {
    const rows = await harness.asUser<{ id: string }>(
      OWNER,
      'select id from public.create_team_label($1, $2, $3, $4)',
      [teamId, name, 'purple', scope]
    );
    return rows[0]!.id;
  }

  it('hangs and takes off an agent tag, and is idempotent', async () => {
    const teamId = await makeSpace('agent-tags');
    const agentRowId = await makeAgent(teamId, 'v31', '1000098765434');
    const labelId = await makeLabel(teamId, '#2', 'agent');

    const attach = async () =>
      (
        await harness.asUser<{ agent: AgentJson }>(
          OWNER,
          'select public.attach_team_agent_label($1, $2, $3) as agent',
          [teamId, agentRowId, labelId]
        )
      )[0]!.agent;
    expect((await attach()).labels.map(label => label.name)).toEqual(['#2']);
    expect((await attach()).labels).toHaveLength(1);

    const detached = await harness.asUser<{ agent: AgentJson }>(
      OWNER,
      'select public.detach_team_agent_label($1, $2, $3) as agent',
      [teamId, agentRowId, labelId]
    );
    expect(detached[0]!.agent.labels).toEqual([]);
  });

  it('keeps the two sets apart: a task tag cannot go on an agent, or the other way', async () => {
    const teamId = await makeSpace('agent-tags-scope');
    const agentRowId = await makeAgent(teamId, 'v31', '1000098765434');
    const taskTag = await makeLabel(teamId, 'Hot', 'task');
    const agentTag = await makeLabel(teamId, '#2', 'agent');
    const task = await harness.asUser<{ id: string }>(
      OWNER,
      'select id from public.create_team_task($1, $2)',
      [teamId, 'A task']
    );

    await expect(
      harness.asUser(OWNER, 'select public.attach_team_agent_label($1, $2, $3)', [
        teamId,
        agentRowId,
        taskTag
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    await expect(
      harness.asUser(OWNER, 'select public.attach_team_task_label($1, $2, $3)', [
        teamId,
        task[0]!.id,
        agentTag
      ])
    ).rejects.toThrow(/NOT_FOUND/);
    // And one name may live in both sets at once, because they are two lists.
    await expect(makeLabel(teamId, 'Hot', 'agent')).resolves.toBeTruthy();
  });

  it('counts what a tag is on, per set', async () => {
    const teamId = await makeSpace('agent-tags-count');
    const agentRowId = await makeAgent(teamId, 'v31', '1000098765434');
    const labelId = await makeLabel(teamId, '#2', 'agent');
    await harness.asUser(OWNER, 'select public.attach_team_agent_label($1, $2, $3)', [
      teamId,
      agentRowId,
      labelId
    ]);
    const listed = await harness.asUser<{ name: string; usage_count: string | number }>(
      OWNER,
      'select name, usage_count from public.list_team_labels($1, $2)',
      [teamId, 'agent']
    );
    expect(listed).toHaveLength(1);
    expect(Number(listed[0]!.usage_count)).toBe(1);
    // The task set is empty and says so, rather than counting the agent's.
    const tasks = await harness.asUser(OWNER, 'select * from public.list_team_labels($1, $2)', [
      teamId,
      'task'
    ]);
    expect(tasks).toHaveLength(0);
  });
});
