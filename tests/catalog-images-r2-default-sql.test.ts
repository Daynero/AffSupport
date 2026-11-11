import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: every new space gets R2 catalog images from the start. The config row is
 * created lazily by the image control the first time a space opens its image
 * settings; it must start enabled, while rows written earlier keep their value.
 */
let db: TeamTestDb, fresh: string, earlier: string;
const ACTOR = '76000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: ACTOR, email: 'r2-default@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [ACTOR]);
  const create = async (name: string) =>
    (await db.asUser<{ id: string }>(ACTOR, 'select id from public.create_team($1)', [name]))[0]!
      .id;
  fresh = await create('Fresh space');
  earlier = await create('Earlier space');
  // A space whose row was written before 1.4.3, or switched off on purpose.
  await db.root(
    'insert into private.catalog_image_config(team_id,import_enabled) values($1,false)',
    [earlier]
  );
}, 240000);
afterAll(async () => {
  await db?.close();
});

const capabilities = async (team: string) =>
  (
    await db.root<{ v: { enabled: boolean; importEnabled: boolean; mode: string } }>(
      "select public.service_catalog_image_control_v2('capabilities',$1,$2)v",
      [ACTOR, { teamId: team }]
    )
  )[0]!.v;

it('defaults import_enabled to true for a newly created config row', async () => {
  const rows = await db.root<{ d: string }>(
    "select column_default d from information_schema.columns where table_schema='private' and table_name='catalog_image_config' and column_name='import_enabled'"
  );
  expect(rows[0]!.d).toBe('true');
});

it('creates the lazy row of a new space enabled, in legacy mode until its first image', async () => {
  expect(
    await db.root('select 1 from private.catalog_image_config where team_id=$1', [fresh])
  ).toHaveLength(0);
  expect(await capabilities(fresh)).toMatchObject({
    enabled: true,
    importEnabled: true,
    mode: 'legacy'
  });
  const row = await db.root<{ import_enabled: boolean }>(
    'select import_enabled from private.catalog_image_config where team_id=$1',
    [fresh]
  );
  expect(row[0]!.import_enabled).toBe(true);
});

it('leaves a row written before the change as it was', async () => {
  expect(await capabilities(earlier)).toMatchObject({ enabled: false, importEnabled: false });
});
