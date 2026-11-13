import { readFileSync } from 'node:fs';
import type { AnalyticsTestDb } from './analytics-pglite';

/** Apply exact canonical fragments to the small producer fixture; full-chain tests apply the whole migration. */
export async function installCatalogContentGenerationProjection(db: AnalyticsTestDb) {
  const source = readFileSync(
    'supabase/migrations/20261208121000_automatic_catalog_content_diagnostics.sql',
    'utf8'
  );
  const start = source.indexOf('create function private.catalog_content_diagnostic_receipt(');
  const end = source.indexOf('create or replace view public.analytics_catalog_updates as');
  if (start < 0 || end < 0) throw new Error('Canonical automatic content projection missing');
  await db.exec(source.slice(start, end));
  await db.exec(
    'grant execute on function private.catalog_content_diagnostic_receipt(jsonb,integer,jsonb) to wishly_analytics_ro'
  );
}
