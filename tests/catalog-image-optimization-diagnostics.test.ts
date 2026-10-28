import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { getCatalogImageDiagnosis } from '../scripts/analytics/catalog-images';

let db: TeamTestDb;
let owner: string;
let team: string;
let secondTeam: string;
let entry: string;
beforeAll(async () => {
  db = await createTeamTestDb({
    throughMigration: '20261206159000_catalog_image_storage_quota.sql'
  });
  owner = randomUUID();
  await createUser(db, { id: owner, email: 'normalizer-synthetic@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (
    await db.asUser<{ id: string }>(
      owner,
      "select id from public.create_team('Normalizer fixture')"
    )
  )[0]!.id;
  secondTeam = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Second fixture')")
  )[0]!.id;
  const job = randomUUID();
  entry = randomUUID();
  await db.root(
    'insert into private.catalog_image_config(team_id,import_enabled) values($1,true),($2,true)',
    [team, secondTeam]
  );
  await db.root(
    "insert into public.team_catalog_image_imports(id,team_id,actor_id,actor_scope,source_kind,state) values($1,$2,$3,$3,'local','running')",
    [job, team, owner]
  );
  await db.root(
    'insert into private.catalog_image_import_entries(id,job_id,team_id,client_file_key,display_name,declared_size,declared_mime,classification,state,fence,lease_owner,lease_until) values($1,$2,$3,\'one\',\'PRIVATE_SOURCE_NAME.png\',1000,\'image/png\',\'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}\',\'validating\',1,\'normalizer-fixture\',clock_timestamp()+interval \'5 minutes\')',
    [entry, job, team]
  );
  // The actual phase RPC and immutable projection are exercised; no stage reply is mocked.
  await db.root(
    "select public.service_catalog_image_optimization_v2($1,'normalizer-fixture',1,'started')",
    [entry]
  );
  await db.root(
    "select public.service_catalog_image_optimization_v2($1,'normalizer-fixture',1,'completed')",
    [entry]
  );
  await db.root(
    "select public.service_catalog_image_reserve_v2($1,'normalizer-fixture',1,$2::jsonb)",
    [
      entry,
      JSON.stringify({
        size: 500,
        sha256: '1'.repeat(64),
        sourceSize: 1000,
        sourceSha256: '2'.repeat(64),
        optimizationVersion: 'lossless-v1',
        mime: 'image/png',
        width: 512,
        height: 512
      })
    ]
  );
}, 60_000);
afterEach(() => setQueryExecutor(null));
afterAll(async () => {
  await db?.close();
});
// Parameterized queries cannot combine SET with SELECT in PostgreSQL prepared statements.
function readOnly() {
  setQueryExecutor(async (sql, parameters) => {
    assertReadOnlySql(sql);
    await db.root('set role wishly_analytics_ro');
    try {
      return await db.root<Record<string, unknown>>(sql, parameters);
    } finally {
      await db.root('reset role');
    }
  });
}
describe('normalization and owner-budget producer to read-only diagnosis', () => {
  it('explains actual optimization and current quota without hashes, filenames or double-counting an owner', async () => {
    readOnly();
    const now = new Date(Date.now() + 1000).toISOString();
    const value = await getCatalogImageDiagnosis(team, {
      token: 'all',
      label: 'all',
      start: null,
      end: now
    });
    expect(value.evidence.map(e => e.stage)).toEqual(
      expect.arrayContaining(['optimizing', 'optimized'])
    );
    expect(value.storage_budget).toMatchObject({
      status: 'current_observation',
      accounts: 1,
      used_bytes: 500,
      limit_bytes: 100_000_000,
      reserved_bytes: 500
    });
    expect(
      (
        await db.root(
          'select limit_bytes,limit_images from public.analytics_catalog_image_storage where team_id=$1',
          [team]
        )
      )[0]
    ).toEqual({ limit_bytes: 100000000, limit_images: 500 });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('PRIVATE_SOURCE_NAME');
    expect(serialized).not.toContain('sha256');
    const projected = await db.root<{
      source_bytes: number;
      canonical_bytes: number;
      optimization_version: string;
    }>(
      'select source_bytes,canonical_bytes,optimization_version from public.analytics_catalog_image_optimization where entry_id=$1',
      [entry]
    );
    expect(projected[0]).toMatchObject({
      source_bytes: 1000,
      canonical_bytes: 500,
      optimization_version: 'lossless-v1'
    });
  });
  it('keeps historical budget unknown and reports a real empty second workspace account aggregate', async () => {
    readOnly();
    const now = new Date(Date.now() + 1000).toISOString();
    const old = await getCatalogImageDiagnosis(team, {
      token: 'all',
      label: 'all',
      start: null,
      end: now,
      as_of: now
    });
    expect(old.storage_budget).toMatchObject({ status: 'historical_unknown', used_bytes: null });
    const second = await getCatalogImageDiagnosis(secondTeam, {
      token: 'all',
      label: 'all',
      start: null,
      end: now
    });
    expect(second.storage_budget).toMatchObject({
      status: 'current_observation',
      accounts: 1,
      used_bytes: 500
    });
  });
  it('rejects stale phase receipts and exposes no diagnostic privileges to product clients', async () => {
    await expect(
      db.root("select public.service_catalog_image_optimization_v2($1,'stale',1,'completed')", [
        entry
      ])
    ).rejects.toThrow('LEASE_MISMATCH');
    const privilege = await db.root<{ readable: boolean; executable: boolean }>(
      "select has_table_privilege('authenticated','public.analytics_catalog_image_storage','SELECT') readable,has_function_privilege('authenticated','public.service_catalog_image_optimization_v2(uuid,text,bigint,text)','EXECUTE') executable"
    );
    expect(privilege[0]).toEqual({ readable: false, executable: false });
  });
});
