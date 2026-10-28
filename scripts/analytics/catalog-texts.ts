import { query } from './db.js';
import { getSchema } from './schema.js';
import type { ResolvedPeriod } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export async function getCatalogTextScheduleDiagnosis(
  id: string | null,
  period: ResolvedPeriod,
  limit = 100
) {
  if (id !== null && !UUID.test(id)) throw new Error('Expected a team or run UUID.');
  const schema = await getSchema();
  const required = [
    'analytics_catalog_text_schedule',
    'analytics_catalog_text_schedule_journal',
    'analytics_catalog_text_schedule_coverage'
  ] as const;
  const missing: string[] = required.filter(name => !schema.tables[name]);
  if (missing.length)
    return {
      supported: false,
      missing,
      current: [],
      evidence: [],
      coverage: null,
      truncated: false,
      findings: ['Schedule diagnostics unavailable; missing evidence is not a successful run.']
    };
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  const [current, evidence, health] = await Promise.all([
    period.as_of
      ? Promise.resolve([])
      : query<Record<string, unknown>>(
          `select team_id,enabled,text_count,revision,next_run_at,next_attempt_at,last_run_at,last_error,run_id,lease_until,attempts,updated_at
       from public.analytics_catalog_text_schedule where ($1::uuid is null or team_id=$1 or run_id=$1)
       order by updated_at desc limit $2`,
          [id, bounded]
        ),
    query<{
      evidence_id: string;
      team_id: string;
      run_id: string | null;
      stage: string;
      code: string | null;
      schedule_revision: number;
      text_count: number;
      occurred_at: string;
    }>(
      `select evidence_id,team_id,run_id,stage,code,schedule_revision,text_count,occurred_at
       from public.analytics_catalog_text_schedule_journal
       where ($1::uuid is null or team_id=$1 or run_id=$1) and ($2::timestamptz is null or occurred_at >= $2) and occurred_at <= $3
       order by occurred_at desc,evidence_id desc limit $4`,
      [id, period.start, period.end, bounded + 1]
    ),
    query<{ installed_at: string; schema_version: number; capture_enabled: boolean }>(
      'select installed_at,schema_version,capture_enabled from public.analytics_catalog_text_schedule_coverage'
    )
  ]);
  const coverage = health[0] ?? null;
  if (!coverage || coverage.capture_enabled !== true)
    missing.push('catalog_text_schedule_capture_unconfirmed');
  if (coverage && coverage.schema_version !== 1)
    missing.push('catalog_text_schedule_schema_version');
  if (coverage && (!period.start || Date.parse(period.start) < Date.parse(coverage.installed_at)))
    missing.push('catalog_text_schedule_before_installation_unobserved');
  const rows = evidence.slice(0, bounded);
  const latestRun = rows.find(row => row.run_id !== null);
  return {
    supported: true,
    missing,
    current,
    evidence: rows,
    coverage,
    truncated: evidence.length > bounded,
    last_proven_stage: latestRun?.stage ?? null,
    code_locations: latestRun?.code
      ? {
          files: [
            'supabase/functions/catalog-updater/text-schedule.ts',
            'supabase/migrations/20261206160000_catalog_text_schedule.sql',
            'apps/web/src/team/product-catalog/ProductCatalogSettingsSection.tsx'
          ],
          check:
            'Compare the failed run stage with its lease, configuration revision and latest committed receipt before retrying.'
        }
      : null,
    findings: [
      ...(latestRun?.stage === 'failed'
        ? [
            'The automatic replacement failed; use its stable code and run UUID to inspect the retry.'
          ]
        : []),
      ...(latestRun && ['claimed', 'lease_recovered'].includes(latestRun.stage)
        ? ['No terminal receipt in this bounded result; completion is unknown.']
        : []),
      ...(period.as_of
        ? ['Current settings omitted for historical as-of; journal evidence only.']
        : []),
      'Committed proves an atomic replacement of saved texts, not delivery into existing catalogs or browser visibility.',
      'No text content or image names are collected. Missing and truncated evidence remain unknown.'
    ]
  };
}
