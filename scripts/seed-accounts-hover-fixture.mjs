/** Additive, rerunnable fixture for the visible local beta workspace. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { evaluateResetTarget } from '../packages/shared/dist/environment.js';

const TARGET = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const TEAM = '22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111';
const STATE = new URL('../scratchpad/038/accounts-hover-fixture.json', import.meta.url);
const target = new URL(TARGET);
if (
  evaluateResetTarget(TARGET) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '54322' ||
  target.pathname !== '/postgres'
)
  throw new Error('Hover fixture requires the local beta database on 127.0.0.1:54322');
const client = new pg.Client({ connectionString: TARGET, connectionTimeoutMillis: 5_000 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function existingData(excludedSocials) {
  const result = {};
  for (const table of [
    'team_accounts',
    'team_account_agents',
    'team_agent_runs',
    'team_agent_finance_values'
  ]) {
    const exclusion =
      table === 'team_accounts'
        ? 'id'
        : table === 'team_account_agents'
          ? 'account_id'
          : 'agent_row_id';
    const excluded =
      table === 'team_accounts' || table === 'team_account_agents'
        ? excludedSocials
        : (
            await client.query(
              'select id from public.team_account_agents where account_id=any($1::uuid[])',
              [excludedSocials]
            )
          ).rows.map(row => row.id);
    result[table] = (
      await client.query(
        `select to_jsonb(t) row from public.${table} t where team_id=$1 and not (${exclusion}=any($2::uuid[])) order by id`,
        [TEAM, excluded]
      )
    ).rows;
  }
  return digest(result);
}

async function counts(ids) {
  return (
    await client.query(
      `select (select count(*)::int from public.team_accounts where team_id=$1 and id=any($2::uuid[])) socials,
      (select count(*)::int from public.team_account_agents where team_id=$1 and account_id=any($2::uuid[])) agents,
      (select count(*)::int from public.team_agent_runs r join public.team_account_agents a on a.id=r.agent_row_id where r.team_id=$1 and a.account_id=any($2::uuid[])) runs`,
      [TEAM, ids]
    )
  ).rows[0];
}

try {
  await client.connect();
  const safe = (
    await client.query(
      `select t.name,t.owner_id,t.status,u.email from public.teams t join auth.users u on u.id=t.owner_id where t.id=$1`,
      [TEAM]
    )
  ).rows[0];
  if (
    safe?.name !== 'Beta Workspace' ||
    safe.owner_id !== OWNER ||
    safe.status !== 'active' ||
    safe.email !== 'beta@soty.local'
  )
    throw new Error('Expected local beta workspace and owner are absent');
  let previous;
  try {
    previous = JSON.parse(await readFile(STATE, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (previous) {
    if (previous.teamId !== TEAM || previous.socials?.length !== 10)
      throw new Error('Unexpected hover fixture manifest');
    const current = await counts(previous.socials.map(row => row.id));
    // A user may edit, archive or extend these rows. Never repair or overwrite them.
    process.stdout.write(
      `${JSON.stringify({ ok: true, reused: true, teamId: TEAM, counts: current, manifest: 'scratchpad/038/accounts-hover-fixture.json', existingRowsUntouched: true })}\n`
    );
  } else {
    await client.query('begin');
    await client.query("set local statement_timeout='45s'");
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      'accounts-hover-fixture-v1'
    ]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: OWNER, role: 'authenticated' })
    ]);
    const collision = await client.query(
      "select id from public.team_accounts where team_id=$1 and name like 'DEMO-HOVER-%'",
      [TEAM]
    );
    if (collision.rowCount)
      throw new Error(
        'Reserved fixture names already exist without a manifest; no rows were changed'
      );
    const before = await existingData([]);
    const socials = [];
    for (let social = 1; social <= 10; social++) {
      const suffix = String(social).padStart(2, '0');
      const name = `DEMO-HOVER-${suffix}`;
      const account = (
        await client.query('select * from public.create_team_account($1,$2)', [TEAM, name])
      ).rows[0];
      const agents = [];
      for (let rk = 1; rk <= 10; rk++) {
        const agentId = `demo_hover_${suffix}_${String(rk).padStart(2, '0')}`;
        const agent = (
          await client.query('select public.add_team_account_agent($1,$2,$3,null,$4) result', [
            TEAM,
            account.id,
            agentId,
            'Europe/Kyiv'
          ])
        ).rows[0].result;
        const runs = [];
        // Four free RK; six with one, two or three launches per social.
        const runCount = rk <= 4 ? 0 : 1 + (rk % 3);
        for (let run = 1; run <= runCount; run++) {
          const note =
            run === 1
              ? `DEMO | ${suffix}-${rk} | Україна`
              : run === 2
                ? `DEMO | Довга назва запуску для перевірки наведення, кнопок та обрізання тексту | ${suffix}-${rk}`
                : `DEMO | Retargeting ${suffix}-${rk} | Creative C`;
          const created = (
            await client.query('select public.add_team_agent_run($1,$2,$3) result', [
              TEAM,
              agent.id,
              note
            ])
          ).rows[0].result;
          runs.push(created.id);
        }
        agents.push({ id: agent.id, agentId, runs });
      }
      socials.push({ id: account.id, name, agents });
    }
    const after = await existingData(socials.map(row => row.id));
    if (before !== after)
      throw new Error('Existing user rows changed; fixture transaction rolled back');
    const count = await counts(socials.map(row => row.id));
    if (count.socials !== 10 || count.agents !== 100 || count.runs !== 120)
      throw new Error(`Fixture counts differ from 10/100/120: ${JSON.stringify(count)}`);
    const state = {
      teamId: TEAM,
      createdAt: new Date().toISOString(),
      counts: count,
      existingRowsHashBefore: before,
      existingRowsHashAfter: after,
      socials
    };
    await client.query('commit');
    await mkdir(new URL('../scratchpad/038/', import.meta.url), { recursive: true });
    await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: true, reused: false, teamId: TEAM, counts: count, existingRowsUntouched: before === after, manifest: 'scratchpad/038/accounts-hover-fixture.json' })}\n`
    );
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
