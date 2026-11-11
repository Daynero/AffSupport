import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3 QA round 2 (N4): with the dialog closed, a creation whose last video
 * registered waited for the next one-minute recovery pass. A set becoming
 * ready now wakes its creation and dispatches the recovery route at once.
 */
let db: TeamTestDb, team: string, connection: string;
const owner = '78200000-0000-4000-8000-000000000001';
const hex = (c: string) => c.repeat(64);
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'ready-dispatch@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Ready')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('ready','ready@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
  // Only the ready transition is under test: the insert-time restitch capture
  // and recipe triggers need a full restitch context this fixture does not build.
  await db.root(
    'alter table private.catalog_video_sets disable trigger catalog_video_restitch_capture, disable trigger catalog_video_initial_recipe'
  );
  await db.root('create table public.test_http_calls(url text,headers jsonb)');
  await db.root(
    "create or replace function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 60000) returns bigint language sql as $$ insert into public.test_http_calls(url,headers) values(url,headers) returning 1::bigint $$"
  );
}, 180_000);
afterAll(async () => {
  await db?.close();
});

let seq = 0;
async function interruptedCreation(lease: boolean) {
  const n = ++seq;
  const video = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file','video','video/mp4','v1') returning id",
      [team, connection, 'ready-video' + n]
    )
  )[0]!.id;
  const intent = crypto.randomUUID();
  await db.root(
    `insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint,next_attempt_at,lease_owner,lease_expires_at)
     values($1,$2,$3,$4,$5,'digest','{"catalogVideoProtocolVersion":1,"restitchEnabled":true}'::jsonb,1,'interrupted','{}'::jsonb,clock_timestamp()+interval '30 seconds',gen_random_uuid(),$6::timestamptz)`,
    [
      intent,
      team,
      video,
      owner,
      'product-catalog:' + crypto.randomUUID(),
      lease
        ? new Date(Date.now() + 120_000).toISOString()
        : new Date(Date.now() - 1_000).toISOString()
    ]
  );
  const set = crypto.randomUUID();
  await db.root(
    `insert into private.catalog_video_sets(id,team_id,actor_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,catalog_intent_id,state)
     values($1,$2,$3,$4,'v1','{}'::jsonb,$5,1,2,1,$6,1,$7,'preparing')`,
    [set, team, owner, video, hex('a'), hex('b'), intent]
  );
  return { intent, set };
}
const ready = (set: string) =>
  db.root("update private.catalog_video_sets set state='ready' where id=$1", [set]);
const due = async (intent: string) =>
  (
    await db.root<{ due: boolean }>(
      'select next_attempt_at<=clock_timestamp() due from private.catalog_generation_intents where id=$1',
      [intent]
    )
  )[0]!.due;
const calls = () => db.root<{ url: string }>('select url from public.test_http_calls');

it('wakes the creation without dispatching when no worker secret is configured', async () => {
  const { intent, set } = await interruptedCreation(false);
  await ready(set);
  expect(await due(intent)).toBe(true);
  expect(await calls()).toHaveLength(0);
});

it('dispatches the recovery route at once when the ready set wakes its creation', async () => {
  await db.root(
    'create or replace view vault.decrypted_secrets as select id,secret as decrypted_secret,name,now() as created_at from vault.secrets'
  );
  await db.root(
    "insert into vault.secrets(name,secret) values('wishly_catalog_sync_url','https://example.test/functions/v1/catalog-sync'),('wishly_catalog_sync_secret',repeat('x',32))"
  );
  const { intent, set } = await interruptedCreation(false);
  await ready(set);
  expect(await due(intent)).toBe(true);
  expect((await calls()).map(c => c.url)).toEqual([
    'https://example.test/functions/v1/drive-ops/launches/recover'
  ]);
});

it('leaves a creation held by a live lease to its holder and dispatches nothing', async () => {
  await db.root('delete from public.test_http_calls');
  const { intent, set } = await interruptedCreation(true);
  await ready(set);
  expect(await due(intent)).toBe(false);
  expect(await calls()).toHaveLength(0);
});

it('never blocks the set update when the dispatch fails', async () => {
  await db.root(
    "create or replace function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 60000) returns bigint language plpgsql as $$ begin raise exception 'pg_net down'; end $$"
  );
  const { intent, set } = await interruptedCreation(false);
  await ready(set);
  expect(await due(intent)).toBe(true);
  const state = await db.root<{ state: string }>(
    'select state from private.catalog_video_sets where id=$1',
    [set]
  );
  expect(state[0]!.state).toBe('ready');
});
