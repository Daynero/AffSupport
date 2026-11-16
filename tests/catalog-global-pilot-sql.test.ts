import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Owner decision 2026-11-16: the shared white image pool is tested on next in chosen
 * spaces before T0. next shares the production database, so the pilot must leave every
 * other space — and the global policy — exactly as it was (20261216100000).
 */
let db: TeamTestDb, pilot: string, other: string;
const owner = 'c5161000-0000-4000-8000-000000000001';

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'pilot@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  pilot = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Pilot')"))[0]!
    .id;
  other = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Other')"))[0]!
    .id;
}, 180_000);
afterAll(async () => {
  await db?.close();
});

const mode = async (team: string) =>
  (
    await db.root<{ mode: string }>('select public.service_catalog_image_mode_v2($1) mode', [team])
  )[0]!.mode;
const readiness = async (team: string) =>
  (
    await db.root<{ r: { reason: string; usable: boolean; state: string; policyEpoch: number } }>(
      'select public.service_catalog_global_readiness($1,$2) r',
      [owner, team]
    )
  )[0]!.r;

it('keeps every space on its own images until it joins the pilot', async () => {
  expect(await mode(pilot)).toBe('legacy');
  expect((await readiness(pilot)).reason).toBe('GLOBAL_IMAGE_POLICY_CONFLICT');
});

it('makes the pool active for a pilot space only, without activating the policy', async () => {
  await db.root('insert into private.catalog_global_pilot_teams(team_id) values($1)', [pilot]);
  expect(await mode(pilot)).toBe('global');
  expect(await mode(other)).toBe('legacy');
  // A pilot space is past the policy gate; it waits for verified serving, not for T0.
  // The pilot works in the epoch T0 will open (epoch + 1); clients refuse a usable pool
  // with epoch 0, which is what the pilot answered on next before 20261217100000.
  expect(await readiness(pilot)).toMatchObject({
    state: 'active',
    reason: 'GLOBAL_IMAGE_READINESS_UNKNOWN',
    policyEpoch: 1
  });
  expect(await readiness(other)).toMatchObject({
    state: 'prepared',
    reason: 'GLOBAL_IMAGE_POLICY_CONFLICT',
    policyEpoch: 0
  });
  const policy = (
    await db.root<{ state: string; activated: boolean; epoch: string }>(
      'select state, activated_at is not null activated, epoch::text from private.catalog_global_policy where singleton'
    )
  )[0]!;
  expect(policy).toEqual({ state: 'prepared', activated: false, epoch: '0' });
});

it('lets the platform admin manage the pilot from the admin page, and nobody else', async () => {
  const stranger = 'c5161000-0000-4000-8000-000000000002';
  await createUser(db, { id: stranger, email: 'stranger@example.invalid' });
  await expect(
    db.asUser(stranger, "select public.admin_catalog_global_pool('overview')")
  ).rejects.toThrow(/PERMISSION_DENIED/);
  const added = (
    await db.asUser<{ v: { pilot: Array<{ teamId: string }> } }>(
      owner,
      "select public.admin_catalog_global_pool('pilot_add', jsonb_build_object('teamId', $1::text)) v",
      [other]
    )
  )[0]!.v.pilot.map(team => team.teamId);
  expect(added.sort()).toEqual([pilot, other].sort());
  expect(await mode(other)).toBe('global');
  await db.asUser(
    owner,
    "select public.admin_catalog_global_pool('pilot_remove', jsonb_build_object('teamId', $1::text))",
    [other]
  );
  expect(await mode(other)).toBe('legacy');
});

it('shows the pool and its serving configuration to the admin', async () => {
  const overview = (
    await db.asUser<{ v: { policy: { state: string }; images: { total: number } } }>(
      owner,
      "select public.admin_catalog_global_pool('overview') v"
    )
  )[0]!.v;
  expect(overview.policy.state).toBe('prepared');
  expect(overview.images.total).toBe(0);
  const configured = (
    await db.asUser<{ v: { policy: { environment: string; mediaOrigin: string } } }>(
      owner,
      `select public.admin_catalog_global_pool('configure', '{"environment":"beta","mediaOrigin":"https://media.example.invalid","routingRevision":"r1","acceptedKeyVersions":[1]}') v`
    )
  )[0]!.v.policy;
  expect(configured).toMatchObject({
    environment: 'beta',
    mediaOrigin: 'https://media.example.invalid'
  });
  const images = (
    await db.asUser<{ v: { images: unknown[]; total: number } }>(
      owner,
      "select public.admin_catalog_global_pool('images', '{\"limit\":10}') v"
    )
  )[0]!.v;
  expect(images).toEqual({ images: [], total: 0 });
});
