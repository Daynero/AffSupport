import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let db: PGlite;

// Database startup and fixture installation are infrastructure preparation,
// separate from the bounded cleanup operations asserted below.
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
      create schema private; create schema cron;
      create role anon; create role authenticated; create role service_role;
      create role history_migrator;
      create table public.team_catalog_events(id bigint primary key, occurred_at timestamptz);
      create table public.team_audit_events(id bigint primary key);
      create table cron.job_run_details(runid bigint primary key, end_time timestamptz, status text);
      insert into public.team_audit_events values (1);
      insert into public.team_catalog_events
        select i, now() - interval '8 days' from generate_series(1, 51) i;
      insert into public.team_catalog_events values (100, now() - interval '6 days');
      insert into cron.job_run_details
        select i, now() - interval '8 days', case when i % 2 = 0 then 'failed' else 'succeeded' end
        from generate_series(1, 501) i;
      insert into cron.job_run_details values
        (1000, now() - interval '6 days', 'failed'),
        (1001, null, 'running'), (1002, now() - interval '8 days', 'running');
      -- Hosted Supabase grants maintenance access without ownership of cron's
      -- managed table. Installation and the definer must work under that role.
      grant usage, create on schema public, private to history_migrator;
      grant usage on schema cron to history_migrator;
      grant select, delete on cron.job_run_details to history_migrator;
      alter table public.team_catalog_events owner to history_migrator;
      set role history_migrator;
    `);
  await db.exec(
    await readFile('supabase/migrations/20261202110000_operational_history_retention.sql', 'utf8')
  );
  await db.exec('reset role');
});
afterAll(async () => {
  await db?.close();
});

it('keeps seven days, active runs and audit records; clamps both cleanup batches', async () => {
  const clean = async (name: string) =>
    (await db.query<{ removed: number }>(`select private.${name}(10000) as removed`)).rows[0]
      ?.removed;
  expect(await clean('cleanup_team_catalog_events')).toBe(50);
  expect(await clean('cleanup_team_catalog_events')).toBe(1);
  expect(await clean('cleanup_team_catalog_events')).toBe(0);
  expect(await clean('cleanup_cron_history')).toBe(500);
  expect(await clean('cleanup_cron_history')).toBe(1);
  expect(await clean('cleanup_cron_history')).toBe(0);
  expect((await db.query('select id from public.team_catalog_events')).rows).toEqual([{ id: 100 }]);
  expect((await db.query('select runid from cron.job_run_details order by runid')).rows).toEqual([
    { runid: 1000 },
    { runid: 1001 },
    { runid: 1002 }
  ]);
  expect((await db.query('select id from public.team_audit_events')).rows).toHaveLength(1);
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "select has_function_privilege('service_role', 'private.cleanup_cron_history(integer)', 'EXECUTE') as allowed"
      )
    ).rows[0]?.allowed
  ).toBe(false);
});
