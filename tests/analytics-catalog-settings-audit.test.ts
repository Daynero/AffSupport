import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getAudit } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';

let db: AnalyticsTestDb;
const period = resolvePeriod('7d', undefined, '2026-10-10T00:00:00Z');
const settings = async () =>
  (await getAudit(period)).capabilities.find(row => row.id === 'team.catalog_settings')!;
beforeAll(async () => {
  db = await createAnalyticsDb();
  // Unrelated authoritative rows must never be mistaken for settings capture proof.
  await db.exec(
    "insert into public.analytics_catalog_sync_jobs(created_at,updated_at) values('2026-10-05','2026-10-05')"
  );
}, 30_000);
afterEach(async () =>
  db.exec(
    'drop view if exists public.analytics_catalog_settings_current; drop view if exists public.analytics_catalog_settings_history; drop view if exists public.analytics_catalog_settings_coverage;'
  )
);
afterAll(async () => db?.close());
async function evidence(capture = true, installed = '2026-10-01T00:00:00Z') {
  await db.exec(`create view public.analytics_catalog_settings_history as
    select '2026-10-04T00:00:00Z'::timestamptz as observed_at,'baseline'::text as source
    union all select '2026-10-05T00:00:00Z'::timestamptz,'change'::text;
    create view public.analytics_catalog_settings_current as select '{}'::jsonb as state;
    create view public.analytics_catalog_settings_coverage as
      select '${installed}'::timestamptz as installed_at,${capture}::boolean as capture_enabled,1::integer as schema_version;`);
}

describe('catalog settings capability audit uses its own authoritative source', () => {
  it('reports missing views as uncovered despite unrelated sync job evidence', async () => {
    expect(await settings()).toMatchObject({
      status: 'uncovered',
      samples: 0,
      source: 'authoritative_table'
    });
    expect((await settings()).missing).toContain('analytics_catalog_settings_history');
  });
  it('checks visible capture metadata and counts only period-bounded observations', async () => {
    await evidence();
    expect(await settings()).toMatchObject({ status: 'covered', samples: 2, missing: [] });
    expect((await settings()).note).toContain('Observed changes in period: 1');
    expect((await settings()).note).toContain(
      'Installed observation boundary: 2026-10-01T00:00:00.000Z.'
    );
  });
  it('retains old observations but refuses to call disabled capture covered', async () => {
    await evidence(false);
    expect(await settings()).toMatchObject({ status: 'partial', samples: 2 });
    expect((await settings()).missing).toContain('catalog_settings_capture_disabled');
  });
  it('keeps the pre-installation historical gap explicit', async () => {
    await evidence(true, '2026-10-04T00:00:00Z');
    expect(await settings()).toMatchObject({ status: 'partial' });
    expect((await settings()).missing).toContain('catalog_settings_before_installation_unobserved');
  });
});
