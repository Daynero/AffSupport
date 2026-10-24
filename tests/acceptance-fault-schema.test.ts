import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { ensureFaultSchema } from '../scripts/acceptance/fault-schema.mjs';
let db: PGlite;
const client = {
  query: async (sql: string, params?: unknown[]) => {
    if (params) return db.query(sql, params);
    return (await db.exec(sql)).at(-1) ?? { rows: [] };
  }
};
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    'create schema private; create role anon; create role authenticated; create role service_role;'
  );
}, 30000);
beforeEach(async () => {
  await db.exec('rollback; drop table if exists private.acceptance_scoped_faults cascade;');
});
afterAll(async () => {
  await db?.close();
});

it('installs and revalidates the exact private fixture without leaving its temporary comparison table', async () => {
  await db.exec('begin');
  expect(await ensureFaultSchema(client, { create: true })).toBe('installed');
  expect(await ensureFaultSchema(client)).toBe('verified');
  await db.exec('commit');
  expect(
    (
      await db.query(
        "select to_regclass('pg_temp.acceptance_scoped_faults_expected') is null absent"
      )
    ).rows[0]
  ).toEqual({ absent: true });
});

it('does not install a fixture for a read-only absent-state query', async () => {
  await db.exec('begin');
  expect(await ensureFaultSchema(client)).toBe('absent');
  await db.exec('commit');
  expect(
    (await db.query("select to_regclass('private.acceptance_scoped_faults') is null absent"))
      .rows[0]
  ).toEqual({ absent: true });
});

it('refuses foreign columns without repairing or deleting the existing relation', async () => {
  await db.exec('begin');
  await ensureFaultSchema(client, { create: true });
  await db.exec('commit');
  await db.exec('alter table private.acceptance_scoped_faults add column foreign_value text');
  await db.exec('begin');
  await expect(ensureFaultSchema(client)).rejects.toThrow('ACCEPTANCE_FAULT_FOREIGN_SCHEMA');
  await db.exec('rollback');
  expect(
    (
      await db.query(
        "select count(*)::int n from information_schema.columns where table_schema='private' and table_name='acceptance_scoped_faults' and column_name='foreign_value'"
      )
    ).rows[0]
  ).toEqual({ n: 1 });
});

it('refuses widened grants and leaves the evidence intact', async () => {
  await db.exec('begin');
  await ensureFaultSchema(client, { create: true });
  await db.exec('commit');
  await db.exec('grant select on private.acceptance_scoped_faults to authenticated');
  await db.exec('begin');
  await expect(ensureFaultSchema(client)).rejects.toThrow('ACCEPTANCE_FAULT_FOREIGN_SCHEMA');
  await db.exec('rollback');
  expect(
    (
      await db.query(
        "select has_table_privilege('authenticated','private.acceptance_scoped_faults','select') granted"
      )
    ).rows[0]
  ).toEqual({ granted: true });
});

it('does not expose the registry to ordinary actors or service-role', async () => {
  await db.exec('begin');
  await ensureFaultSchema(client, { create: true });
  await db.exec('commit');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    expect(
      (
        await db.query(
          "select has_table_privilege($1,'private.acceptance_scoped_faults','select') granted",
          [role]
        )
      ).rows[0]
    ).toEqual({ granted: false });
  }
  await db.exec('begin; set local role authenticated');
  await expect(ensureFaultSchema(client, { create: true })).rejects.toThrow(
    'ACCEPTANCE_FAULT_IDENTITY_INVALID'
  );
  await db.exec('rollback');
});

it('requires a concrete bounded delay for delayed-delivery rows at the database boundary', async () => {
  await db.exec('begin');
  await ensureFaultSchema(client, { create: true });
  await db.exec('commit');
  await expect(
    db.query(`insert into private.acceptance_scoped_faults
    (namespace,fault_id,kind,actor_id,team_id,operation_id,flow_id,ttl_ms,delay_ms,state,created_at_ms,expires_at_ms,changed_at_ms)
    values('acceptance-fault-sql','71000000-0000-4000-8000-000000000001','delayed_delivery',
      '71000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000003',
      '71000000-0000-4000-8000-000000000004','71000000-0000-4000-8000-000000000005',
      5000,null,'armed',10000,15000,10000)`)
  ).rejects.toMatchObject({ code: '23514' });
});

it('also refuses column-level service-role grants without silently revoking them', async () => {
  await db.exec('begin');
  await ensureFaultSchema(client, { create: true });
  await db.exec('commit');
  await db.exec('grant select(fault_id) on private.acceptance_scoped_faults to service_role');
  await db.exec('begin');
  await expect(ensureFaultSchema(client)).rejects.toThrow('ACCEPTANCE_FAULT_FOREIGN_SCHEMA');
  await db.exec('rollback');
  expect(
    (
      await db.query(
        "select has_column_privilege('service_role','private.acceptance_scoped_faults','fault_id','select') granted"
      )
    ).rows[0]
  ).toEqual({ granted: true });
});

it('rejects a null operation binding for every fault except initial acceptance loss in SQL too', async () => {
  await db.exec('begin');
  await ensureFaultSchema(client, { create: true });
  await db.exec('commit');
  await expect(
    db.query(`insert into private.acceptance_scoped_faults
  (namespace,fault_id,kind,actor_id,team_id,operation_id,flow_id,ttl_ms,state,created_at_ms,expires_at_ms,changed_at_ms)
  values('acceptance-fault-sql','71000000-0000-4000-8000-000000000001','lost_status_response',
  '71000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000003',null,
  '71000000-0000-4000-8000-000000000005',5000,'armed',10000,15000,10000)`)
  ).rejects.toMatchObject({ code: '23514' });
});
