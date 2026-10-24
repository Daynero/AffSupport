import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
let db: TeamTestDb;
const ADMIN = '36000000-0000-4000-8000-000000000001';
const OWNER = '36000000-0000-4000-8000-000000000002';
let team: string;
let offer: string;
async function overlay(instant: string) {
  // Test-harness root only. No production parameter/GUC/HTTP clock override exists.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(instant)) throw Error('TEST_INSTANT_INVALID');
  await db.root(
    `create or replace function private.tariff_now() returns timestamptz language sql stable security definer set search_path='' as $$ select '${instant}'::timestamptz $$`
  );
}
beforeAll(async () => {
  db = await createTeamTestDb();
}, 120000);
afterAll(async () => {
  await db?.close();
});
it('production seam follows transaction time and ignores caller GUCs', async () => {
  const [row] = await db.root<{ same: boolean }>(
    `select set_config('soty.tariff_now','2030-01-01',false), private.tariff_now() = now() as same`
  );
  expect(row.same).toBe(true);
});
it('authenticated actors cannot directly invoke the private seam', async () => {
  await createUser(db, {
    id: ADMIN,
    email: 'clock-admin@soty.invalid',
    displayName: 'Clock admin'
  });
  await createUser(db, {
    id: OWNER,
    email: 'clock-owner@soty.invalid',
    displayName: 'Clock owner'
  });
  await db.root('begin');
  try {
    await db.root('set local role authenticated');
    await expect(db.root('select private.tariff_now()')).rejects.toThrow(/permission denied/);
  } finally {
    await db.root('rollback');
  }
});
it.each([
  ['2026-03-28T21:59:59Z', '2026-03-28'],
  ['2026-03-28T22:00:00Z', '2026-03-29'],
  ['2026-03-29T00:59:59Z', '2026-03-29'],
  ['2026-03-29T01:00:00Z', '2026-03-29'],
  ['2026-10-25T00:59:59Z', '2026-10-25'],
  ['2026-10-25T01:00:00Z', '2026-10-25'],
  ['2026-12-31T22:00:00Z', '2027-01-01']
])('uses Kyiv calendar at %s', async (instant, expected) => {
  await overlay(instant);
  expect((await db.root<{ day: string }>('select private.kyiv_today()::text as day'))[0].day).toBe(
    expected
  );
});
it('creates a synthetic tariff workspace using the domain date', async () => {
  await overlay('2026-03-20T10:00:00Z');
  await db.root('insert into public.admin_users(user_id) values($1)', [ADMIN]);
  await db.asUser(
    ADMIN,
    `select public.admin_grant_space_tariff($1,'lead','2026-03-28'::date,0,null,null,null,false)`,
    ['clock-owner@soty.invalid']
  );
  team = (
    await db.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', [
      'Clock fixture'
    ])
  )[0].id;
  const [row] = await db.root<{ starts: boolean; audit: boolean }>(
    `select starts_at=private.tariff_now() as starts, abs(extract(epoch from created_at-now()))<60 as audit from public.space_tariffs where team_id=$1`,
    [team]
  );
  expect(row).toEqual({ starts: true, audit: true });
  offer = (
    await db.asUser<{ result: { id: string } }>(
      OWNER,
      "select public.create_launch_dictionary($1,'offers','Clock compatibility','clock-offer-create') as result",
      [team]
    )
  )[0].result.id;
  await db.asUser(
    OWNER,
    `select public.set_launch_offer_defaults($1,$2,null,'clock-offer-save',
      '{"campaignCount":3,"minBudget":10,"maxBudget":30,"budgetMode":"manual","budgets":[10,21,30]}'::jsonb,
      '{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}'::jsonb)`,
    [team, offer]
  );
});
it.each([
  ['2026-03-28T21:59:59Z', 'expiring', true],
  ['2026-03-28T22:00:00Z', 'grace', true],
  ['2026-03-31T20:59:59Z', 'grace', true],
  ['2026-03-31T21:00:00Z', 'blocked', false]
])('keeps projection and gate consistent at %s', async (instant, state, allowed) => {
  await overlay(instant);
  const [row] = await db.root<{ state: string; allowed: boolean }>(
    'select st.state, private.team_workspace_allowed($1) as allowed from private.space_tariff_state($1) st',
    [team]
  );
  expect(row).toEqual({ state, allowed });
  const [calendar] = await db.root<{ day: string }>('select private.kyiv_today()::text as day');
  const [access] = await db.asUser<{ value: { tariffToday: string } }>(
    OWNER,
    'select public.get_my_space_access() as value'
  );
  expect(access.value.tariffToday).toBe(calendar.day);
  const [tariff] = await db.root<{ value: { tariffToday: string } }>(
    'select private.team_tariff_json($1,$2) as value',
    [team, OWNER]
  );
  expect(tariff.value.tariffToday).toBe(calendar.day);
  const [settings] = await db.asUser<{ value: { tariffToday: string } }>(
    ADMIN,
    'select public.admin_get_tariff_settings() as value'
  );
  expect(settings.value.tariffToday).toBe(calendar.day);
  const launchDefaults = db.asUser<{ value: { config: { budgets: number[] } } }>(
    OWNER,
    'select public.get_launch_offer_defaults($1,$2) as value',
    [team, offer]
  );
  if (allowed) expect((await launchDefaults)[0].value.config.budgets).toEqual([10, 21, 30]);
  else await expect(launchDefaults).rejects.toThrow('PERMISSION_DENIED');
});
it('restores real time when the test fixture is removed', async () => {
  await db.root(
    `create or replace function private.tariff_now() returns timestamptz language sql stable security definer set search_path='' as $$ select pg_catalog.now() $$`
  );
  expect(
    (await db.root<{ same: boolean }>('select private.tariff_now()=now() as same'))[0].same
  ).toBe(true);
});

