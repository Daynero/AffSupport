import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { launchConfig } from './fixtures/launches';
const owner = '71000000-0000-4000-8000-000000000081';
const viewer = '71000000-0000-4000-8000-000000000082';
let db: TeamTestDb;
let team: string;
let otherTeam: string;
let offer: string;
let otherOffer: string;
let foreignOffer: string;
const sub = launchConfig().subConfig;
const config = {
  campaignCount: 3,
  minBudget: 10,
  maxBudget: 30,
  budgetMode: 'manual',
  budgets: [10, 21, 30]
};
const save = (
  offerId: string | null,
  version: string | null,
  key = crypto.randomUUID(),
  values: unknown = config,
  actor = owner
) =>
  db.asUser<{ result: { version: string } }>(
    actor,
    offerId
      ? 'select public.set_launch_offer_defaults($1,$2,$3,$4,$5::jsonb,$6::jsonb) result'
      : 'select public.set_launch_defaults($1,$2,$3,$4::jsonb,$5::jsonb) result',
    offerId
      ? [team, offerId, version, key, JSON.stringify(values), JSON.stringify(sub)]
      : [team, version, key, JSON.stringify(values), JSON.stringify(sub)]
  );
const read = async (offerId?: string, actor = owner) =>
  (
    await db.asUser<{ result: { config: typeof config; version: string } | null }>(
      actor,
      offerId
        ? 'select public.get_launch_offer_defaults($1,$2) result'
        : 'select public.get_launch_defaults($1) result',
      offerId ? [team, offerId] : [team]
    )
  )[0].result;
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'offer-defaults@example.test' });
  await createUser(db, { id: viewer, email: 'offer-defaults-viewer@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Offer defaults')")
  )[0].id;
  otherTeam = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Other defaults')")
  )[0].id;
  await db.root(
    "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'viewer')",
    [team, viewer]
  );
  const create = async (scope: string, name: string) =>
    (
      await db.asUser<{ result: { id: string } }>(
        owner,
        "select public.create_launch_dictionary($1,'offers',$2,$3) result",
        [scope, name, crypto.randomUUID()]
      )
    )[0].result.id;
  offer = await create(team, 'A');
  otherOffer = await create(team, 'B');
  foreignOffer = await create(otherTeam, 'A');
}, 60000);
afterAll(async () => db?.close());
it('keeps workspace and each offer independent and round-trips manual budgets', async () => {
  expect(await read(offer)).toBeNull();
  await save(null, null);
  await save(offer, null, undefined, { ...config, budgets: [10, 25, 30] });
  expect((await read())?.config).toEqual(config);
  expect((await read(offer))?.config.budgets).toEqual([10, 25, 30]);
  expect(await read(otherOffer)).toBeNull();
});
it('replays the same scope and payload, rejects conflicts and cross-scope key reuse', async () => {
  const initial = (await read(offer))!;
  const key = crypto.randomUUID();
  const first = await save(offer, initial.version, key);
  expect(await save(offer, initial.version, key)).toEqual(first);
  await expect(save(offer, initial.version)).rejects.toThrow('LAUNCH_VERSION_CONFLICT');
  await expect(save(otherOffer, null, key)).rejects.toThrow();
  await expect(
    save(offer, initial.version, key, { ...config, budgets: [10, 20, 30] })
  ).rejects.toThrow();
});
it('enforces permissions, tenant membership, RLS and active-offer scope', async () => {
  expect(await read(offer, viewer)).toBeTruthy();
  await expect(
    save(offer, (await read(offer))!.version, undefined, config, viewer)
  ).rejects.toThrow('PERMISSION_DENIED');
  await expect(read(foreignOffer)).rejects.toThrow('NOT_FOUND');
  await expect(save(foreignOffer, null)).rejects.toThrow('NOT_FOUND');
  await db.root('set role authenticated');
  try {
    await expect(
      db.asUser(viewer, 'select * from public.team_launch_offer_defaults')
    ).rejects.toThrow('permission denied');
  } finally {
    await db.root('reset role');
  }
  await db.asUser(owner, "select public.archive_launch_dictionary($1,'offers',$2,$3)", [
    team,
    otherOffer,
    crypto.randomUUID()
  ]);
  await expect(read(otherOffer)).rejects.toThrow('NOT_FOUND');
  await expect(save(otherOffer, null)).rejects.toThrow('NOT_FOUND');
});
it('validates manual budgets and rejects one-off and nested content at the storage boundary', async () => {
  const version = (await read(offer))!.version;
  for (const value of [
    { ...config, budgets: [10, 20] },
    { ...config, budgets: [10, 10, 30] },
    { ...config, budgets: [10, 20, 29] },
    { ...config, budgetMode: 'auto' },
    { ...config, originalUrl: 'SYNTHETIC_SECRET' },
    { ...config, offerId: offer },
    { ...config, catalog: { ...launchConfig().catalog, secret: 'SYNTHETIC_SECRET' } }
  ])
    await expect(save(offer, version, undefined, value)).rejects.toThrow('INVALID_INPUT');
  await save(offer, version, undefined, { ...config, budgetMode: 'auto', budgets: null });
});
it('invalidates workspace metadata without publishing profile contents', async () => {
  const before = (
    await db.root<{ version: number }>(
      'select version from public.team_launch_workspace_signals where team_id=$1',
      [team]
    )
  )[0].version;
  await save(offer, (await read(offer))!.version);
  const rows = await db.asUser<{ version: number }>(
    viewer,
    'select * from public.team_launch_workspace_signals where team_id=$1',
    [team]
  );
  expect(Number(rows[0].version)).toBeGreaterThan(Number(before));
  expect(JSON.stringify(rows)).not.toContain('budgets');
});

it('refuses a missing offer without modifying the general profile', async () => {
  const before = await read();
  await expect(
    db.asUser(owner, 'select public.set_launch_offer_defaults($1,null,$2,$3,$4::jsonb,$5::jsonb)', [
      team,
      before!.version,
      crypto.randomUUID(),
      JSON.stringify(config),
      JSON.stringify(sub)
    ])
  ).rejects.toThrow('INVALID_INPUT');
  expect(await read()).toEqual(before);
});
