import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';

/**
 * next QA 2026-11-17: a catalog launch stopped after its catalog was created, and «Повторити»
 * answered WRONG_STATE every time. The catalog stored the link with SUB3 bound to its name;
 * the resume looked for it by the request's unbound link and never found it (20261217170000).
 */
const BEFORE = '20261217160000_business_errors_not_serialization_failures.sql';
const owner = '78300000-0000-4000-8000-000000000001';
const requested = 'https://offer.example.invalid/?sub_1=goor&sub_3=000';
const bound = 'https://offer.example.invalid/?sub_1=goor&sub_3=ID_2_v2_catalog';
let db: TeamTestDb, team: string, connection: string;

let seq = 0;
async function material(kind: 'video' | 'catalog') {
  const n = ++seq;
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file',$4,$5,'v1') returning id",
      [
        team,
        connection,
        kind + n,
        kind === 'video' ? 'video' : 'other',
        kind === 'video' ? 'video/mp4' : 'application/vnd.google-apps.spreadsheet'
      ]
    )
  )[0]!.id;
}

/** A created catalog whose row holds `stored`, and the intent that made it. */
async function created(stored: string, binding: string | null) {
  const video = await material('video');
  const catalog = await material('catalog');
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,variant) values($1,$2,$3,$4,100,'https://docs.google.com/spreadsheets/d/s/edit','https://drive.google.com/file/d/v/view','{}',2)",
    [catalog, team, video, stored]
  );
  const id = crypto.randomUUID();
  await db.root(
    "insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint) values($1,$2,$3,$4,$5,'digest',$6::jsonb,2,'interrupted',$7::jsonb)",
    [
      id,
      team,
      video,
      owner,
      'launch:' + crypto.randomUUID() + ':catalog',
      JSON.stringify({ sourceLink: requested, productCount: 100 }),
      JSON.stringify({
        materialId: catalog,
        ...(binding
          ? {
              launchSubBinding: { advertisingUrl: binding, name: 'ID_2_v2_catalog', subValues: {} }
            }
          : {})
      })
    ]
  );
  return { id, catalog };
}

const reconcile = (intent: string) =>
  db
    .root<{ r: { catalog: { materialId: string } } | null }>(
      'select public.service_reconcile_catalog_result($1,$2,$3) r',
      [team, intent, owner]
    )
    .then(rows => rows[0]!.r?.catalog.materialId ?? null);

let boundLaunch: { id: string; catalog: string };
let foundBefore: string | null;
beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: BEFORE });
  await createUser(db, { id: owner, email: 'reconcile-bound@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Reconcile')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('reconcile','reconcile@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
  boundLaunch = await created(bound, bound);
  foundBefore = await reconcile(boundLaunch.id);
  await applyMigrationsAfter(db, BEFORE);
}, 180_000);
afterAll(async () => {
  await db?.close();
});

it('did not find a launch catalog stored under its bound link', () => {
  expect(foundBefore).toBeNull();
});

it('finds it now, so the resume registers the catalog instead of creating it again', async () => {
  expect(await reconcile(boundLaunch.id)).toBe(boundLaunch.catalog);
});

it('still finds a catalog stored under the request link', async () => {
  const plain = await created(requested, null);
  expect(await reconcile(plain.id)).toBe(plain.catalog);
});

it('does not take a catalog under some other link', async () => {
  const other = await created('https://offer.example.invalid/?sub_3=foreign', bound);
  expect(await reconcile(other.id)).toBeNull();
});
