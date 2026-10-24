import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import {
  teardownFixtureTariffClock,
  inspectTariffClockState,
  readClockFixtureSource
} from '../scripts/acceptance/clock-state.mjs';
let h: TeamTestDb;
const namespace = 'acceptance-clock-teardown';
const real =
  "create or replace function private.tariff_now() returns timestamptz language sql stable security definer set search_path='' as $$ select pg_catalog.now() $$; revoke all on function private.tariff_now() from public,anon,authenticated,service_role;";
const db = {
  // PGlite's simple-query API matches pg's unparameterized multi-statement queries.
  query: async (sql: string, params?: unknown[]) =>
    params ? h.db.query(sql, params) : (await h.db.exec(sql)).at(-1)
};
let fixtureSql: string;
beforeAll(async () => {
  h = await createTeamTestDb();
  await createUser(h, {
    id: '36000000-0000-4000-8000-000000000099',
    email: 'clock-sentinel@soty.invalid',
    displayName: 'Sentinel'
  });
  fixtureSql = await readFile(
    new URL('../supabase/fixtures/acceptance-clock.sql', import.meta.url),
    'utf8'
  );
}, 120000);
beforeEach(async () => {
  await h.db.exec(real);
  await h.db.exec('drop table if exists private.acceptance_tariff_clock');
  await h.db.exec(fixtureSql);
  await h.root(
    "insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at) values(true,$1,'2030-01-01',clock_timestamp()+interval '1 hour')",
    [namespace]
  );
});
afterAll(async () => h?.close());
async function observed() {
  return (
    await h.root<{ overlay: boolean; real: boolean; profiles: number }>(
      "select to_regclass('private.acceptance_tariff_clock') is not null as overlay, private.tariff_now()=now() as real, (select count(*)::int from public.profiles) as profiles"
    )
  )[0];
}
it('dry-run validates its owned overlay without altering time or rows', async () => {
  expect(await inspectTariffClockState(db, namespace, (await readClockFixtureSource()).body)).toBe(
    'overlay'
  );
  const before = await observed();
  expect(await teardownFixtureTariffClock(db, namespace, { dryRun: true })).toEqual({
    state: 'overlay',
    willRestore: true,
    dryRun: true
  });
  expect(await observed()).toEqual(before);
});
it('clears its overlay, restores real time, preserves application rows and can be repeated', async () => {
  const before = await observed();
  expect(before.overlay).toBe(true);
  expect(await teardownFixtureTariffClock(db, namespace)).toEqual({
    state: 'real',
    restored: true
  });
  expect(await observed()).toEqual({ overlay: false, real: true, profiles: before.profiles });
  expect(await teardownFixtureTariffClock(db, namespace)).toEqual({
    state: 'real',
    restored: true
  });
});
it('refuses another campaign without dropping its overlay', async () => {
  const before = await observed();
  await expect(teardownFixtureTariffClock(db, 'acceptance-other-campaign')).rejects.toThrow(
    'ACCEPTANCE_CLOCK_REFUSED'
  );
  expect(await observed()).toEqual(before);
});
it('refuses an altered function implementation and leaves it unchanged', async () => {
  await h.root(
    "create or replace function private.tariff_now() returns timestamptz language sql stable security definer set search_path='' as $$ select '2040-01-01'::timestamptz $$"
  );
  await expect(teardownFixtureTariffClock(db, namespace)).rejects.toThrow(
    'ACCEPTANCE_CLOCK_REFUSED'
  );
  expect(
    (
      await h.root<{ instant: boolean }>(
        "select private.tariff_now()='2040-01-01'::timestamptz as instant"
      )
    )[0].instant
  ).toBe(true);
});
it('refuses an exposed overlay instead of treating a foreign shape as its fixture', async () => {
  await h.root('grant select on private.acceptance_tariff_clock to authenticated');
  await expect(teardownFixtureTariffClock(db, namespace)).rejects.toThrow(
    'ACCEPTANCE_CLOCK_REFUSED'
  );
  expect((await observed()).overlay).toBe(true);
});
it('accepts a schema without the seam only when no overlay table remains', async () => {
  await h.db.exec(real);
  await h.root('drop table private.acceptance_tariff_clock');
  await h.root('alter function private.tariff_now() rename to tariff_now_test_retained');
  try {
    expect(await teardownFixtureTariffClock(db, namespace)).toEqual({
      state: 'not_installed',
      restored: false
    });
  } finally {
    await h.root('alter function private.tariff_now_test_retained() rename to tariff_now');
  }
});
