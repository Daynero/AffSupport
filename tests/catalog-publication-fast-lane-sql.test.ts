import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3 QA: a deferred Drive link was published 2–4 minutes after its due time.
 * The scheduler ran only in the per-minute updater pass, which did not even start
 * for a due publication alone. A ten-second publication lane now runs while a
 * publication is recently due, a ready video set wakes it at once, and the
 * per-minute pass starts for any due publication.
 */
let db: TeamTestDb, team: string, connection: string;
const owner = '78300000-0000-4000-8000-000000000001';
const hex = (c: string) => c.repeat(64);
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'publication-lane@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Lane')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('lane','lane@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
  await db.root(
    'alter table private.catalog_video_sets disable trigger catalog_video_restitch_capture, disable trigger catalog_video_initial_recipe'
  );
  await db.root('create table public.test_http_calls(url text,body jsonb)');
  await db.root(
    "create or replace function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 60000) returns bigint language sql as $$ insert into public.test_http_calls(url,body) values(url,body) returning 1::bigint $$"
  );
  await db.root(
    'create or replace view vault.decrypted_secrets as select id,secret as decrypted_secret,name,now() as created_at from vault.secrets'
  );
  await db.root(
    "insert into vault.secrets(name,secret) values('wishly_catalog_sync_url','https://example.test/functions/v1/catalog-sync'),('wishly_catalog_sync_secret',repeat('x',32))"
  );
}, 180_000);
afterAll(async () => {
  await db?.close();
});

let seq = 0;
/** A catalog with one publication job. `dueAgo` < 0 means not due yet. */
async function publication(input: {
  dueAgo: string;
  state?: string;
  dispatchedAgo?: string;
  nextIn?: string;
}) {
  const n = ++seq;
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file','other','application/vnd.google-apps.spreadsheet','v1') returning id",
      [team, connection, 'lane-catalog' + n]
    )
  )[0]!.id;
  const job = crypto.randomUUID(),
    target = crypto.randomUUID();
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      `insert into private.catalog_video_publication_policies
         (catalog_material_id,team_id,actor_id,revision,mode,due_at,time_zone,legacy_delivery_unverified,target_id)
       values($1,$2,$3,1,'scheduled',clock_timestamp()-$4::interval,'Europe/Kyiv',false,$5)`,
      [catalog, team, owner, input.dueAgo, target]
    );
    await db.root(
      `insert into private.catalog_video_publication_jobs
         (id,catalog_material_id,team_id,revision,command_id,target_id,actor_id,state,writer_fence,dispatched_at,next_attempt_at)
       values($1,$2,$3,1,gen_random_uuid(),$4,$5,$6,$7,$8,clock_timestamp()+$9::interval)`,
      [
        job,
        catalog,
        team,
        target,
        owner,
        input.state ?? 'retry_wait',
        input.dispatchedAgo ? crypto.randomUUID() : null,
        input.dispatchedAgo
          ? (
              await db.root<{ at: string }>('select (clock_timestamp()-$1::interval)::text at', [
                input.dispatchedAgo
              ])
            )[0]!.at
          : null,
        input.nextIn ?? '0 seconds'
      ]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  return { catalog, job };
}
const clear = () =>
  db.root(
    "update private.catalog_video_publication_jobs set state='published' where state<>'published'"
  );
const due = async (recent: boolean) =>
  (
    await db.root<{ due: boolean }>('select private.catalog_publication_work_due($1) due', [recent])
  )[0]!.due;
const calls = () =>
  db.root<{ url: string; body: { publicationsOnly?: boolean } }>(
    'select url,body from public.test_http_calls'
  );

it('the fast lane covers recently due work only; the per-minute pass covers any due work', async () => {
  await clear();
  await publication({ dueAgo: '-5 minutes' });
  expect(await due(true)).toBe(false);
  expect(await due(false)).toBe(false);
  await publication({ dueAgo: '1 minute' });
  expect(await due(true)).toBe(true);
  await clear();
  await publication({ dueAgo: '2 hours' });
  expect(await due(true)).toBe(false);
  expect(await due(false)).toBe(true);
  await clear();
  // An uncertain write is re-read at the fast pace only right after dispatch.
  await publication({ dueAgo: '10 minutes', state: 'unknown', dispatchedAgo: '1 minute' });
  expect(await due(true)).toBe(true);
  await clear();
  await publication({ dueAgo: '1 hour', state: 'unknown', dispatchedAgo: '30 minutes' });
  expect(await due(true)).toBe(false);
  expect(await due(false)).toBe(true);
  await clear();
});

it('the ten-second invoker dispatches the publication-only lane only while work is due', async () => {
  await clear();
  await db.root('delete from public.test_http_calls');
  expect(
    (
      await db.root<{ id: string | null }>('select private.invoke_catalog_publication_worker() id')
    )[0]!.id
  ).toBeNull();
  expect(await calls()).toHaveLength(0);
  await publication({ dueAgo: '30 seconds' });
  await db.root('select private.invoke_catalog_publication_worker()');
  expect(await calls()).toEqual([
    {
      url: 'https://example.test/functions/v1/catalog-updater',
      body: { publicationsOnly: true }
    }
  ]);
  await clear();
});

it('the per-minute invoker now starts for a due publication alone', async () => {
  const body = (
    await db.root<{ src: string }>(
      "select prosrc src from pg_proc where oid='private.invoke_catalog_updater_worker()'::regprocedure"
    )
  )[0]!.src;
  expect(body).toContain('and not private.catalog_publication_work_due(false) then');
});

it('a video set becoming ready wakes its due publication at once and dispatches the lane', async () => {
  await clear();
  await db.root('delete from public.test_http_calls');
  const { catalog, job } = await publication({ dueAgo: '1 minute', nextIn: '30 seconds' });
  const notDue = await publication({ dueAgo: '-10 minutes', nextIn: '30 seconds' });
  const set = crypto.randomUUID();
  const video = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,'lane-video','lane-video','file','video','video/mp4','v1') returning id",
      [team, connection]
    )
  )[0]!.id;
  // Only the ready transition is under test; the creation it belongs to is not built.
  await db.root('set session_replication_role = replica');
  try {
    for (const [id, material] of [
      [set, catalog],
      [crypto.randomUUID(), notDue.catalog]
    ] as const)
      await db.root(
        `insert into private.catalog_video_sets(id,team_id,actor_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,catalog_material_id,catalog_intent_id,state)
         values($1,$2,$3,$4,'v1','{}'::jsonb,$5,1,2,1,$6,1,$7,gen_random_uuid(),'preparing')`,
        [id, team, owner, video, hex('a'), hex('b'), material]
      );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  await db.root(
    "update private.catalog_video_sets set state='ready' where catalog_material_id = any($1::uuid[])",
    [[catalog, notDue.catalog]]
  );
  const next = async (id: string) =>
    (
      await db.root<{ now: boolean }>(
        'select next_attempt_at<=clock_timestamp() now from private.catalog_video_publication_jobs where id=$1',
        [id]
      )
    )[0]!.now;
  expect(await next(job)).toBe(true);
  // A publication whose time has not come keeps its schedule.
  expect(await next(notDue.job)).toBe(false);
  expect((await calls()).map(c => c.body)).toEqual([{ publicationsOnly: true }]);
  await clear();
});
