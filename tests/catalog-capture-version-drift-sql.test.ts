import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: creating a no-restitch catalog shares the original video, which
 * advances its Drive version; the background sync wrote that version into
 * team_materials before the capture ran and the capture answered
 * SOURCE_CHANGED (HTTP 409), so the deferred catalog lost its publication.
 */
let db: TeamTestDb, team: string, connection: string;
const owner = '78000000-0000-4000-8000-000000000001';
const checksum = 'a'.repeat(32);
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'capture-drift@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Drift')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('drift','drift@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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
async function scenario(provenChecksum: string) {
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
  const preferences = {
    catalogVideoProtocolVersion: 1,
    restitchEnabled: false,
    videoVariationCount: 1,
    videoPublication: { mode: 'immediate' }
  };
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,'finalized',$7::jsonb)",
    [
      intent,
      team,
      source,
      owner,
      'product-catalog:' + crypto.randomUUID(),
      JSON.stringify(preferences),
      JSON.stringify({
        materialId: catalog,
        ['source_' + source]: { id: 'video' + n, version: 'v1', checksum: provenChecksum }
      })
    ]
  );
  // Sharing the original advanced its Drive version; the sync stored it.
  await db.root("update public.team_materials set drive_version='v2' where id=$1", [source]);
  const observed = {
    fileId: 'video' + n,
    version: 'v2',
    checksum,
    sizeBytes: 11,
    mimeType: 'video/mp4'
  };
  return () =>
    db.root<{ value: { version: string } }>(
      'select public.service_capture_initial_catalog_publication_source($1,$2,$3,$4,$5,$6,$7,$8::jsonb) value',
      [team, owner, intent, source, connection, observed.fileId, 'v1', JSON.stringify(observed)]
    );
}

it('accepts a version drift when the bytes are the ones the catalog was built from', async () => {
  const capture = await scenario(checksum);
  expect((await capture())[0]!.value.version).toBe('v2');
});

it('still refuses a drift whose bytes differ from the creation proof', async () => {
  const capture = await scenario('b'.repeat(32));
  await expect(capture()).rejects.toThrow('SOURCE_CHANGED');
});
