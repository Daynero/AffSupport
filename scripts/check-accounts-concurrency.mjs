/** Native PostgreSQL concurrency evidence, limited to disposable LOCAL beta fixtures. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { evaluateResetTarget } from '../packages/shared/dist/environment.js';
import { launchPreview, parseLaunchSources } from '../packages/shared/dist/team/launches.js';

const TARGET = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const BETA_OWNER = '11111111-1111-4111-8111-111111111111';
const url = new URL(TARGET);
if (
  evaluateResetTarget(TARGET) ||
  url.hostname !== '127.0.0.1' ||
  url.port !== '54322' ||
  url.pathname !== '/postgres'
)
  throw new Error('Native concurrency check only accepts local beta 127.0.0.1:54322/postgres');
const actor = randomUUID();
const team = randomUUID();
const marker = `038 native concurrency ${team}`;
const connections = Array.from(
  { length: 3 },
  (_, index) =>
    new pg.Client({
      connectionString: TARGET,
      connectionTimeoutMillis: 5000,
      application_name: `038-concurrency-${index}`
    })
);
const [control, a, b] = connections;
const evidence = [];
let fixtureCreated = false;
let cleaned = false;
/** @type {string | null} */
let credential = null;

/** @param {pg.Client} client @param {string} name @param {unknown[]} args */
async function rpc(client, name, args) {
  const result = await client.query(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`,
    args
  );
  return result.rows[0].value;
}
/** Observe real lock ownership, rather than assuming an elapsed delay means blocking. */
async function observedBlock(waitingPid, blockerPid) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const row = (await control.query('select pg_blocking_pids($1) blockers', [waitingPid])).rows[0];
    if (row.blockers.includes(blockerPid)) return { waitingPid, blockerPid, observed: true };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Did not observe PostgreSQL backend ${waitingPid} waiting for ${blockerPid}`);
}
async function preflight(kind, id) {
  return rpc(a, 'get_team_account_archive_preflight', [team, kind, id]);
}
async function archive(kind, id, pre) {
  return rpc(a, 'set_team_account_archived', [
    team,
    kind,
    id,
    true,
    pre.lifecycleVersion,
    pre.token,
    randomUUID()
  ]);
}
async function social(name) {
  return (
    await control.query(
      'insert into public.team_accounts(team_id,created_by,name) values($1,$2,$3) returning id',
      [team, actor, name]
    )
  ).rows[0].id;
}
async function agent(parent, name) {
  return rpc(a, 'add_team_account_agent', [team, parent, name]);
}
async function placement(id) {
  return (
    await a.query(
      'select id,version::text from public.team_agent_placements where team_id=$1 and agent_row_id=$2 and ends_on is null',
      [team, id]
    )
  ).rows[0];
}
/** @param {Promise<unknown>} pending */
function captured(pending) {
  return pending.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
  );
}
/** @param {{ok:boolean,error?:Error}} result @param {string} code */
function rejects(result, code) {
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
  assert.equal(result.error.message, code);
  return result.error.message;
}