it('local fixture expires using real time and remains private to privileged tooling', async () => {
  const fixture = await readFile(
    new URL('../supabase/fixtures/acceptance-clock.sql', import.meta.url),
    'utf8'
  );
  await db.db.exec(fixture);
  await db.root(
    "insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at) values(true,'acceptance-clock-test','2030-01-01T00:00:00Z',clock_timestamp()+interval '1 hour')"
  );
  const [active] = await db.root<{ domain: boolean; wall: boolean }>(
    "select private.tariff_now()='2030-01-01T00:00:00Z'::timestamptz as domain, now()<>private.tariff_now() as wall"
  );
  expect(active).toEqual({ domain: true, wall: true });
  await db.root('begin');
  try {
    await db.root('set local role authenticated');
    await expect(db.root('select tariff_at from private.acceptance_tariff_clock')).rejects.toThrow(
      /permission denied/
    );
  } finally {
    await db.root('rollback');
  }
  await db.root(
    "update private.acceptance_tariff_clock set expires_at=clock_timestamp()-interval '1 second'"
  );
  expect(
    (await db.root<{ real: boolean }>('select private.tariff_now()=now() as real'))[0].real
  ).toBe(true);
  await db.root(
    "create or replace function private.tariff_now() returns timestamptz language sql stable security definer set search_path='' as $$ select pg_catalog.now() $$"
  );
  await db.root('drop table private.acceptance_tariff_clock');
});

it('rolls back the seam without changing synthetic tariff rows', async () => {
  const before = await db.root<{ snapshot: unknown }>(
    'select jsonb_agg(to_jsonb(t) order by t.id) as snapshot from public.space_tariffs t'
  );
  const offerBefore = await db.root<{ snapshot: unknown }>(
    'select to_jsonb(t) as snapshot from public.team_launch_offer_defaults t where team_id=$1 and offer_id=$2',
    [team, offer]
  );
  expect(offerBefore).toHaveLength(1);
  const rollback = await readFile(
    new URL('../supabase/rollback/20261206141000_tariff_time_seam.sql', import.meta.url),
    'utf8'
  );
  await db.db.exec(rollback);
  const after = await db.root<{ snapshot: unknown }>(
    'select jsonb_agg(to_jsonb(t) order by t.id) as snapshot from public.space_tariffs t'
  );
  expect(after).toEqual(before);
  expect(
    await db.root<{ snapshot: unknown }>(
      'select to_jsonb(t) as snapshot from public.team_launch_offer_defaults t where team_id=$1 and offer_id=$2',
      [team, offer]
    )
  ).toEqual(offerBefore);
  expect(
    (
      await db.root<{ absent: boolean }>(
        "select to_regprocedure('private.tariff_now()') is null as absent"
      )
    )[0].absent
  ).toBe(true);
  expect(
    (
      await db.root<{ remaining: number }>(
        "select count(*)::int as remaining from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.prokind='f' and p.prosrc like '%private.tariff_now(%'"
      )
    )[0].remaining
  ).toBe(0);
});
