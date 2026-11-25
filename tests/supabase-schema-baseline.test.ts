import { expect, it } from 'vitest';
import {
  publicDefaultPrivileges,
  resetApplicationSchemas,
  withoutUnknownColumnOptions
} from '../scripts/lib/supabase-schema-baseline.mjs';
import { PGlite } from '@electric-sql/pglite';
it('retains effective source default privileges after a real schema reset', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      'create role service_role;create schema private;create schema cron;create table cron.job(id int);insert into cron.job values(1);'
    );
    const defaults =
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;';
    await db.exec(defaults);
    await db.exec(resetApplicationSchemas(defaults));
    await db.exec('create table public.baseline_probe(id int);');
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select has_table_privilege('service_role','public.baseline_probe','INSERT,UPDATE,DELETE') allowed"
        )
      ).rows[0]!.allowed
    ).toBe(true);
    expect((await db.query<{ n: number }>('select count(*)::int n from cron.job')).rows[0]!.n).toBe(
      0
    );
  } finally {
    await db.close();
  }
});
it('preserves only schema-scoped public default ACL definitions', () => {
  const grant =
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;';
  const revoke =
    'ALTER DEFAULT PRIVILEGES FOR ROLE "custom_owner" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM PUBLIC;';
  expect(
    publicDefaultPrivileges(
      [
        grant,
        revoke,
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT ALL ON TABLES TO service_role;',
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON TABLES TO service_role;',
        "CREATE ROLE synthetic PASSWORD 'not-a-real-secret';",
        '-- ' + grant
      ].join('\r\n')
    )
  ).toBe(grant + '\n' + revoke);
});
it('does not copy rows or additional statements', () => {
  expect(() =>
    publicDefaultPrivileges(
      'INSERT INTO public.synthetic VALUES (1);\nALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role; DROP SCHEMA auth CASCADE;'
    )
  ).toThrow('PUBLIC_DEFAULT_PRIVILEGES_UNSUPPORTED');
});
it('drops only column options PostgreSQL does not know, leaving every other line', async () => {
  const stamped = 'ALTER TABLE ONLY private.probe ALTER COLUMN id SET (pg_attver=3647784064);';
  const mixed =
    'ALTER TABLE ONLY "private"."probe" ALTER COLUMN "note" SET (n_distinct=-1, pg_attver=3647784064);';
  const known = 'ALTER TABLE ONLY private.probe ALTER COLUMN note SET (n_distinct_inherited=5);';
  const create = 'CREATE SCHEMA private;\r\nCREATE TABLE private.probe (id int, note text);';
  const { dump, dropped } = withoutUnknownColumnOptions(
    [create, stamped, mixed, known, '-- ' + stamped, ''].join('\r\n')
  );
  expect(dump).toBe(
    [
      create,
      'ALTER TABLE ONLY "private"."probe" ALTER COLUMN "note" SET (n_distinct=-1);',
      known,
      '-- ' + stamped,
      ''
    ].join('\r\n')
  );
  expect([...dropped]).toEqual([['pg_attver', 2]]);
  const db = new PGlite();
  try {
    await db.exec(create);
    // The raw stamp is what failed the runner: the server itself refuses it.
    await expect(db.exec(stamped)).rejects.toThrow('unrecognized parameter "pg_attver"');
    await db.exec(dump.replace(create, ''));
  } finally {
    await db.close();
  }
});
it('leaves an unparseable column option statement for the server to judge', () => {
  const quoted = "ALTER TABLE ONLY private.probe ALTER COLUMN id SET (pg_attver='a, b');";
  expect(withoutUnknownColumnOptions(quoted)).toEqual({ dump: quoted, dropped: new Map() });
});
