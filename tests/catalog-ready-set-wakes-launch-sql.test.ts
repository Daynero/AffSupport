import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11 (QA round 9): a catalog launch sat in 'interrupted' for about four
 * minutes after its videos were ready, waiting on its own backoff. A video set
 * becoming ready now makes such a launch due at once and dispatches the launch
 * recovery route (20261207399910).
 */
let db: TeamTestDb, team: string, connection: string;
const owner = 'c3999100-0000-4000-8000-000000000001';
const hex = (c: string) => c.repeat(64);

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'ready-launch@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Wake')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('wake','wake@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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

/** A catalog launch generation tied to a preparing video set. */
async function launchOnSet(input: { state: string; leaseHeld?: boolean; nextIn: string }) {
  const set = crypto.randomUUID();
  const video = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file','video','video/mp4','v1') returning id",
      [team, connection, 'wake-' + set]
    )
  )[0]!.id;
  // Only the ready transition is under test; the creation it belongs to is not built.
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      `insert into private.catalog_video_sets(id,team_id,actor_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,catalog_intent_id,state)
       values($1,$2,$3,$4,'v1','{}'::jsonb,$5,1,2,1,$6,1,gen_random_uuid(),'preparing')`,
      [set, team, owner, video, hex('a'), hex('b')]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  const launch = (
    await db.root<{ id: string }>(
      'insert into public.team_launches(team_id,created_by)values($1,$2)returning id',
      [team, owner]
    )
  )[0]!.id;
  const revision = (
    await db.root<{ id: string }>(
      "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)values($1,$2,1,'generated','{}','{}','https://example.invalid/','https://example.invalid/','{}',$3)returning id",
      [team, launch, owner]
    )
  )[0]!.id;
  const generation = crypto.randomUUID();
  await db.root(
    `insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage,next_attempt_at,lease_owner,lease_expires_at)
     values($1,$2,$3,$4,$5,$6,'digest','v1',$7,'catalog_creating',clock_timestamp()+$8::interval,$9,$10)`,
    [
      generation,
      team,
      launch,
      revision,
      owner,
      'wake-' + generation,
      input.state,
      input.nextIn,
      input.leaseHeld ? crypto.randomUUID() : null,
      input.leaseHeld ? new Date(Date.now() + 120_000).toISOString() : null
    ]
  );
  // The context's creation intent is not built either.
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      "insert into private.launch_catalog_video_contexts(generation_id,team_id,actor_id,settings_snapshot,request_payload,initial_video_plan,catalog_intent_id,video_set_id)values($1,$2,$3,'{}','{}','{}',gen_random_uuid(),$4)",
      [generation, team, owner, set]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  return { set, generation };
}

const due = async (generation: string) =>
  (
    await db.root<{ now: boolean }>(
      'select next_attempt_at<=clock_timestamp() now from public.team_launch_generations where id=$1',
      [generation]
    )
  )[0]!.now;
const ready = (set: string) =>
  db.root("update private.catalog_video_sets set state='ready' where id=$1", [set]);
const recoverCalls = async () =>
  (await db.root<{ url: string }>('select url from public.test_http_calls')).filter(call =>
    call.url.endsWith('/drive-ops/launches/recover')
  );

it('a set becoming ready makes its interrupted launch due at once and dispatches recovery', async () => {
  await db.root('delete from public.test_http_calls');
  const f = await launchOnSet({ state: 'interrupted', nextIn: '4 minutes' });
  expect(await due(f.generation)).toBe(false);
  await ready(f.set);
  expect(await due(f.generation)).toBe(true);
  expect(await recoverCalls()).toEqual([
    { url: 'https://example.test/functions/v1/drive-ops/launches/recover' }
  ]);
});

it('leaves a launch alone while another worker holds it, or once it has finished', async () => {
  await db.root('delete from public.test_http_calls');
  const held = await launchOnSet({ state: 'interrupted', leaseHeld: true, nextIn: '4 minutes' });
  const done = await launchOnSet({ state: 'succeeded', nextIn: '4 minutes' });
  await ready(held.set);
  await ready(done.set);
  expect(await due(held.generation)).toBe(false);
  expect(await due(done.generation)).toBe(false);
  expect(await recoverCalls()).toEqual([]);
});
