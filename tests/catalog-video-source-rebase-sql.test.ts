import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Owner QA 2026-11-15: a bulk launch stopped at 4 of 5 videos because Drive moved
 * BG_8.mp4 from version 5 to 9 with the same md5 (a metadata-only change). The set
 * now rebases to the live version when the bytes are the same (20261215110000).
 */
let db: TeamTestDb, team: string, connection: string;
const owner = 'c5152000-0000-4000-8000-000000000001';
const md5 = 'a'.repeat(32);

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'rebase@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Rebase')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('rebase','rebase@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
  // The executor's claim is proven elsewhere; this test is about the version move.
  await db.root(
    "create or replace function public.service_authorize_catalog_video_executor(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer) returns jsonb language sql as $$ select '{}'::jsonb $$"
  );
}, 180_000);
afterAll(async () => {
  await db?.close();
});

async function setWithFourDone(driveVersion: string, checksum: string) {
  const source = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version,checksum) values($1,$2,$3,'BG_8.mp4','file','video','video/mp4',$4,$5) returning id",
      [team, connection, 'drive-' + crypto.randomUUID(), driveVersion, checksum]
    )
  )[0]!.id;
  const set = crypto.randomUUID();
  const operations: string[] = [];
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      `insert into private.catalog_video_sets(id,team_id,actor_id,source_material_id,source_version,source_snapshot,settings_snapshot,settings_digest,requested_count,product_count,recipe_revision,assignment_seed,assignment_version,catalog_intent_id,state)
       values($1,$2,$3,$4,'5',jsonb_build_object('version','5','checksum',$5::text),'{}'::jsonb,$6,5,100,1,$6,1,gen_random_uuid(),'preparing')`,
      [set, team, owner, source, md5, 'd'.repeat(64)]
    );
    for (let index = 0; index < 5; index++) {
      const operation = index < 4 ? crypto.randomUUID() : null;
      if (operation) {
        operations.push(operation);
        await db.root(
          "insert into public.team_operations(id,team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at) values($1,$2,$3,'process','succeeded',$4,$5,$5,now())",
          [operation, team, owner, source, 'catalog-variant:' + crypto.randomUUID()]
        );
        await db.root(
          "insert into private.team_operation_intents(operation_id,team_id,tool_id,expected_source_version) values($1,$2,'restitch','5')",
          [operation, team]
        );
      }
      await db.root(
        'insert into private.catalog_video_variants(video_set_id,team_id,video_variant_index,request_id,operation_id,state,output_material_id) values($1,$2,$3,$4,$5,$6,$7)',
        [
          set,
          team,
          index,
          crypto.randomUUID(),
          operation,
          operation ? 'registered' : 'queued',
          operation ? crypto.randomUUID() : null
        ]
      );
    }
  } finally {
    await db.root('set session_replication_role = origin');
  }
  return { set, source, operations };
}

const rebase = (set: string, version: string, checksum: string) =>
  db.root<{ ok: boolean }>(
    "select public.service_rebase_catalog_video_source($1,'\\x00'::bytea,gen_random_uuid(),1,$2,$3) ok",
    [set, version, checksum]
  );

it('moves the set and its done variants to the live version when the bytes are the same', async () => {
  const { set, operations } = await setWithFourDone('9', md5);
  expect((await rebase(set, '9', md5))[0]!.ok).toBe(true);
  expect(
    (
      await db.root<{ v: string; snap: string }>(
        "select source_version v, source_snapshot->>'version' snap from private.catalog_video_sets where id=$1",
        [set]
      )
    )[0]
  ).toEqual({ v: '9', snap: '9' });
  const versions = await db.root<{ expected_source_version: string }>(
    'select expected_source_version from private.team_operation_intents where operation_id = any($1::uuid[])',
    [operations]
  );
  expect(versions.map(row => row.expected_source_version)).toEqual(['9', '9', '9', '9']);
});

it('refuses when the bytes really changed, and leaves the set as it was', async () => {
  const { set } = await setWithFourDone('9', 'b'.repeat(32));
  await expect(rebase(set, '9', 'b'.repeat(32))).rejects.toThrow(/SOURCE_CHANGED/);
  expect(
    (
      await db.root<{ v: string }>(
        'select source_version v from private.catalog_video_sets where id=$1',
        [set]
      )
    )[0]!.v
  ).toBe('5');
});

it('refuses a version the row does not hold yet', async () => {
  const { set } = await setWithFourDone('7', md5);
  await expect(rebase(set, '9', md5)).rejects.toThrow(/SOURCE_CHANGED/);
});
