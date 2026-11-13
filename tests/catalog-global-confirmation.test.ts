import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  globalTestDb,
  activateGlobalFixture,
  GLOBAL_OWNER,
  GLOBAL_IMAGE
} from './support/catalog-global-db.js';
import type { TeamTestDb } from './support/team-db.js';
import { globalFixtureId } from './fixtures/catalog-global.js';
let db: TeamTestDb, team: string;
beforeAll(async () => {
  ({ db, team } = await globalTestDb());
  await activateGlobalFixture(db);
}, 60_000);
afterAll(async () => {
  await db?.close();
});
it('counts4999→5000→5001, keeps old pairs and never blocks on threshold', async () => {
  // Seed only aggregate history; synthetic status tests do not claim5000 real users.
  await db.root(
    'update private.catalog_global_images set issued_seq=4999,confirmed_uses=4999 where id=$1',
    [GLOBAL_IMAGE]
  );
  await db.root(
    `insert into private.catalog_global_aliases(image_id,generation,public_url,key_version,state,identity_revision,identity_verified_at)
 select $1,g,'https://media.example.test/g/generation-'||g||'.jpg',1,'ready','fixture-v1',clock_timestamp() from generate_series(25,28)g`,
    [GLOBAL_IMAGE]
  );
  for (let n = 0; n < 2; n++) {
    const catalog = globalFixtureId(63000 + n),
      intent = globalFixtureId(64000 + n);
    await db.root('select public.service_catalog_global_allocate($1,$2,$3,$4,200,1)', [
      GLOBAL_OWNER,
      team,
      catalog,
      intent
    ]);
    expect(
      (
        await db.root<{ value: { confirmed: number } }>(
          'select public.service_catalog_global_confirm($1,$2,$3) value',
          [team, intent, intent]
        )
      )[0]!.value.confirmed
    ).toBe(1);
    expect(
      (
        await db.root<{ value: { confirmed: number } }>(
          'select public.service_catalog_global_confirm($1,$2,$3) value',
          [team, intent, intent]
        )
      )[0]!.value.confirmed
    ).toBe(0);
  }
  expect(
    (
      await db.root<{ issued: string; confirmed: string }>(
        'select issued_seq::text issued,confirmed_uses::text confirmed from private.catalog_global_images where id=$1',
        [GLOBAL_IMAGE]
      )
    )[0]
  ).toEqual({ issued: '5001', confirmed: '5001' });
});
it('does not confirm an unknown or foreign intent', async () => {
  await expect(
    db.root('select public.service_catalog_global_confirm($1,$2,$2)', [
      team,
      globalFixtureId(65000)
    ])
  ).rejects.toThrow('PERMISSION_DENIED');
});
it('preserves pair tombstones and aggregates when the team is removed', async () => {
  const before = (
    await db.root<{ n: number }>('select count(*)::int n from private.catalog_global_assignments')
  )[0]!.n;
  await db.root('delete from public.teams where id=$1', [team]);
  expect(
    (
      await db.root<{ n: number }>('select count(*)::int n from private.catalog_global_assignments')
    )[0]!.n
  ).toBe(before);
  const rows = await db.root<{ closed: boolean; team_id: null; actor_id: null; material_id: null }>(
    'select closed,team_id,actor_id,material_id from private.catalog_global_identities'
  );
  expect(
    rows.every(
      row => row.closed && row.team_id === null && row.actor_id === null && row.material_id === null
    )
  ).toBe(true);
  expect(
    (
      await db.root<{ confirmed_uses: string }>(
        'select confirmed_uses::text from private.catalog_global_images where id=$1',
        [GLOBAL_IMAGE]
      )
    )[0]!.confirmed_uses
  ).toBe('5001');
});
