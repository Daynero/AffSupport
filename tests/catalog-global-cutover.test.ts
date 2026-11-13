import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  globalTestDb,
  globalCutover,
  activateGlobalFixture,
  GLOBAL_OWNER
} from './support/catalog-global-db.js';
import type { TeamTestDb } from './support/team-db.js';
let db: TeamTestDb, team: string;
beforeAll(async () => {
  ({ db, team } = await globalTestDb());
  await db.asUser(GLOBAL_OWNER, 'select public.set_team_product_catalog_settings($1,$2)', [
    team,
    JSON.stringify({
      title: 'Generic item',
      description: 'Generic style',
      priceMin: 10,
      priceMax: 20,
      imageLink: 'https://original.example.test/image.jpg'
    })
  ]);
}, 60_000);
afterAll(async () => {
  await db?.close();
});
it('does not activate without exact source/config/rollback acceptance', async () => {
  const prepared = await globalCutover(db, 'prepare');
  expect(prepared.state).toBe('draining');
  await expect(
    globalCutover(db, 'activate', { manifestDigest: prepared.manifestDigest })
  ).rejects.toThrow('GLOBAL_IMAGE_POLICY_CONFLICT');
});
it('activates once with an exact720-hour hold and refuses mixed settings payloads atomically', async () => {
  const active = await activateGlobalFixture(db);
  expect(active.state).toBe('active');
  expect(Date.parse(String(active.deleteAfter)) - Date.parse(String(active.activatedAt))).toBe(
    720 * 3600_000
  );
  await expect(
    db.asUser(GLOBAL_OWNER, 'select public.set_team_product_catalog_settings($1,$2)', [
      team,
      JSON.stringify({
        title: 'Changed',
        description: 'Changed',
        priceMin: 40,
        priceMax: 50,
        imageLink: null
      })
    ])
  ).rejects.toThrow('GLOBAL_IMAGE_SETTINGS_RETIRED');
  const [old] = await db.root<{ title: string; image_link: string }>(
    'select title,image_link from public.team_product_catalog_settings where team_id=$1',
    [team]
  );
  expect(old!.title).toBe('Generic item');
  expect(old!.image_link).toContain('original');
  await db.asUser(GLOBAL_OWNER, 'select public.set_team_product_catalog_settings($1,$2)', [
    team,
    JSON.stringify({ title: 'New generic', description: 'Style', priceMin: 30, priceMax: 40 })
  ]);
  const [kept] = await db.root<{ image_link: string }>(
    'select image_link from public.team_product_catalog_settings where team_id=$1',
    [team]
  );
  expect(kept!.image_link).toBe(old!.image_link);
  const [visible] = await db.asUser<{ image_link: null }>(
    GLOBAL_OWNER,
    'select image_link from public.get_team_product_catalog_settings_v3($1)',
    [team]
  );
  expect(visible!.image_link).toBeNull();
  await expect(
    db.root("update private.catalog_global_policy set delete_after=delete_after+interval '1 hour'")
  ).rejects.toThrow('GLOBAL_IMAGE_POLICY_CONFLICT');
});
it('keeps global Launch settings identity independent of retired image metadata', async () => {
  const before = (
    await db.root<{ version: string }>(
      'select private.launch_catalog_settings_version($1) version',
      [team]
    )
  )[0]!.version;
  await db.root(
    'update public.team_product_catalog_settings set image_link=null,updated_at=clock_timestamp() where team_id=$1',
    [team]
  );
  expect(
    (
      await db.root<{ version: string }>(
        'select private.launch_catalog_settings_version($1) version',
        [team]
      )
    )[0]!.version
  ).toBe(before);
});
