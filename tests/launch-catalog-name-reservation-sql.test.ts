import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Owner QA 2026-11-15: a launch showed «Резервуємо назву каталогу…» for the whole
 * restitch, because the catalog number was allocated only when the catalog step
 * began. The number is now reserved when the generation is admitted
 * (20261215100000) and every allocation honours it.
 */
let db: TeamTestDb, team: string, connection: string;
const owner = 'c5151000-0000-4000-8000-000000000001';
const executor = 'c5151000-0000-4000-8000-000000000002';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'catalog-name@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Names')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('names','names@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
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

async function video(name: string) {
  return (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$4,'file','video','video/mp4','v1') returning id",
      [team, connection, 'drive-' + crypto.randomUUID(), name]
    )
  )[0]!.id;
}

async function generation(config: Record<string, unknown>, state = 'accepted') {
  const launch = (
    await db.root<{ id: string }>(
      'insert into public.team_launches(team_id,created_by)values($1,$2)returning id',
      [team, owner]
    )
  )[0]!.id;
  const revision = (
    await db.root<{ id: string }>(
      "insert into public.team_launch_revisions(team_id,launch_id,revision_no,result_kind,config,sources,original_url,generated_url,sub_values,created_by)values($1,$2,1,'generated',$3,'{}','https://example.invalid/','https://example.invalid/','{}',$4)returning id",
      [team, launch, config, owner]
    )
  )[0]!.id;
  const id = crypto.randomUUID();
  await db.root(
    `insert into public.team_launch_generations(id,team_id,launch_id,revision_id,actor_id,request_key,request_digest,input_version,state,stage)
     values($1,$2,$3,$4,$5,$6,'digest','v1',$7,'accepted')`,
    [id, team, launch, revision, owner, 'names-' + id, state]
  );
  return id;
}

const reserved = async (generationId: string) =>
  (
    await db.root<{ variant: number }>(
      'select variant from private.launch_catalog_name_reservations where generation_id=$1',
      [generationId]
    )
  )[0]?.variant ?? null;

const begin = async (videoId: string, key: string) =>
  (
    await db.root<{ v: { variant: number } }>(
      'select public.service_begin_catalog_intent($1,$2,$3,$4,$5,$6)v',
      [team, videoId, owner, key, {}, executor]
    )
  )[0]!.v.variant;

it('reserves the next catalog number when a catalog launch is admitted', async () => {
  const source = await video('MY_1.mp4');
  expect(await begin(source, 'manual-first-' + crypto.randomUUID())).toBe(1);
  const launch = await generation({ method: 'catalog', materialId: source });
  expect(await reserved(launch)).toBe(2);
  // A catalog made by hand meanwhile does not take the launch's number.
  expect(await begin(source, 'manual-second-' + crypto.randomUUID())).toBe(3);
  // The launch's own catalog takes exactly the number it reserved.
  expect(await begin(source, `launch:${launch}:catalog`)).toBe(2);
});

it('reports the reserved name from the first read, before the catalog step', async () => {
  const source = await video('  Promo  clip.mp4');
  const launchGeneration = await generation({ method: 'catalog', materialId: source });
  const launch = (
    await db.root<{ launch_id: string }>(
      'select launch_id from public.team_launch_generations where id=$1',
      [launchGeneration]
    )
  )[0]!.launch_id;
  const detail = (
    await db.asUser<{ v: { pendingCatalogName?: string | null; generation?: { id: string } } }>(
      owner,
      'select public.get_launch($1,$2) v',
      [team, launch]
    )
  )[0]!.v;
  expect(detail.generation?.id).toBe(launchGeneration);
  expect(detail.pendingCatalogName).toBe('Promo clip_v1_catalog');
});

it('reserves nothing for a launch without a catalog, and frees a canceled reservation', async () => {
  const source = await video('Other.mp4');
  expect(await reserved(await generation({ method: 'other', materialId: source }))).toBeNull();
  const canceled = await generation({ method: 'catalog', materialId: source });
  expect(await reserved(canceled)).toBe(1);
  await db.root("update public.team_launch_generations set state='canceled' where id=$1", [
    canceled
  ]);
  expect(await begin(source, 'manual-after-cancel-' + crypto.randomUUID())).toBe(1);
});

it('never blocks admission when the reservation cannot be made', async () => {
  const launch = await generation({ method: 'catalog', materialId: crypto.randomUUID() });
  expect(
    (
      await db.root<{ n: number }>(
        'select count(*)::int n from public.team_launch_generations where id=$1',
        [launch]
      )
    )[0]!.n
  ).toBe(1);
});
