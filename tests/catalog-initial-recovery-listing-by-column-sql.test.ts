import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';

/**
 * next QA 2026-11-17: the per-minute initial catalog recovery listing was the heaviest
 * statement on the shared database (875 ms mean, 6.3 s max), because it handed every intent
 * row whole — ~100 kB of checkpoint each — to the owed and catalog-active helpers
 * (20261217130000). The column-by-column listing must list exactly what the old one listed,
 * in the same order, across every branch of the owed test.
 */
const BEFORE = '20261217120000_admin_analytics_within_timeout.sql';
const owner = '78200000-0000-4000-8000-000000000001';
let db: TeamTestDb, team: string, connection: string;

let seq = 0;
async function material(kind: 'video' | 'catalog', lifecycle = 'active') {
  const n = ++seq;
  const id = (
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
  if (lifecycle === 'trashed')
    await db.root(
      "update public.team_materials set lifecycle='trashed',trashed_at=now() where id=$1",
      [id]
    );
  return id;
}

interface Shape {
  state?: string;
  protocol?: number;
  restitch?: boolean;
  plan?: boolean;
  materialId?: 'active' | 'trashed' | 'malformed';
  ageDays?: number;
  check?: 'verified' | 'reading';
  policy?: boolean;
  pace?: 'later' | 'due' | 'exhausted';
  due?: boolean;
}

async function intent(shape: Shape) {
  const source = await material('video');
  const catalog = await material('catalog', shape.materialId === 'trashed' ? 'trashed' : 'active');
  const id = crypto.randomUUID();
  const state = shape.state ?? 'registered';
  await db.root(
    `insert into private.catalog_generation_intents(id,team_id,video_material_id,actor_id,request_key,request_digest,request_payload,variant,state,checkpoint,created_at,next_attempt_at,lease_expires_at)
     values($1,$2,$3,$4,$5,'digest',$6::jsonb,1,$7,$8::jsonb,now()-make_interval(days=>$9),$10,null)`,
    [
      id,
      team,
      source,
      owner,
      'product-catalog:' + crypto.randomUUID(),
      JSON.stringify({
        catalogVideoProtocolVersion: shape.protocol ?? 1,
        restitchEnabled: shape.restitch ?? false,
        videoVariationCount: 1,
        videoPublication: { mode: 'immediate' }
      }),
      state,
      JSON.stringify({
        materialId: shape.materialId === 'malformed' ? 'not-a-uuid' : catalog,
        ...(shape.plan === false ? {} : { initialVideoPlan: { setId: null } })
      }),
      shape.ageDays ?? 0,
      new Date(Date.now() + (shape.due === false ? 3_600_000 : -60_000)).toISOString()
    ]
  );
  // The checks and policies point at jobs and catalogs this test does not build.
  await db.root('set session_replication_role = replica');
  try {
    if (shape.check)
      await db.root(
        "insert into private.catalog_initial_publication_checks(intent_id,team_id,actor_id,catalog_material_id,job_id,fence,file_id,connection_id,root_folder_id,state) values($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'file',$5,'root',$6)",
        [id, team, owner, catalog, connection, shape.check]
      );
    if (shape.policy)
      await db.root(
        "insert into private.catalog_video_publication_policies(catalog_material_id,team_id,actor_id,revision,mode,target_id) values($1,$2,$3,1,'immediate',gen_random_uuid())",
        [catalog, team, owner]
      );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  if (shape.pace)
    await db.root(
      `insert into private.catalog_initial_publication_reverify(intent_id,team_id,attempts,retry_after,exhausted_at)
       values($1,$2,1,$3,$4)`,
      [
        id,
        team,
        new Date(Date.now() + (shape.pace === 'later' ? 3_600_000 : -60_000)).toISOString(),
        shape.pace === 'exhausted' ? new Date().toISOString() : null
      ]
    );
}

/** The listing as it stands, with its three-row page widened so every intent is compared. */
async function widened(name: string) {
  const [row] = await db.root<{ d: string }>(
    "select pg_get_functiondef('public.service_list_initial_catalog_recovery(integer)'::regprocedure) d"
  );
  const d = row!.d
    .replace('public.service_list_initial_catalog_recovery(', `public.${name}(`)
    .replace('not between 1 and 3', 'not between 1 and 100');
  expect(d).toContain(`public.${name}(`);
  expect(d).toContain('not between 1 and 100');
  await db.root(d);
}

const list = (name: string) =>
  db
    .root<{ v: Array<{ idempotencyKey: string }> }>(`select public.${name}(100) v`)
    .then(rows => rows[0]!.v.map(item => item.idempotencyKey));

let before: string[];
beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: BEFORE });
  await createUser(db, { id: owner, email: 'recovery-listing@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Listing')")
  )[0]!.id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('listing','listing@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;

  const shapes: Shape[] = [
    {},
    { ageDays: 3 },
    { ageDays: 10 },
    { materialId: 'trashed' },
    { materialId: 'malformed' },
    { plan: false },
    { protocol: 2 },
    { check: 'verified' },
    { check: 'reading' },
    { policy: true },
    { pace: 'later' },
    { pace: 'due' },
    { pace: 'exhausted' },
    { restitch: true },
    { state: 'interrupted' },
    { state: 'interrupted', due: false },
    { state: 'created', restitch: true },
    { state: 'canceled' }
  ];
  for (const shape of shapes) await intent(shape);
  await widened('test_listing_before');
  before = await list('test_listing_before');
  await applyMigrationsAfter(db, BEFORE);
  await widened('test_listing_after');
}, 180_000);
afterAll(async () => {
  await db?.close();
});

it('lists what the whole-row listing listed, in the same order', async () => {
  // Owed and unpaced registered intents, and the due interrupted one — not an empty answer.
  expect(before.length).toBeGreaterThanOrEqual(4);
  expect(await list('test_listing_after')).toEqual(before);
});

it('no longer hands an intent row whole to a helper', async () => {
  const [row] = await db.root<{ d: string }>(
    "select pg_get_functiondef('public.service_list_initial_catalog_recovery(integer)'::regprocedure) d"
  );
  expect(row!.d).not.toContain('initial_publication_reverify_owed(i)');
  expect(row!.d).not.toContain('initial_publication_catalog_active(i)');
});
