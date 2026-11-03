import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getCatalogGenerationEvidence } from '../scripts/analytics/catalog-generations';
import { resolvePeriod } from '../scripts/analytics/periods';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';
import { setQueryExecutor } from '../scripts/analytics/db';
import { investigatePrivacyFailure, type InvestigateData } from '../scripts/analytics/types';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let db: AnalyticsTestDb;
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`create schema private;
    create role anon;create role authenticated;create role service_role;create role wishly_analytics_ro;
    -- Model Supabase's broad defaults, including service_role writes. The
    -- migration must explicitly reset ACLs on its automatically updatable view.
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role,wishly_analytics_ro;
    create table private.catalog_generation_intents(
      id uuid,team_id uuid,actor_id uuid,operation_id uuid,attempt int,request_key text,state text,
      safe_error_code text,created_at timestamptz,updated_at timestamptz,checkpoint jsonb,video_material_id uuid,
      request_payload jsonb,result jsonb
    );
    insert into analytics_users(id,email_normalized) values('${USER}','fixture@example.test');
    insert into private.catalog_generation_intents values(
      '${ID}','${ID}','${USER}',null,2,'secret-request','interrupted','NEEDS_REAUTH',now(),now(),
      '{"settings":{"title":"private-content"},"sheetRows":[],"providerFileId":"private-provider-id"}',
      '${ID}','{"url":"https://private.invalid"}','{"secret":"Bearer private"}'
    );`);
  await db.exec(
    readFileSync('supabase/migrations/20261207113000_catalog_generation_diagnostics.sql', 'utf8')
  );
}, 30_000);
afterAll(async () => {
  await db.close();
});

it('projects actual SQL checkpoint evidence through investigate without private payload or broad grants', async () => {
  const result = await executeCommand(
    parseArgs(['investigate', 'fixture@example.test', '--period', 'all'])
  );
  const data = result.data as InvestigateData;
  expect(data.catalog_generations).toMatchObject({
    supported: true,
    records: [
      {
        intent_id: ID,
        attempt: 2,
        state: 'interrupted',
        safe_error_code: 'NEEDS_REAUTH',
        origin: 'standalone',
        settings_observed: true,
        source_observed: false,
        rows_planned: true,
        provider_result_observed: true,
        result_registered: false
      }
    ]
  });
  expect(investigatePrivacyFailure(data)).toBeNull();
  expect(JSON.stringify(data)).not.toMatch(
    /private-content|private-provider-id|private\.invalid|Bearer private|secret-request/
  );
  const grants = await db.db.query<{
    anon_read: boolean;
    authenticated_read: boolean;
    analytics_read: boolean;
  }>(
    "select has_table_privilege('anon','public.analytics_catalog_generations','select') anon_read,has_table_privilege('authenticated','public.analytics_catalog_generations','select') authenticated_read,has_table_privilege('wishly_analytics_ro','public.analytics_catalog_generations','select') analytics_read"
  );
  expect(grants.rows[0]).toEqual({
    anon_read: false,
    authenticated_read: false,
    analytics_read: true
  });
  const permissions = await db.db.query<{ role_name: string; privilege: string; allowed: boolean }>(
    `select role_name,privilege,has_table_privilege(role_name,'public.analytics_catalog_generations',privilege) allowed
     from unnest(array['anon','authenticated','service_role','wishly_analytics_ro']) role_name
     cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege`
  );
  for (const permission of permissions.rows) {
    expect(permission.allowed, `${permission.role_name} ${permission.privilege}`).toBe(
      permission.privilege === 'SELECT' &&
        ['service_role', 'wishly_analytics_ro'].includes(permission.role_name)
    );
  }
});

it('reports historical snapshots unknown rather than reconstructing current stages', async () => {
  const evidence = await getCatalogGenerationEvidence(
    USER,
    resolvePeriod('all', undefined, new Date().toISOString())
  );
  expect(evidence).toMatchObject({ supported: true, records: [] });
  expect(evidence.blind_spots.join(' ')).toContain(
    'Historical generation snapshots are unavailable'
  );
});

it('normalizes unknown stored states and codes without exposing them', async () => {
  await db.exec(
    "update private.catalog_generation_intents set state='private provider message',safe_error_code='Bearer private-secret'"
  );
  const evidence = await getCatalogGenerationEvidence(USER, resolvePeriod('all', undefined));
  expect(evidence).toMatchObject({
    unknown_projection: true,
    records: [{ state: 'unknown', safe_error_code: 'UNKNOWN' }]
  });
  expect(JSON.stringify(evidence)).not.toMatch(/private provider message|Bearer private-secret/);
});

it('keeps missing migration or inaccessible view explicit', async () => {
  await db.exec('drop view public.analytics_catalog_generations');
  // A new executor generation mirrors the next CLI process after schema changes.
  setQueryExecutor(
    async (sql, params) =>
      (await db.db.query<Record<string, unknown>>(sql, params as unknown[])).rows
  );
  const evidence = await getCatalogGenerationEvidence(USER, resolvePeriod('all', undefined));
  expect(evidence).toMatchObject({ supported: false, records: [] });
  expect(evidence.blind_spots.join(' ')).toContain('unavailable to this role');
});
