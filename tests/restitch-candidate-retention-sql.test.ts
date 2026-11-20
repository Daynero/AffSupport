import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * Backend audit 2026-11-20 (20261220130000): each re-stitch operation freezes ~73 candidate
 * rows and nothing removed them — 161 000 rows in ten days, 99.9% for operations already
 * over. The candidates of an operation that ended more than a week ago go; the screen
 * accounting (roots, slots, grants and the candidates a grant points at) stays.
 */
const TEAM = '47000000-0000-4000-8000-0000000000c0';
const ACTOR = '47000000-0000-4000-8000-0000000000c1';
let db: TeamTestDb;

beforeAll(async () => {
  db = await createTeamTestDb();
}, 120_000);
afterAll(async () => {
  await db?.close();
});

/**
 * The rows only, without the acceptance triggers and foreign keys: how a root is admitted
 * is covered by restitch-selection-storage-sql; this suite is about what is left afterwards.
 */
async function root(options: {
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  finishedDaysAgo?: number;
  createdDaysAgo: number;
  candidates?: number;
  grantFor?: number;
}) {
  const operation = randomUUID();
  const versions: string[] = [];
  await db.db.exec('set session_replication_role = replica');
  try {
    await db.root(
      `insert into public.team_operations(id,team_id,actor_id,kind,state,idempotency_key,request_nonce,created_at,updated_at,finished_at)
       values($1::uuid,$2,$3,'process',$4,($1::uuid)::text,($1::uuid)::text,
         clock_timestamp()-make_interval(days=>$5),clock_timestamp()-make_interval(days=>$5),
         case when $6::int is null then null else clock_timestamp()-make_interval(days=>$6::int) end)`,
      [
        operation,
        TEAM,
        ACTOR,
        options.state,
        options.createdDaysAgo,
        options.finishedDaysAgo ?? null
      ]
    );
    await db.root(
      `insert into private.restitch_selection_roots(root_operation_id,team_id,actor_id,source_material_id,source_version,recipe_owner_id,pool_namespace_id,recipe,created_at)
       values($1,$2,$3,gen_random_uuid(),'v1',$3,gen_random_uuid(),'{}'::jsonb,clock_timestamp()-make_interval(days=>$4))`,
      [operation, TEAM, ACTOR, options.createdDaysAgo]
    );
    await db.root(
      `insert into private.restitch_selection_slots(root_operation_id,slot,snapshot_complete,budget)
       values($1,'start',true,'{"candidates":[],"transfers":[]}'::jsonb)`,
      [operation]
    );
    for (let ordinal = 1; ordinal <= (options.candidates ?? 3); ordinal++) {
      const version = randomUUID();
      versions.push(version);
      await db.root(
        `insert into private.restitch_selection_candidates(root_operation_id,slot,version_id,material_id,ordinal,size_bytes,mime_type,checksum,drive_version,connection_id,drive_file_id,parent_folder_id,root_folder_id)
         values($1,'start',$2,gen_random_uuid(),$3,1024,'image/png',repeat('a',32),'v1',gen_random_uuid(),'file','parent','root')`,
        [operation, version, ordinal]
      );
    }
    if (options.grantFor !== undefined)
      await db.root(
        `insert into private.restitch_screen_range_grants(id,root_operation_id,team_id,actor_id,slot,version_id,acquisition,request_id,executor_id,epoch,native_instance_id,token_hash,reservation,issued_at,expires_at)
         values(gen_random_uuid(),$1::uuid,$2,$3,'start',$4::uuid,0,gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid(),
           decode(md5(($1::uuid)::text)||md5(($4::uuid)::text),'hex'),'{}'::jsonb,clock_timestamp()-interval '30 days',clock_timestamp()-interval '30 days'+interval '1 minute')`,
        [operation, TEAM, ACTOR, versions[options.grantFor]]
      );
  } finally {
    await db.db.exec('set session_replication_role = origin');
  }
  return { operation, versions };
}
const left = async (operation: string) =>
  (
    await db.root<{ version_id: string }>(
      'select version_id from private.restitch_selection_candidates where root_operation_id=$1 order by ordinal',
      [operation]
    )
  ).map(row => row.version_id);
