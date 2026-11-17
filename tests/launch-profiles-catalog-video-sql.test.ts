import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';
import { launchConfig } from './fixtures/launches';

/**
 * next QA 2026-11-17: saving a catalog launch's settings for its offer failed with «Частина
 * даних некоректна», because the profile row check did not know the catalog video keys the
 * editor has carried since 20261207171000 (20261217150000).
 */
const BEFORE = '20261217140000_catalog_pending_transcript_sweep.sql';
const owner = '71000000-0000-4000-8000-000000000091';
let db: TeamTestDb, team: string, offer: string;
const sub = launchConfig().subConfig;

/** The catalog an owner's draft held when the save failed on next. */
const catalog = {
  catalogVideoProtocolVersion: 1,
  copyVideoToR2: true,
  customFinalDurationSeconds: 3120,
  finalDurationMode: 'random-centered',
  finalDurationRangeSeconds: [2820, 3420],
  productCount: 100,
  restitchEnabled: true,
  videoPublication: { mode: 'immediate' },
  videoVariationCount: 5
};
const profile = (c: Record<string, unknown> = catalog) => ({
  campaignCount: 7,
  minBudget: 15,
  maxBudget: 35,
  budgetMode: 'auto',
  budgets: null,
  adsCount: 3,
  age: 45,
  gender: 'M',
  method: 'catalog',
  advantagePlus: false,
  catalog: c,
  launchDate: '2026-11-18',
  timezone: 'Europe/Kyiv',
  originalUrl: 'https://example.invalid/?sub_1=a&fb_pixel=965510142880871'
});
/** Saves over whatever the profile holds, so each case is judged on its values alone. */
async function save(offerId: string | null, values: unknown) {
  const [current] = await db.asUser<{ result: { version: string } | null }>(
    owner,
    offerId
      ? 'select public.get_launch_offer_defaults($1,$2) result'
      : 'select public.get_launch_defaults($1) result',
    offerId ? [team, offerId] : [team]
  );
  const version = current?.result?.version ?? null;
  return db.asUser<{ result: { version: string } }>(
    owner,
    offerId
      ? 'select public.set_launch_offer_defaults($1,$2,$3,$4,$5::jsonb,$6::jsonb) result'
      : 'select public.set_launch_defaults($1,$2,$3,$4::jsonb,$5::jsonb) result',
    offerId
      ? [team, offerId, version, crypto.randomUUID(), JSON.stringify(values), JSON.stringify(sub)]
      : [team, version, crypto.randomUUID(), JSON.stringify(values), JSON.stringify(sub)]
  );
}

let refusedBefore = '';
beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: BEFORE });
  await createUser(db, { id: owner, email: 'profile-catalog-video@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Profiles')")
  )[0]!.id;
  offer = (
    await db.asUser<{ result: { id: string } }>(
      owner,
      "select public.create_launch_dictionary($1,'offers','Prostavia ID',$2) result",
      [team, crypto.randomUUID()]
    )
  )[0]!.result.id;
  refusedBefore = await save(offer, profile()).then(
    () => 'saved',
    (error: Error) => error.message
  );
  await applyMigrationsAfter(db, BEFORE);
}, 180_000);
afterAll(async () => {
  await db?.close();
});

it('refused the catalog video keys before', () => {
  expect(refusedBefore).toContain('INVALID_INPUT');
});

it('saves and returns a catalog launch profile for the offer and for the space', async () => {
  await save(offer, profile());
  await save(null, profile());
  const [row] = await db.asUser<{ result: { config: { catalog: unknown } } }>(
    owner,
    'select public.get_launch_offer_defaults($1,$2) result',
    [team, offer]
  );
  expect(row!.result.config.catalog).toEqual(catalog);
  await save(
    offer,
    profile({
      productCount: 10,
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    })
  );
});

it('keeps a scheduled publication', async () => {
  await save(
    offer,
    profile({
      ...catalog,
      videoPublication: {
        mode: 'scheduled',
        localDateTime: '2026-11-18T09:00',
        timeZone: 'Europe/Kyiv',
        resolvedOffset: '+02:00',
        dueAt: '2026-11-18T07:00:00.000Z'
      }
    })
  );
});

it.each([
  ['an unknown protocol', { ...catalog, catalogVideoProtocolVersion: 2 }],
  ['no variations', { ...catalog, videoVariationCount: 0 }],
  ['a fractional variation count', { ...catalog, videoVariationCount: 1.5 }],
  ['variations without the protocol', { ...catalog, catalogVideoProtocolVersion: undefined }],
  ['the protocol without a publication', { ...catalog, videoPublication: undefined }],
  ['an unknown publication mode', { ...catalog, videoPublication: { mode: 'later' } }],
  ['an extra publication key', { ...catalog, videoPublication: { mode: 'immediate', x: 1 } }],
  [
    'a scheduled publication without its moment',
    { ...catalog, videoPublication: { mode: 'scheduled', timeZone: 'Europe/Kyiv' } }
  ],
  ['an unknown catalog key', { ...catalog, somethingElse: true }]
])('still refuses %s', async (_, c) => {
  await expect(save(offer, profile(JSON.parse(JSON.stringify(c))))).rejects.toThrow(
    /INVALID_INPUT/u
  );
});
