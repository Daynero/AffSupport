/** Local beta load fixture. Never reads a database URL from environment variables. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { evaluateResetTarget } from '../packages/shared/dist/environment.js';

const TARGET = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const OWNER = '11111111-1111-4111-8111-111111111111';
const NAME = '038 Accounts load fixture v1 · 50 socials · 500 RK';
const STATE = new URL('../scratchpad/038/accounts-load-fixture.json', import.meta.url);
const unsafe = evaluateResetTarget(TARGET);
const url = new URL(TARGET);
if (
  unsafe ||
  url.hostname !== '127.0.0.1' ||
  url.port !== '54322' ||
  url.pathname !== '/postgres'
) {
  throw new Error(
    'Accounts fixture refuses every target except local beta 127.0.0.1:54322/postgres'
  );
}
const client = new pg.Client({ connectionString: TARGET, connectionTimeoutMillis: 5_000 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function inspect(teamId) {
  const metadata = await client.query(
    `select t.id,t.name,t.owner_id,t.status,
      exists(select 1 from public.team_members m where m.team_id=t.id and m.user_id=$2 and m.base_role='admin' and m.status='active') member
     from public.teams t where t.id=$1`,
    [teamId, OWNER]
  );
  const team = metadata.rows[0];
  if (
    !team ||
    team.name !== NAME ||
    team.owner_id !== OWNER ||
    team.status !== 'active' ||
    !team.member
  )
    return null;
  const socials = (
    await client.query(
      'select id,name,sort_rank,archived_at from public.team_accounts where team_id=$1 order by sort_rank,id',
      [teamId]
    )
  ).rows;
  const agents = (
    await client.query(
      'select id,account_id,agent_id,sort_rank,archived_at from public.team_account_agents where team_id=$1 order by account_id,sort_rank,id',
      [teamId]
    )
  ).rows;
  const runs = (
    await client.query(
      'select id,agent_row_id,note,marker from public.team_agent_runs where team_id=$1 order by agent_row_id,created_at,id',
      [teamId]
    )
  ).rows;
  const valid =
    socials.length === 50 &&
    agents.length === 500 &&
    runs.length === 2500 &&
    socials.every(
      s => s.archived_at === null && agents.filter(a => a.account_id === s.id).length === 10
    ) &&
    agents.every(
      a => a.archived_at === null && runs.filter(r => r.agent_row_id === a.id).length === 5
    );
  if (!valid) return null;
  return {
    teamId,
    ownerId: OWNER,
    name: NAME,
    counts: { socials: socials.length, agents: agents.length, runs: runs.length },
    hash: hash({ socials, agents, runs })
  };
}

try {
  await client.connect();
  const owner = (await client.query('select email from auth.users where id=$1', [OWNER])).rows[0];
  if (owner?.email !== 'beta@soty.local')
    throw new Error('Expected local beta fixture user is absent; run beta setup first');
  let previous = null;
  let reused = false;
  try {
    previous = JSON.parse(await readFile(STATE, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (previous?.teamId && /^[a-f0-9-]{36}$/i.test(previous.teamId)) {
    const existing = await inspect(previous.teamId);
    if (existing && existing.hash === previous.hash) {
      process.stdout.write(`${JSON.stringify({ ok: true, reused: true, ...existing })}\n`);
      reused = true;
    }
  }
  if (!reused) {
    // A changed previous fixture is left untouched; every replacement gets a fresh team.
    const teamId = randomUUID();
    await client.query('begin');
    await client.query("set local statement_timeout='45s'");
    await client.query(
      "insert into public.teams(id,name,owner_id,status) values($1,$2,$3,'active')",
      [teamId, NAME, OWNER]
    );
    await client.query(
      "insert into public.team_members(team_id,user_id,base_role,status) values($1,$2,'admin','active')",
      [teamId, OWNER]
    );
    await client.query(
      `insert into public.team_accounts(team_id,created_by,name)
       select $1,$2,left('g'||lpad(i::text,2,'0')||' — Long social account name for testing',40) from generate_series(1,50) i`,
      [teamId, OWNER]
    );
    await client.query(
      `insert into public.team_account_agents(team_id,account_id,created_by,agent_id)
       select $1,a.id,$2,'act_038_'||substring(a.name from 2 for 2)||'_'||lpad(i::text,2,'0')||'_'||repeat('1234567890',4)
       from public.team_accounts a cross join generate_series(1,10) i where a.team_id=$1`,
      [teamId, OWNER]
    );
    await client.query(
      `insert into public.team_agent_runs(team_id,agent_row_id,created_by,note,marker)
       select $1,a.id,$2,'Long campaign creative description for realistic table width | GEO '||i||' | 18/10',
         case (i%4) when 1 then 'green' when 2 then 'amber' when 3 then 'red' else null end
       from public.team_account_agents a cross join generate_series(1,5) i where a.team_id=$1`,
      [teamId, OWNER]
    );
    const result = await inspect(teamId);
    if (!result) throw new Error('Fixture invariants failed; new team transaction will roll back');
    await client.query('commit');
    await mkdir(new URL('../scratchpad/038/', import.meta.url), { recursive: true });
    await writeFile(STATE, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, reused: false, ...result })}\n`);
  }
} catch (error) {
  await client.query('rollback').catch(() => {});
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
