import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyMigrationsAfter, createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * Backend audit 2026-11-20: the five migrations 20261220100000…140000 set a five-second lock
 * timeout on a database that is written many times a second, so a file can fail on a busy
 * moment and be applied again. Each must then leave exactly what it left the first time —
 * including the one that rewrites a function by text replacement.
 */
const LAST_BEFORE = '20261218210000_creative_ranks_cleanup_fence.sql';
/** The audit's own range; later features (062 onwards) are not replayed here. */
const FIRST_AFTER = '20261221000000';
let db: TeamTestDb;

beforeAll(async () => {
  db = await createTeamTestDb();
}, 120_000);
afterAll(async () => {
  await db?.close();
});

const snapshot = async () => ({
  functions: await db.root(
    `select p.oid::regprocedure::text as name, md5(pg_get_functiondef(p.oid)) as body, coalesce(p.proacl::text, '') as acl
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind = 'f' order by 1`
  ),
  indexes: await db.root(
    `select schemaname || '.' || indexname as name, indexdef from pg_indexes
     where schemaname in ('public', 'private') order by 1`
  ),
  columns: await db.root(
    `select table_schema || '.' || table_name || '.' || column_name as name, data_type
     from information_schema.columns where table_schema in ('public', 'private') order by 1`
  ),
  triggers: await db.root(
    `select c.relnamespace::regnamespace::text || '.' || c.relname || ':' || t.tgname as name
     from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal order by 1`
  ),
  grants: await db.root(
    `select table_schema || '.' || table_name || ':' || grantee || ':' || privilege_type as name
     from information_schema.role_table_grants where table_schema in ('public', 'private') order by 1`
  )
});

it('leaves the same database when the audit migrations are applied a second time', async () => {
  const first = await snapshot();
  const applied = await applyMigrationsAfter(db, LAST_BEFORE, FIRST_AFTER);
  expect(applied.map(item => item.file.slice(0, 14))).toEqual(
    expect.arrayContaining([
      '20261220100000',
      '20261220110000',
      '20261220120000',
      '20261220130000',
      '20261220140000'
    ])
  );
  expect(await snapshot()).toEqual(first);
  expect(await db.root('select private.task_cleanup_coverage_verified() ok')).toEqual([
    { ok: true }
  ]);
}, 120_000);

it('patched the recovery core exactly once', async () => {
  const [{ body }] = await db.root<{ body: string }>(
    `select pg_get_functiondef('private.service_team_recovery_core(text,bytea,jsonb)'::regprocedure) body`
  );
  const count = (needle: string) => body.split(needle).length - 1;
  expect(count('team_recovery_empty_claim')).toBe(1);
  expect(count(`'{"job":null,"operationCredential":null}'::jsonb`)).toBe(3);
  expect(count('vault.create_secret(')).toBe(2);
});
