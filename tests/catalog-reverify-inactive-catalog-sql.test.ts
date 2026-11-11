import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3 QA round 2 (N3): a registered catalog moved to the trash was still
 * re-verified every five minutes, up to twelve times, each attempt ending
 * PROCESS_RESULT_UNCERTAIN, because "owed" never looked at the catalog material.
 */
let db: TeamTestDb, team: string, connection: string;
const owner = '78100000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'reverify-trash@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Trash')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('trash','trash@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
}, 180_000);
afterAll(async () => {
  await db?.close();
});

let seq = 0;
async function registeredCatalog() {
  const n = ++seq;
  const material = async (video: boolean) =>
    (
      await db.root<{ id: string }>(
        "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file',$4,$5,'v1') returning id",
        [
          team,
          connection,
          (video ? 'video' : 'catalog') + n,
          video ? 'video' : 'other',
          video ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet'
        ]
      )
    )[0]!.id;
  const source = await material(true),
    catalog = await material(false),
    intent = crypto.randomUUID();
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,'registered',$7::jsonb)",
    [
      intent,
      team,
      source,
      owner,
      'product-catalog:' + crypto.randomUUID(),
      JSON.stringify({
        catalogVideoProtocolVersion: 1,
        restitchEnabled: false,
        videoVariationCount: 1,
        videoPublication: { mode: 'immediate' }
      }),
      JSON.stringify({ materialId: catalog, initialVideoPlan: { setId: null } })
    ]
  );
  return { intent, catalog };
}

const claim = (intent: string) =>
  db
    .root<{ v: string }>('select public.service_claim_initial_publication_reverify($1,$2,$3) v', [
      team,
      owner,
      intent
    ])
    .then(r => r[0]!.v);
const listed = async (intent: string) => {
  const key = (
    await db.root<{ k: string }>(
      'select request_key k from private.catalog_generation_intents where id=$1',
      [intent]
    )
  )[0]!.k;
  const list = (
    await db.root<{ v: { idempotencyKey: string }[] }>(
      'select public.service_list_initial_catalog_recovery(3) v'
    )
  )[0]!.v;
  return list.some(x => x.idempotencyKey === key);
};
const reverifyRow = (intent: string) =>
  db
    .root<{ attempts: number; exhausted: boolean; last_code: string | null }>(
      'select attempts,exhausted_at is not null exhausted,last_code from private.catalog_initial_publication_reverify where intent_id=$1',
      [intent]
    )
    .then(r => r[0]);

it('re-verifies a registered catalog with no policy while it is active', async () => {
  const { intent } = await registeredCatalog();
  expect(await listed(intent)).toBe(true);
  expect(await claim(intent)).toBe('go');
  expect(await reverifyRow(intent)).toMatchObject({ attempts: 1, exhausted: false });
});

it('stops re-verifying once the catalog is trashed and closes the paced row', async () => {
  const { intent, catalog } = await registeredCatalog();
  expect(await claim(intent)).toBe('go');
  // The previous attempt is no longer paced: the next pass would retry.
  await db.root(
    "update private.catalog_initial_publication_reverify set retry_after='-infinity',last_code='PROCESS_RESULT_UNCERTAIN' where intent_id=$1",
    [intent]
  );
  await db.root(
    "update public.team_materials set lifecycle='trashed',trashed_at=now() where id=$1",
    [catalog]
  );

  expect(await listed(intent)).toBe(false);
  expect(await claim(intent)).toBe('exhausted');
  expect(await reverifyRow(intent)).toMatchObject({
    attempts: 1,
    exhausted: true,
    last_code: 'CATALOG_INACTIVE'
  });
  // A repeated claim stays exhausted and does not spend an attempt.
  expect(await claim(intent)).toBe('exhausted');
  expect(await reverifyRow(intent)).toMatchObject({ attempts: 1 });
});

it('owes nothing for a catalog whose material is missing', async () => {
  const { intent, catalog } = await registeredCatalog();
  await db.root(
    "update public.team_materials set lifecycle='missing',missing_at=now() where id=$1",
    [catalog]
  );
  expect(await listed(intent)).toBe(false);
  expect(await claim(intent)).toBe('exhausted');
});