try {
  await Promise.all(connections.map(client => client.connect()));
  await control.query("set statement_timeout='12000ms'");
  const beta = (await control.query('select email from auth.users where id=$1', [BETA_OWNER]))
    .rows[0];
  assert.equal(beta?.email, 'beta@soty.local', 'Known local beta fixture must exist');
  await control.query('begin');
  await control.query(
    "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,'{}',now())",
    [actor, `concurrency-${actor}@beta.soty.local`]
  );
  await control.query('insert into public.admin_users(user_id) values($1)', [actor]);
  await control.query(
    "insert into public.teams(id,owner_id,name,status) values($1,$2,$3,'active')",
    [team, actor, marker]
  );
  await control.query(
    "insert into public.team_members(team_id,user_id,base_role,status) values($1,$2,'admin','active')",
    [team, actor]
  );
  await control.query('commit');
  fixtureCreated = true;
  for (const client of [a, b]) {
    await client.query('set role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await client.query("set statement_timeout='12000ms'");
    await client.query("set idle_in_transaction_session_timeout='15000ms'");
  }
  const aPid = (await a.query('select pg_backend_pid() pid')).rows[0].pid;
  const bPid = (await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const first = await social('Archive races');
  const target = await social('Destination');

  const orderLeft = await agent(first, 'order-left');
  const orderRight = await agent(first, 'order-right');
  const orderOverview = await rpc(a, 'get_team_accounts_overview', [
    team,
    '2026-01-01',
    '2026-01-02',
    'UTC'
  ]);
  const orderVersion = orderOverview.agentOrderVersions[first];
  await a.query('begin');
  const changedOrder = await rpc(a, 'reorder_team_accounts', [
    team,
    'agents',
    first,
    orderRight.id,
    orderLeft.id,
    'before',
    orderVersion,
    randomUUID()
  ]);
  const orderPending = captured(
    rpc(b, 'reorder_team_accounts', [
      team,
      'agents',
      first,
      orderLeft.id,
      orderRight.id,
      'before',
      orderVersion,
      randomUUID()
    ])
  );
  const orderBlock = await observedBlock(bPid, aPid);
  await a.query('commit');
  const orderResult = await orderPending;
  const orderCode = rejects(orderResult, 'ACCOUNT_ORDER_CONFLICT');
  const canonicalOverview = await rpc(a, 'get_team_accounts_overview', [
    team,
    '2026-01-01',
    '2026-01-02',
    'UTC'
  ]);
  const canonicalOrder = canonicalOverview.accounts
    .find(account => account.id === first)
    .agents.map(row => row.id);
  assert.deepEqual(canonicalOrder, [orderRight.id, orderLeft.id]);
  assert.deepEqual([...new Set(canonicalOrder)].sort(), [orderLeft.id, orderRight.id].sort());
  assert.deepEqual(canonicalOrder, changedOrder.order);
  evidence.push({
    scenario: 'same_version_reorder',
    scope: 'agents',
    block: orderBlock,
    result: orderCode,
    canonicalOrder,
    fullMembershipPreserved: true
  });

  const task = (
    await control.query(
      'insert into public.team_tasks(team_id,created_by,title) values($1,$2,$3) returning id',
      [team, actor, 'Owned archive-race task']
    )
  ).rows[0].id;
  for (const operation of ['run', 'move', 'task_assignment']) {
    const row = await agent(first, `race-${operation}`);
    const pre = await preflight('agent', row.id);
    const place = await placement(row.id);
    await a.query('begin');
    await archive('agent', row.id, pre);
    const pending = captured(
      operation === 'run'
        ? rpc(b, 'add_team_agent_run', [team, row.id, 'Must not be accepted'])
        : operation === 'task_assignment'
          ? rpc(b, 'attach_team_task_agent', [team, task, row.id])
          : rpc(b, 'move_team_account_agent', [
              team,
              row.id,
              target,
              '2026-01-01',
              place.id,
              place.version,
              'UTC',
              randomUUID()
            ])
    );
    const block = await observedBlock(bPid, aPid);
    await a.query('commit');
    const result = await pending;
    const resultCode = rejects(result, 'ACCOUNT_ARCHIVED');
    if (operation === 'task_assignment') {
      const attached = (
        await control.query(
          'select count(*)::integer n from public.team_task_agents where team_id=$1 and task_id=$2 and agent_row_id=$3',
          [team, task, row.id]
        )
      ).rows[0].n;
      assert.equal(attached, 0, 'The rejected assignment must not leave an attachment');
    }
    evidence.push({ scenario: `archive_vs_new_${operation}`, block, result: resultCode });
  }

  // Canonical new generation acceptance races against an uncommitted RK archive.
  // Synthetic owned metadata supplies source identity; no worker state is forced.
  const launchAgent = await agent(first, '123456789038');
  credential = (
    await control.query(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values($1,$2,'https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$3) returning id",
      [marker, `concurrency-${actor}@beta.soty.local`, actor]
    )
  ).rows[0].id;
  const connection = (
    await control.query(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,$3,'Owned synthetic root','my_drive','connected',now()) returning id",
      [team, credential, `root-${team}`]
    )
  ).rows[0].id;
  const material = (
    await control.query(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,'owned-synthetic.mp4','file','video','video/mp4','1') returning id",
      [team, connection, `video-${team}`]
    )
  ).rows[0].id;
  const buyer = await rpc(a, 'create_launch_dictionary', [
    team,
    'buyers',
    'buyer038',
    randomUUID()
  ]);
  const offer = await rpc(a, 'create_launch_dictionary', [
    team,
    'offers',
    'offer038',
    randomUUID()
  ]);
  /** @type {import('../packages/shared/dist/team/launches.js').LaunchConfig} */
  const config = {
    schemaVersion: 1,
    agentRowId: launchAgent.id,
    offerId: offer.id,
    buyerId: buyer.id,
    materialId: material,
    creativeAlias: 'race',
    campaignCount: 1,
    maxBudget: 30,
    adsCount: 1,
    budgetMode: 'auto',
    budgets: null,
    age: 45,
    gender: 'M',
    advantagePlus: false,
    launchDate: '2026-10-18',
    timezone: 'UTC',
    method: 'other',
    originalUrl: 'https://example.invalid/concurrency',
    subConfig: {
      schemaVersion: 1,
      sub1: ['buyer'],
      sub2: ['social', 'adAccountSuffix', 'creative'],
      sub3: ['creative']
    },
    catalog: {
      productCount: 100,
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    }
  };
  const draft = await rpc(a, 'save_launch_draft', [
    team,
    null,
    null,
    randomUUID(),
    JSON.stringify(config),
    null
  ]);
  const source = await rpc(a, 'get_launch_sources', [team, draft.id]);
  const parsedSource = parseLaunchSources(source);
  assert.ok(parsedSource, 'Synthetic canonical sources must parse');
  const saved = await rpc(a, 'save_launch_draft', [
    team,
    draft.id,
    draft.version,
    randomUUID(),
    JSON.stringify(config),
    JSON.stringify(source)
  ]);
  const preview = launchPreview(config, parsedSource);
  assert.ok(preview.ok, 'Synthetic canonical preview must be valid');
  const launchPre = await preflight('agent', launchAgent.id);
  await b.query('reset role');
  await b.query('set role service_role');
  await a.query('begin');
  await archive('agent', launchAgent.id, launchPre);
  const launchPending = captured(
    rpc(b, 'service_accept_launch_generation', [
      team,
      draft.id,
      actor,
      saved.version,
      randomUUID(),
      randomUUID(),
      JSON.stringify(config),
      JSON.stringify(source),
      JSON.stringify(preview.value)
    ])
  );
  const launchBlock = await observedBlock(bPid, aPid);
  await a.query('commit');
  const launchResult = await launchPending;
  const launchCode = rejects(launchResult, 'ACCOUNT_ARCHIVED');
  await b.query('reset role');
  await b.query('set role authenticated');
  const generations = (
    await control.query(
      'select count(*)::integer n from public.team_launch_generations where team_id=$1 and launch_id=$2',
      [team, draft.id]
    )
  ).rows[0].n;
  const revisions = (
    await control.query(
      'select count(*)::integer n from public.team_launch_revisions where team_id=$1 and launch_id=$2',
      [team, draft.id]
    )
  ).rows[0].n;
  assert.equal(generations, 0, 'Rejected acceptance must not create a generation');
  assert.equal(revisions, 0, 'Rejected acceptance must not create a partial revision');
  evidence.push({
    scenario: 'archive_vs_new_launch_acceptance',
    block: launchBlock,
    result: launchCode,
    generations,
    revisions
  });

  const parent = await social('Parent archive race');
  const parentPre = await preflight('social', parent);
  await a.query('begin');
  await archive('social', parent, parentPre);
  const childPending = captured(
    rpc(b, 'add_team_account_agent', [team, parent, 'must-not-appear'])
  );
  const childBlock = await observedBlock(bPid, aPid);
  await a.query('commit');
  const childResult = await childPending;
  const childCode = rejects(childResult, 'PARENT_ARCHIVED');
  evidence.push({
    scenario: 'social_archive_vs_new_child',
    block: childBlock,
    result: childCode
  });

  const finance = await agent(first, 'finance-race');
  const stale = await preflight('agent', finance.id);
  const financePlace = await placement(finance.id);
  const today = (await a.query("select (clock_timestamp() at time zone 'UTC')::date::text as day"))
    .rows[0].day;
  const key = randomUUID();
  const setArgs = [
    team,
    finance.id,
    today,
    'spend',
    '3',
    '0',
    'UTC',
    key,
    financePlace.id,
    'normal'
  ];
  await a.query('begin');
  const accepted = await rpc(a, 'set_team_agent_finance_value', setArgs);
  const archivePending = captured(
    rpc(b, 'set_team_account_archived', [
      team,
      'agent',
      finance.id,
      true,
      stale.lifecycleVersion,
      stale.token,
      randomUUID()
    ])
  );
  const financeBlock = await observedBlock(bPid, aPid);
  await a.query('commit');
  const staleResult = await archivePending;
  const staleCode = rejects(staleResult, 'ACCOUNT_LIFECYCLE_CONFLICT');
  evidence.push({
    scenario: 'uncommitted_finance_vs_stale_archive',
    block: financeBlock,
    result: staleCode
  });

  await archive('agent', finance.id, await preflight('agent', finance.id));
  const replay = await rpc(b, 'set_team_agent_finance_value', setArgs);
  assert.deepEqual(replay, accepted);
  const denied = await captured(
    rpc(b, 'set_team_agent_finance_value', [
      team,
      finance.id,
      today,
      'spend',
      '3',
      '1',
      'UTC',
      randomUUID(),
      financePlace.id,
      'normal'
    ])
  );
  const deniedCode = rejects(denied, 'HISTORICAL_CORRECTION_REQUIRED');
  const count = (
    await control.query(
      'select count(*)::integer n from public.team_agent_finance_events where team_id=$1 and agent_row_id=$2',
      [team, finance.id]
    )
  ).rows[0].n;
  assert.equal(count, 1, 'Successful receipt replay must not duplicate the financial event');
  evidence.push({
    scenario: 'authorized_finance_replay_after_archive',
    replay: 'canonical_equal',
    newRequest: deniedCode,
    financialEvents: count
  });
} finally {
  await Promise.allSettled([a.query('rollback'), b.query('rollback')]);
  if (fixtureCreated) {
    await control.query('begin');
    // Exact ownership+marker guard: no baseline or load-fixture team can be touched.
    const removed = await control.query(
      'delete from public.teams where id=$1 and owner_id=$2 and name=$3 returning id',
      [team, actor, marker]
    );
    assert.equal(removed.rowCount, 1);
    if (credential)
      await control.query(
        'delete from private.google_drive_credentials where id=$1 and connected_by=$2 and google_permission_id=$3',
        [credential, actor, marker]
      );
    await control.query('delete from auth.users where id=$1 and email=$2', [
      actor,
      `concurrency-${actor}@beta.soty.local`
    ]);
    await control.query('commit');
    cleaned = true;
  }
  await Promise.allSettled(connections.map(client => client.end()));
}
const report = {
  ok: true,
  target: '127.0.0.1:54322/postgres',
  team,
  actor,
  cleaned,
  evidence,
  unverified: [
    {
      scenario: 'accepted_launch_generation_after_archive',
      reason:
        'Outside the native lock probe; canonically verified by tests/team-account-accepted-launch.test.ts (service accept, archive, service publish and immutable replay).'
    }
  ]
};
await mkdir(new URL('../scratchpad/038/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../scratchpad/038/concurrency.json', import.meta.url),
  `${JSON.stringify(report, null, 2)}\n`
);
process.stdout.write(`${JSON.stringify(report)}\n`);
