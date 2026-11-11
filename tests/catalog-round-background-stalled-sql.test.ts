import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-11 (QA MEDIUM-13): a manager round with restitch sat in
 * «Очікуємо підготовку відео…» for good. Its set was accepted for this
 * computer's background work, a live delegation existed, but the agent's
 * worker had parked and claimed nothing since. The row now says so, and Stop
 * closes such a round.
 */
let db: TeamTestDb, team: string, catalog: string, source: string, setId: string;
const owner = 'c1739000-0000-4000-8000-000000000001',
  request = 'c1739000-0000-4000-8000-000000000002';
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'round-stalled@example.invalid' });
  await db.root('insert into public.admin_users(user_id)values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Round stalled')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(connected_by,google_permission_id,google_account_email,vault_secret_id,scope)values($1,'round-stalled','stalled@example.invalid',gen_random_uuid(),'https://www.googleapis.com/auth/drive.file')returning id",
      [owner]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)values($1,$2,'root','Root','my_drive','connected')returning id",
      [team, cred]
    )
  )[0]!.id;
  const material = async (video: boolean) =>
    (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,size_bytes,checksum,drive_version)values($1,$2,$3,$3,'file',$4,$5,4,$6,'1')returning id",
        [
          team,
          connection,
          video ? 'source' : 'sheet',
          video ? 'video' : 'other',
          video ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet',
          'a'.repeat(32)
        ]
      )
    )[0]!.id;
  source = await material(true);
  catalog = await material(false);
  await db.root(
    "update public.team_materials set companion_of=$2,companion_kind='product_catalog'where id=$1",
    [catalog, source]
  );
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot)values($1,$2,$3,'https://example.invalid/',3,'https://docs.google.com/spreadsheets/d/fixture/edit','https://drive.google.com/file/d/source/view','{}')",
    [catalog, team, source]
  );
  await db.root(
    "insert into public.team_restitch_defaults(team_id,operation,start_image_ids,configured)values($1,'restitch',array[gen_random_uuid()],true)",
    [team]
  );
  await db.root(
    'insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)values($1,$2,gen_random_uuid(),$3)',
    [team, owner, Buffer.alloc(32, 0xab)]
  );
  await db.root(
    'insert into public.team_catalog_update_profiles(catalog_material_id,team_id,refresh_images,refresh_texts,grow_products,random_link_variation,restitch)values($1,$2,true,true,false,false,true)on conflict(catalog_material_id)do update set restitch=true',
    [catalog, team]
  );
  const admitted = (
    await db.root<{ v: { set_id: string } }>(
      'select public.service_accept_catalog_updater_variants($1,$2,$3,$4,1,(select version from public.team_catalog_update_profiles where catalog_material_id=$3))v',
      [team, owner, catalog, request]
    )
  )[0]!.v;
  setId = admitted.set_id;
}, 240_000);
afterAll(async () => {
  await db?.close();
});

/** The admitted set, created the way the server admits it, as the beta round was. */
const ensureSet = async () => {
  const rows = await db.root<{ executor_id: string }>(
    'select executor_id from private.catalog_video_sets where id=$1',
    [setId]
  );
  if (!rows.length) {
    const r = (
      await db.root<{ executor_id: string; attempt_id: string; settings_snapshot: unknown }>(
        'select executor_id,attempt_id,settings_snapshot from private.catalog_updater_variant_requests where request_id=$1',
        [request]
      )
    )[0]!;
    await db.root(
      "insert into private.catalog_video_sets(id,team_id,actor_id,update_attempt_id,source_material_id,source_version,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,executor_id,epoch)values($1,$2,$3,$4,$5,'1',$6,repeat('b',64),1,3,1,repeat('c',64),1,$7,1)",
      [setId, team, owner, r.attempt_id, source, r.settings_snapshot, r.executor_id]
    );
  }
  const executor = (
    await db.root<{ executor_id: string }>(
      'select executor_id from private.catalog_video_sets where id=$1',
      [setId]
    )
  )[0]!.executor_id;
  await db.root(
    'update private.team_recovery_delegations set installation_id=$2 where team_id=$1',
    [team, executor]
  );
};
const progress = async () =>
  (
    await db.root<{ v: Record<string, unknown> | null }>(
      'select private.catalog_registry_video_generation($1,$2)v',
      [team, catalog]
    )
  )[0]!.v;
const age = (minutes: number) =>
  db.root(
    'update private.catalog_video_sets set created_at=clock_timestamp()-make_interval(mins=>$2) where id=$1',
    [setId, minutes]
  );

it('says nothing during the first minutes of an accepted round', async () => {
  await ensureSet();
  await age(1);
  await db.root(
    'update private.team_recovery_delegations set last_claim_at=null where team_id=$1',
    [team]
  );
  const value = await progress();
  expect(value).toMatchObject({ setId, state: 'accepted' });
  expect(value).not.toHaveProperty('backgroundStalled');
  expect(value).not.toHaveProperty('waitReason');
});

it('flags background work that has not claimed since the round was accepted', async () => {
  await age(5);
  await db.root(
    "update private.team_recovery_delegations set last_claim_at=clock_timestamp()-interval '6 hours' where team_id=$1",
    [team]
  );
  expect(await progress()).toMatchObject({ setId, state: 'accepted', backgroundStalled: true });
});

it('does not flag background work that is claiming', async () => {
  await db.root(
    'update private.team_recovery_delegations set last_claim_at=clock_timestamp() where team_id=$1',
    [team]
  );
  expect(await progress()).not.toHaveProperty('backgroundStalled');
});

it('names a missing background delegation as AGENT_REQUIRED', async () => {
  await db.root(
    'update private.team_recovery_delegations set revoked_at=clock_timestamp() where team_id=$1',
    [team]
  );
  const value = await progress();
  expect(value).toMatchObject({ state: 'accepted', waitReason: 'AGENT_REQUIRED' });
  expect(value).not.toHaveProperty('backgroundStalled');
});

it('Stop closes the unclaimed round', async () => {
  const receipt = (
    await db.root<{ v: Record<string, unknown> }>(
      'select public.service_cancel_catalog_updater_variants($1,$2,$3,$4)v',
      [team, owner, catalog, request]
    )
  )[0]!.v;
  expect(receipt).toMatchObject({ requestId: request, state: 'canceled' });
  expect(
    (
      await db.root<{ result: string }>(
        'select result from public.team_catalog_update_attempts where catalog_material_id=$1',
        [catalog]
      )
    )[0]!.result
  ).toBe('cancelled');
});
