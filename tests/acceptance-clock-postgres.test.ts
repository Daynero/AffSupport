import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import {
  lockTariffClockMutation,
  teardownFixtureTariffClock
} from '../scripts/acceptance/clock-state.mjs';
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const connection = process.env.SOTY_TEST_POSTGRES_URL;
const namespace = 'acceptance-clock-native';
let db: pg.Client, admin: pg.Client, rootUrl: string, fixture: string;
const real =
  "create or replace function private.tariff_now() returns timestamptz language sql stable security definer set search_path='' as $$ select pg_catalog.now() $$; revoke all on function private.tariff_now() from public,anon,authenticated,service_role;";
async function client() {
  const value = new pg.Client({
    connectionString: rootUrl,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000'
  });
  await value.connect();
  return value;
}
async function observed() {
  return (
    await db.query(
      "select private.tariff_now()=now() as real,to_regclass('private.acceptance_tariff_clock') is not null as overlay"
    )
  ).rows[0];
}
describe.skipIf(!container || !connection)(
  '036 clock lifecycle [needs: disposable native PostgreSQL]',
  () => {
    beforeAll(async () => {
      assertDisposablePostgresContainer(container);
      const address = execFileSync('docker', ['port', container!, '5432/tcp'], {
        encoding: 'utf8'
      }).trim();
      const url = new URL(connection!);
      if (
        url.protocol !== 'postgresql:' ||
        url.username !== 'supabase_admin' ||
        !/^[a-f0-9]{48}$/u.test(url.password) ||
        url.hostname !== '127.0.0.1' ||
        address !== `127.0.0.1:${url.port}` ||
        url.pathname !== '/postgres' ||
        url.search ||
        url.hash
      )
        throw Error('DISPOSABLE_REQUIRED');
      admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
      await admin.connect();
      // The isolated migration runner uses supabase_admin; the guarded acceptance
      // entry uses the local postgres role. Model that ownership only in this clone.
      await admin.query(
        `alter role postgres password '${url.password}'; grant usage,create on schema private to postgres; alter function private.tariff_now() owner to postgres;`
      );
      url.username = 'postgres';
      rootUrl = url.toString();
      db = await client();
      fixture = await readFile(
        new URL('../supabase/fixtures/acceptance-clock.sql', import.meta.url),
        'utf8'
      );
    }, 30000);
    beforeEach(async () => {
      await db.query(real);
      await db.query('drop table if exists private.acceptance_tariff_clock');
      await db.query(fixture);
      await db.query(
        "insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at) values(true,$1,'2030-01-01',clock_timestamp()+interval '1 hour')",
        [namespace]
      );
    });
    afterAll(async () => {
      await db?.end();
      await admin?.end();
    });
    it('dry-run, expired TTL, owned clear and repeated clear use real PostgreSQL', async () => {
      expect(await teardownFixtureTariffClock(db, namespace, { dryRun: true })).toMatchObject({
        state: 'overlay',
        willRestore: true
      });
      expect(await observed()).toEqual({ real: false, overlay: true });
      await db.query(
        "update private.acceptance_tariff_clock set expires_at=clock_timestamp()-interval '1 second'"
      );
      expect(await observed()).toEqual({ real: true, overlay: true });
      expect(await teardownFixtureTariffClock(db, namespace)).toEqual({
        state: 'real',
        restored: true
      });
      expect(await observed()).toEqual({ real: true, overlay: false });
      expect(await teardownFixtureTariffClock(db, namespace)).toEqual({
        state: 'real',
        restored: true
      });
    });
    it('a fixture cleanup session lock refuses a concurrent clock setter', async () => {
      const cleaner = await client(),
        setter = await client();
      try {
        await cleaner.query('select pg_advisory_lock(hashtextextended($1,0))', [
          `acceptance-fixtures:${namespace}`
        ]);
        await setter.query('begin');
        await expect(lockTariffClockMutation(setter, namespace)).rejects.toThrow('BUSY');
        await setter.query('rollback');
        expect(await observed()).toEqual({ real: false, overlay: true });
      } finally {
        await setter.end();
        await cleaner.end();
      }
      expect(await teardownFixtureTariffClock(db, namespace)).toMatchObject({ state: 'real' });
    });
    it.each([namespace, 'acceptance-clock-other'])(
      'an active setter serializes cleanup across %s',
      async owner => {
        const setter = await client();
        try {
          await setter.query('begin');
          await lockTariffClockMutation(setter, owner);
          await expect(teardownFixtureTariffClock(db, namespace)).rejects.toThrow(
            'ACCEPTANCE_CLOCK_REFUSED'
          );
          expect(await observed()).toEqual({ real: false, overlay: true });
          await setter.query('commit');
        } finally {
          await setter.end();
        }
        expect(await teardownFixtureTariffClock(db, namespace)).toMatchObject({ state: 'real' });
      }
    );
    it('foreign namespace is refused after lock acquisition with no mutation', async () => {
      await expect(teardownFixtureTariffClock(db, 'acceptance-clock-other')).rejects.toThrow(
        'ACCEPTANCE_CLOCK_REFUSED'
      );
      expect(await observed()).toEqual({ real: false, overlay: true });
    });
    it('a lost commit reply is unconfirmed and retry observes the committed real clock', async () => {
      const lost = {
        query: async (sql: string, values?: unknown[]) => {
          const result = await db.query(sql, values);
          if (sql === 'commit') throw Error('synthetic lost reply after actual commit');
          return result;
        }
      };
      await expect(teardownFixtureTariffClock(lost, namespace)).rejects.toThrow(
        'ACCEPTANCE_CLOCK_UNCONFIRMED'
      );
      expect(await observed()).toEqual({ real: true, overlay: false });
      expect(await teardownFixtureTariffClock(db, namespace)).toMatchObject({ state: 'real' });
    });
    it('executes the actual rollback and forward files without changing a synthetic tariff', async () => {
      await teardownFixtureTariffClock(db, namespace);
      const id = randomUUID(),
        email = `${id}@clock-native.invalid`;
      await admin.query(
        "insert into auth.users(id,aud,role,email,email_confirmed_at,last_sign_in_at,raw_app_meta_data,raw_user_meta_data) values($1,'authenticated','authenticated',$2,now(),now(),'{}','{}')",
        [id, email]
      );
      await admin.query(
        "insert into public.profiles(id,display_name,account_status) values($1,'Clock rollback sentinel','active') on conflict(id) do update set account_status='active'",
        [id]
      );
      await admin.query('insert into public.admin_users(user_id) values($1)', [id]);
      await admin.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
      let launchTeam: string;
      try {
        await admin.query(
          "select public.admin_grant_space_tariff($1,'lead',private.kyiv_today()+30,0,null,null,null,false)",
          [email]
        );
        launchTeam = (
          await admin.query("select id from public.create_team('Clock rollback compatibility')")
        ).rows[0].id;
        const offer = (
          await admin.query(
            "select public.create_launch_dictionary($1,'offers','Clock native offer',$2) as result",
            [launchTeam, randomUUID()]
          )
        ).rows[0].result.id;
        await admin.query(
          `select public.set_launch_offer_defaults($1,$2,null,$3,
            '{"campaignCount":3,"minBudget":10,"maxBudget":30,"budgetMode":"manual","budgets":[10,21,30]}'::jsonb,
            '{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}'::jsonb)`,
          [launchTeam, offer, randomUUID()]
        );
      } finally {
        await admin.query("select set_config('request.jwt.claim.sub','',false)");
      }
      const before = (
        await admin.query(
          'select md5(to_jsonb(t)::text) as digest from public.space_tariffs t where owner_id=$1',
          [id]
        )
      ).rows;
      expect(before).toHaveLength(1);
      const launchState = async () => ({
        rows: (
          await admin.query(
            'select md5(to_jsonb(t)::text) as digest from public.team_launch_offer_defaults t where team_id=$1 order by offer_id',
            [launchTeam]
          )
        ).rows,
        functions: (
          await admin.query(
            `select p.oid::regprocedure::text as signature, md5(pg_get_functiondef(p.oid)) as digest
             from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where (n.nspname='public' and p.proname in ('get_launch_offer_defaults','set_launch_offer_defaults'))
                or (n.nspname='private' and p.proname='save_launch_defaults') order by signature`
          )
        ).rows
      });
      const launchBefore = await launchState();
      expect(launchBefore.rows).toHaveLength(1);
      expect(launchBefore.functions).toHaveLength(3);
      const rollback = await readFile(
        new URL('../supabase/rollback/20261206141000_tariff_time_seam.sql', import.meta.url),
        'utf8'
      );
      const forward = await readFile(
        new URL('../supabase/migrations/20261206141000_tariff_time_seam.sql', import.meta.url),
        'utf8'
      );
      await admin.query(rollback);
      expect(await launchState()).toEqual(launchBefore);
      expect(
        (await admin.query("select to_regprocedure('private.tariff_now()') is null as absent"))
          .rows[0].absent
      ).toBe(true);
      expect(
        (
          await admin.query(
            'select md5(to_jsonb(t)::text) as digest from public.space_tariffs t where owner_id=$1',
            [id]
          )
        ).rows
      ).toEqual(before);
      await admin.query(forward);
      expect(await launchState()).toEqual(launchBefore);
      await admin.query('alter function private.tariff_now() owner to postgres');
      expect(
        (
          await admin.query(
            'select md5(to_jsonb(t)::text) as digest from public.space_tariffs t where owner_id=$1',
            [id]
          )
        ).rows
      ).toEqual(before);
      expect(await observed()).toEqual({ real: true, overlay: false });
    });
  }
);
