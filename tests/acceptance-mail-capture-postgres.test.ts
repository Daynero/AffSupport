import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { captureVerifiedFixtureNotices } from '../scripts/acceptance/mail-capture.mjs';
import {
  lockTariffClockMutation,
  teardownFixtureTariffClock
} from '../scripts/acceptance/clock-state.mjs';
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const connection = process.env.SOTY_TEST_POSTGRES_URL;
const namespace = 'acceptance-mail-native';
const fixture = {
  actors: Object.fromEntries(['A', 'B', 'C', 'X', 'S'].map(alias => [alias, { id: randomUUID() }])),
  teams: {} as Record<string, string>
};
let db: pg.Client, admin: pg.Client, rootUrl: string;
let sqlFailure = '';
const checkedDb = {
  query: async (sql: string, params?: unknown[]) => {
    try {
      return await db.query(sql, params);
    } catch (error) {
      sqlFailure = `${sql}: ${error instanceof Error ? error.message : 'unknown'}`;
      throw error;
    }
  }
};
async function client() {
  const value = new pg.Client({
    connectionString: rootUrl,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=300'
  });
  await value.connect();
  return value;
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}
describe.skipIf(!container && !connection)(
  '036 mail capture [needs: disposable native PostgreSQL]',
  () => {
    beforeAll(async () => {
      if (!connection) throw Error('DISPOSABLE_CONNECTION_REQUIRED');
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
      // Match retained local beta function ownership; the clone migration runner uses supabase_admin.
      await admin.query(
        `alter role postgres password '${url.password}'; do $$ begin if to_regprocedure('private.tariff_now()') is not null then alter function private.tariff_now() owner to postgres; end if; end $$; alter function private.kyiv_today(timestamptz) owner to postgres;`
      );
      url.username = 'postgres';
      rootUrl = url.toString();
      db = await client();
      for (const [alias, actor] of Object.entries(fixture.actors)) {
        await admin.query(
          "insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,'authenticated','authenticated',$2,now(),'{}',jsonb_build_object('acceptance_namespace',$3::text))",
          [actor.id, `${namespace}-${alias.toLowerCase()}@soty.invalid`, namespace]
        );
        await admin.query(
          "insert into public.profiles(id,display_name,account_status) values($1,'QA','active') on conflict(id) do update set account_status='active'",
          [actor.id]
        );
      }
      await admin.query('insert into public.admin_users(user_id) values($1)', [
        fixture.actors.S.id
      ]);
      for (const [alias, owner] of [
        ['W1', 'A'],
        ['W2', 'X']
      ]) {
        await admin.query("select set_config('request.jwt.claim.sub',$1,false)", [
          fixture.actors.S.id
        ]);
        await admin.query(
          "select public.admin_grant_space_tariff($1,'lead',private.kyiv_today()+30,0)",
          [`${namespace}-${owner.toLowerCase()}@soty.invalid`]
        );
        await admin.query("select set_config('request.jwt.claim.sub',$1,false)", [
          fixture.actors[owner].id
        ]);
        fixture.teams[alias] = (
          await admin.query('select id from public.create_team($1)', [`${namespace} ${alias}`])
        ).rows[0].id;
      }
    }, 30000);
    beforeEach(async () => {
      sqlFailure = '';
      // This entire database is a disposable schema-only clone, never the retained beta.
      await admin.query('delete from public.space_tariff_notices');
      await admin.query(
        "insert into public.space_tariff_notices(tariff_id,kind,period_end) select id,'granted',ends_on from public.space_tariffs where owner_id=any($1::uuid[])",
        [[fixture.actors.A.id, fixture.actors.X.id]]
      );
    });
    afterAll(async () => {
      await db?.end();
      await admin?.end();
    });
    it('uses the tariff overlay for actual scheduled notice selection and rendered year, then restores real time', async () => {
      const year = new Date().getUTCFullYear() + 5;
      const instant = `${year}-01-15T12:00:00.000Z`;
      const end = `${year}-01-17`;
      const owners = [fixture.actors.A.id, fixture.actors.X.id];
      const saved = (
        await admin.query(
          'select id,ends_on::text from public.space_tariffs where owner_id=any($1::uuid[])',
          [owners]
        )
      ).rows;
      const messages: { kind: string; text: string }[] = [];
      try {
        await admin.query('grant usage,create on schema private to postgres');
        await db.query(
          await readFile(
            new URL('../supabase/fixtures/acceptance-clock.sql', import.meta.url),
            'utf8'
          )
        );
        await db.query(
          "insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at) values(true,$1,$2,clock_timestamp()+interval '5 minutes')",
          [namespace, instant]
        );
        await admin.query(
          'update public.space_tariffs set ends_on=$1 where owner_id=any($2::uuid[])',
          [end, owners]
        );
        await admin.query('delete from public.space_tariff_notices');
        expect((await admin.query('select private.queue_tariff_notices() n')).rows[0].n).toBe(2);
        const result = await captureVerifiedFixtureNotices(
          checkedDb,
          namespace,
          fixture,
          async (_id: string, kind: string, message: { text: string }) => {
            messages.push({ kind, text: message.text });
          }
        );
        expect(result, sqlFailure).toMatchObject({
          ok: true,
          state: 'captured',
          delivered: false,
          databaseCommitted: true
        });
        expect(messages).toHaveLength(2);
        for (const message of messages) {
          expect(message.kind).toBe('warn_3d');
          expect(message.text).toMatch(/17 січня|January 17/u);
          expect(message.text).not.toContain(String(year));
        }
        expect((await admin.query('select sent_at from public.space_tariff_notices')).rows).toEqual(
          [{ sent_at: null }, { sent_at: null }]
        );
      } finally {
        await teardownFixtureTariffClock(db, namespace);
        for (const row of saved)
          await admin.query('update public.space_tariffs set ends_on=$1 where id=$2', [
            row.ends_on,
            row.id
          ]);
      }
      expect(
        (
          await db.query(
            "select private.tariff_now()=now() as real,to_regclass('private.acceptance_tariff_clock') is null as cleared"
          )
        ).rows[0]
      ).toEqual({ real: true, cleared: true });
    }, 30000);
    it('prevents duplicate claims and blocks tariff mutation during capture, then releases locks', async () => {
      const entered = barrier(),
        resume = barrier(),
        other = await client();
      const running = captureVerifiedFixtureNotices(checkedDb, namespace, fixture, async () => {
        entered.release();
        await resume.promise;
      });
      try {
        await Promise.race([
          entered.promise,
          running.then(result => {
            throw Error(JSON.stringify({ result, sqlFailure }));
          })
        ]);
        expect(
          (await other.query('select public.service_claim_tariff_notices(10) value')).rows[0].value
        ).toEqual([]);
        await expect(
          other.query('update public.space_tariffs set ends_on=ends_on where owner_id=$1', [
            fixture.actors.A.id
          ])
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        resume.release();
        await other.end();
      }
      expect(await running).toMatchObject({
        ok: true,
        delivered: false,
        summary: { captured: 2, sent: 0, skipped: 2 }
      });
      expect(
        (await admin.query('select public.service_claim_tariff_notices(10) value')).rows[0].value
      ).toEqual([]);
      expect(
        (
          await admin.query(
            "select count(*)::int n from public.space_tariff_notices where state='skipped' and sent_at is null"
          )
        ).rows[0].n
      ).toBe(2);
    });
    it('refuses capture during cleanup and during another namespace clock mutation', async () => {
      const other = await client();
      let writes = 0;
      try {
        await other.query('select pg_advisory_lock(hashtextextended($1,0))', [
          `acceptance-fixtures:${namespace}`
        ]);
        expect(
          await captureVerifiedFixtureNotices(checkedDb, namespace, fixture, async () => {
            writes++;
          })
        ).toMatchObject({ ok: false, reason: 'BUSY', captured: 0 });
        await other.query('select pg_advisory_unlock_all()');
        await other.query('begin');
        await lockTariffClockMutation(other, 'acceptance-mail-other');
        expect(
          await captureVerifiedFixtureNotices(checkedDb, namespace, fixture, async () => {
            writes++;
          })
        ).toMatchObject({ ok: false, reason: 'BUSY', captured: 0 });
        await other.query('rollback');
      } finally {
        await other.end();
      }
      expect(writes).toBe(0);
      expect(
        (
          await admin.query(
            "select count(*)::int n from public.space_tariff_notices where state='pending' and attempts=0"
          )
        ).rows[0].n
      ).toBe(2);
    });
    it('rolls back a failed capture and releases locks for a subsequent real claim', async () => {
      let attempted = 0;
      expect(
        await captureVerifiedFixtureNotices(checkedDb, namespace, fixture, async () => {
          attempted++;
          throw Error('synthetic disk failure');
        })
      ).toMatchObject({ ok: false, databaseCommitted: false, delivered: false });
      expect(attempted, sqlFailure).toBeGreaterThan(0);
      const other = await client();
      try {
        const rows = (await other.query('select public.service_claim_tariff_notices(10) value'))
          .rows[0].value;
        expect(rows).toHaveLength(2);
        expect(
          (await admin.query('select attempts,sent_at from public.space_tariff_notices')).rows
        ).toEqual([
          { attempts: 1, sent_at: null },
          { attempts: 1, sent_at: null }
        ]);
      } finally {
        await other.end();
      }
    });
    it('releases actual database locks after a recording promise stalls', async () => {
      let calls = 0;
      const result = await captureVerifiedFixtureNotices(checkedDb, namespace, fixture, () => {
        calls++;
        return new Promise<void>(() => undefined);
      });
      expect(result, sqlFailure).toMatchObject({
        ok: false,
        reason: 'CAPTURE_TIMEOUT',
        captured: 0,
        captureUnconfirmed: 1,
        databaseCommitted: false,
        delivered: false
      });
      expect(calls).toBe(1);
      const other = await client();
      try {
        await other.query('update public.space_tariffs set ends_on=ends_on where owner_id=$1', [
          fixture.actors.A.id
        ]);
        expect(
          (await other.query('select public.service_claim_tariff_notices(10) value')).rows[0].value
        ).toHaveLength(2);
        expect(
          (await admin.query('select attempts,sent_at from public.space_tariff_notices')).rows
        ).toEqual([
          { attempts: 1, sent_at: null },
          { attempts: 1, sent_at: null }
        ]);
      } finally {
        await other.end();
      }
    }, 15000);
    it('server releases the transaction when the entire capture event loop freezes', async () => {
      const backend = (await db.query('select pg_backend_pid() pid')).rows[0].pid;
      const stopped = db;
      // A termination may reach an idle socket event or the rollback query callback.
      stopped.on('error', () => undefined);
      try {
        const result = await captureVerifiedFixtureNotices(db, namespace, fixture, () => {
          // Deliberately block this test worker: its five-second JS timer cannot run.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 17000);
          return new Promise<void>(() => undefined);
        });
        expect(result).toMatchObject({
          ok: false,
          reason: 'DATABASE_IDLE_TIMEOUT',
          captured: 0,
          captureUnconfirmed: 1,
          databaseCommitted: false,
          delivered: false
        });
        expect(
          (
            await admin.query('select count(*)::int n from pg_stat_activity where pid=$1', [
              backend
            ])
          ).rows[0].n
        ).toBe(0);
        expect(
          (await admin.query('select public.service_claim_tariff_notices(10) value')).rows[0].value
        ).toHaveLength(2);
        expect(
          (await admin.query('select attempts,sent_at from public.space_tariff_notices')).rows
        ).toEqual([
          { attempts: 1, sent_at: null },
          { attempts: 1, sent_at: null }
        ]);
      } finally {
        await stopped.end();
        db = await client();
      }
    }, 30000);
  }
);
