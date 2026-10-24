import { expect, it } from 'vitest';
import {
  publicDefaultPrivileges,
  resetApplicationSchemas
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
