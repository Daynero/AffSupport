import { createTeamTestDb, createUser } from './team-db';

export const UNIFIED_ACCOUNTS_OWNER = '38000000-0000-4000-8000-000000000001';
export const UNIFIED_ACCOUNTS_VIEWER = '38000000-0000-4000-8000-000000000002';
/** Isolated SQL fixture for lifecycle tests and the 50-social / 500-RK load case.
 * Never connects to beta or production. Call close() in finally.
 */
export async function unifiedAccountsFixture(
  options: {
    socialCount?: number;
    agentsPerSocial?: number;
    runsPerAgent?: number;
    throughMigration?: string;
  } = {}
) {
  const socialCount = options.socialCount ?? 50;
  const agentsPerSocial = options.agentsPerSocial ?? 10;
  const runsPerAgent = options.runsPerAgent ?? 5;
  if (
    !Number.isInteger(socialCount) ||
    socialCount < 1 ||
    socialCount > 50 ||
    !Number.isInteger(agentsPerSocial) ||
    agentsPerSocial < 0 ||
    agentsPerSocial > 10 ||
    !Number.isInteger(runsPerAgent) ||
    runsPerAgent < 0 ||
    runsPerAgent > 5
  )
    throw new Error('Invalid unified accounts fixture dimensions');
  const db = await createTeamTestDb({ throughMigration: options.throughMigration });
  try {
    await createUser(db, { id: UNIFIED_ACCOUNTS_OWNER, email: 'owner@unified-accounts.test' });
    await createUser(db, { id: UNIFIED_ACCOUNTS_VIEWER, email: 'viewer@unified-accounts.test' });
    await db.root('insert into public.admin_users(user_id) values($1)', [UNIFIED_ACCOUNTS_OWNER]);
    const team = (
      await db.asUser<{ id: string }>(
        UNIFIED_ACCOUNTS_OWNER,
        "select id from public.create_team('Unified accounts fixture')"
      )
    )[0]!.id;
    await db.root(
      "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
      [team, UNIFIED_ACCOUNTS_VIEWER]
    );
    await db.root(
      "insert into public.team_accounts(team_id,created_by,name,created_at) select $1,$2,'g'||i,'2026-01-01'::timestamptz from generate_series(1,$3::integer) i",
      [team, UNIFIED_ACCOUNTS_OWNER, socialCount]
    );
    const socials = await db.root<{ id: string; name: string }>(
      'select id,name from public.team_accounts where team_id=$1 order by length(name),name',
      [team]
    );
    await db.root(
      "insert into public.team_account_agents(team_id,account_id,created_by,agent_id,created_at) select $1,a.id,$2,'rk-'||i,'2026-01-01'::timestamptz from public.team_accounts a cross join generate_series(1,$3::integer) i where a.team_id=$1",
      [team, UNIFIED_ACCOUNTS_OWNER, agentsPerSocial]
    );
    const agents = await db.root<{ id: string; account_id: string; agent_id: string }>(
      'select id,account_id,agent_id from public.team_account_agents where team_id=$1 order by account_id,agent_id',
      [team]
    );
    await db.root(
      "insert into public.team_agent_runs(team_id,agent_row_id,created_by,note) select $1,a.id,$2,'Run '||i from public.team_account_agents a cross join generate_series(1,$3::integer) i where a.team_id=$1",
      [team, UNIFIED_ACCOUNTS_OWNER, runsPerAgent]
    );
    return { db, team, socials, agents, close: db.close };
  } catch (error) {
    await db.close();
    throw error;
  }
}