const prune = async (roots?: number) =>
  (
    await db.root<{ n: number }>(
      roots === undefined
        ? 'select private.prune_settled_restitch_candidates() n'
        : 'select private.prune_settled_restitch_candidates($1) n',
      roots === undefined ? [] : [roots]
    )
  )[0]!.n;

it('removes the candidates of an operation that ended more than a week ago, whatever its end', async () => {
  const succeeded = await root({ state: 'succeeded', createdDaysAgo: 10, finishedDaysAgo: 9 });
  const failed = await root({ state: 'failed', createdDaysAgo: 12, finishedDaysAgo: 12 });
  const canceled = await root({ state: 'canceled', createdDaysAgo: 30, finishedDaysAgo: 29 });

  expect(await prune()).toBe(9);

  for (const item of [succeeded, failed, canceled]) expect(await left(item.operation)).toEqual([]);
  // The accounting the 047 design fences is still there.
  expect(
    await db.root(
      'select count(*)::int roots,(select count(*)::int from private.restitch_selection_slots where root_operation_id=any($1::uuid[])) slots from private.restitch_selection_roots where root_operation_id=any($1::uuid[])',
      [[succeeded.operation, failed.operation, canceled.operation]]
    )
  ).toEqual([{ roots: 3, slots: 3 }]);
});

it('keeps a snapshot that can still be read, and one that ended within the week', async () => {
  const running = await root({ state: 'running', createdDaysAgo: 40 });
  const pending = await root({ state: 'pending', createdDaysAgo: 8 });
  const justEnded = await root({ state: 'succeeded', createdDaysAgo: 9, finishedDaysAgo: 2 });
  const fresh = await root({ state: 'succeeded', createdDaysAgo: 1, finishedDaysAgo: 1 });

  expect(await prune()).toBe(0);

  for (const item of [running, pending, justEnded, fresh])
    expect(await left(item.operation)).toEqual(item.versions);
});

it('keeps the candidate a screen-range grant points at and removes the rest of its snapshot', async () => {
  const granted = await root({
    state: 'succeeded',
    createdDaysAgo: 20,
    finishedDaysAgo: 20,
    candidates: 4,
    grantFor: 2
  });

  expect(await prune()).toBe(3);
  expect(await left(granted.operation)).toEqual([granted.versions[2]]);
  // Nothing left to remove: the kept row does not bring the root back on the next run.
  expect(await prune()).toBe(0);
  expect(
    await db.root(
      'select count(*)::int n from private.restitch_screen_range_grants where root_operation_id=$1',
      [granted.operation]
    )
  ).toEqual([{ n: 1 }]);
});

it('still reaches a root however old it is', async () => {
  // An operation that ended late, or a job that was switched off for months: there is no age
  // beyond which a snapshot is left behind for good.
  const ancient = await root({ state: 'succeeded', createdDaysAgo: 400, finishedDaysAgo: 399 });
  const endedLate = await root({ state: 'failed', createdDaysAgo: 200, finishedDaysAgo: 8 });
  const stillRunning = await root({ state: 'running', createdDaysAgo: 400 });

  expect(await prune()).toBe(6);
  expect(await left(ancient.operation)).toEqual([]);
  expect(await left(endedLate.operation)).toEqual([]);
  expect(await left(stillRunning.operation)).toEqual(stillRunning.versions);
});

it('takes the oldest roots first and no more than asked for in one run', async () => {
  const oldest = await root({ state: 'succeeded', createdDaysAgo: 60, finishedDaysAgo: 60 });
  const middle = await root({ state: 'succeeded', createdDaysAgo: 50, finishedDaysAgo: 50 });
  const newest = await root({ state: 'succeeded', createdDaysAgo: 45, finishedDaysAgo: 45 });

  expect(await prune(2)).toBe(6);
  expect(await left(oldest.operation)).toEqual([]);
  expect(await left(middle.operation)).toEqual([]);
  expect(await left(newest.operation)).toEqual(newest.versions);
  expect(await prune(2)).toBe(3);
  expect(await prune(2)).toBe(0);
});

it('is out of reach of every API role', async () => {
  for (const role of ['anon', 'authenticated', 'service_role'])
    expect(
      await db.root(
        "select has_function_privilege($1,'private.prune_settled_restitch_candidates(integer)','EXECUTE') allowed",
        [role]
      )
    ).toEqual([{ allowed: false }]);
});
