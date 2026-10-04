import { createTeamTestDb, createUser } from './team-db';

export const FINANCE_OWNER = '27000000-0000-4000-8000-000000000001';
export const FINANCE_VIEWER = '27000000-0000-4000-8000-000000000002';
export async function financeFixture(options: { legacy?: boolean } = {}) {
  const db = await createTeamTestDb();
  await createUser(db, { id: FINANCE_OWNER, email: 'editor@finance.test' });
  await createUser(db, { id: FINANCE_VIEWER, email: 'viewer@finance.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [FINANCE_OWNER]);
  const team = (
    await db.asUser<{ id: string }>(FINANCE_OWNER, 'select id from public.create_team($1)', [
      'Finance'
    ])
  )[0]!.id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values ($1,$2,'viewer')",
    [team, FINANCE_VIEWER]
  );
  const accounts = [];
  for (const name of ['X', 'Y'])
    accounts.push(
      (
        await db.asUser<{ id: string }>(
          FINANCE_OWNER,
          'select id from public.create_team_account($1,$2)',
          [team, name]
        )
      )[0]!.id
    );
  const agent = (
    await db.asUser<{ id: string }>(
      FINANCE_OWNER,
      "select public.add_team_account_agent($1,$2,$3)->>'id' as id",
      [team, accounts[0], '001234']
    )
  )[0]!.id;
  // Fixture intentionally precedes the reporting month; production never edits dates this way.
  await db.root("update public.team_account_agents set created_at='2026-01-01' where id=$1", [
    agent
  ]);
  await db.root(
    "update public.team_agent_placements set starts_on='2026-01-01' where agent_row_id=$1",
    [agent]
  );
  const otherTeam = (
    await db.asUser<{ id: string }>(FINANCE_OWNER, 'select id from public.create_team($1)', [
      'Other finance'
    ])
  )[0]!.id;
  const otherAccount = (
    await db.asUser<{ id: string }>(
      FINANCE_OWNER,
      'select id from public.create_team_account($1,$2)',
      [otherTeam, 'Other']
    )
  )[0]!.id;
  await db.asUser(FINANCE_OWNER, 'select public.add_team_agent_run($1,$2,$3)', [
    team,
    agent,
    'Preserved run'
  ]);
  const task = (
    await db.root<{ id: string }>(
      'insert into public.team_tasks(team_id,created_by,title) values($1,$2,$3) returning id',
      [team, FINANCE_OWNER, 'Finance task']
    )
  )[0]!.id;
  await db.root(
    'insert into public.team_task_agents(team_id,task_id,agent_row_id,attached_by) values($1,$2,$3,$4)',
    [team, task, agent, FINANCE_OWNER]
  );
  const label = (
    await db.asUser<{ id: string }>(
      FINANCE_OWNER,
      "select id from public.create_team_label($1,'Preserved label','blue','agent')",
      [team]
    )
  )[0]!.id;
  await db.asUser(FINANCE_OWNER, 'select public.attach_team_agent_label($1,$2,$3)', [
    team,
    agent,
    label
  ]);
  const legacy = options.legacy
    ? (
        await db.root<{ id: string }>(
          'insert into public.team_agent_finance_legacy(team_id,agent_row_id,account_id,balance_units,requested_topup_units) values($1,$2,$3,70,200) returning id',
          [team, agent, accounts[0]]
        )
      )[0]!.id
    : null;
  return { db, team, agent, accounts, otherTeam, otherAccount, task, label, legacy };
}
