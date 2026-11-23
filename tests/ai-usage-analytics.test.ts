import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { getAiUsage } from '../scripts/analytics/ai-usage';
import { lookupCodeLocations } from '../scripts/analytics/code-map';
import { COVERAGE_REGISTRY } from '../scripts/analytics/coverage-registry';
import { TEAM_TRANSLATION_ERROR_CODES } from '../packages/shared/src/team/transport';

/**
 * 063: the owner asks what translation costs and whether it works; the agent answers from the
 * aggregate views alone. No text, translation or fingerprint is selected.
 */

const USER = '06300000-0000-4000-8000-000000000001';
const period = {
  token: '7d',
  start: '2026-11-15T00:00:00Z',
  end: '2026-11-22T00:00:00Z',
  label: 'last 7 days',
  as_of: null
} as never;

let db: AnalyticsTestDb;
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    create table usage_rows(day date, feature text, model text, outcome text, calls integer, users integer,
      input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
      cost_micro_usd bigint, duration_ms bigint);
    insert into usage_rows values
      ('2026-11-21','transcript_translation','claude-haiku-5-5','completed',10,2,20000,9000,0,0,6500,90000),
      ('2026-11-21','transcript_translation','claude-haiku-5-5','refused',2,1,3000,0,0,0,300,4000),
      ('2026-11-21','transcript_translation','claude-sonnet-5-5','completed',1,1,2000,800,0,0,12000,8000);
    create view public.analytics_ai_usage_daily as select * from usage_rows;
    create table translation_rows(id uuid, scope text, team_id uuid, target_language text, source_language text,
      status text, failure_code text, units integer, total_segments integer, completed_segments integer,
      model text, requested_by uuid, created_at timestamptz, completed_at timestamptz, duration_ms integer);
    insert into translation_rows values
      (gen_random_uuid(),'team_video',null,'uk','tr','completed',null,1841,25,25,'claude-haiku-5-5','${USER}','2026-11-21T10:00Z','2026-11-21T10:00:20Z',20000),
      (gen_random_uuid(),'personal',null,'es-MX','tr','completed',null,900,10,10,'claude-sonnet-5-5','${USER}','2026-11-21T11:00Z','2026-11-21T11:00:30Z',30000),
      (gen_random_uuid(),'team_video',null,'uk','ar','failed','TRANSLATION_REFUSED',500,5,0,null,'${USER}','2026-11-21T12:00Z',null,null);
    create view public.analytics_transcript_translations as select * from translation_rows;
    create table allowance_rows(day date, feature text, user_id uuid, spent_units integer, released_units integer,
      reservations integer, limit_units integer);
    insert into allowance_rows values ('2026-11-21','transcript_translation','${USER}',9000,500,3,9000);
    create view public.analytics_ai_allowance_daily as select * from allowance_rows;
  `);
}, 30000);
afterAll(async () => db?.close());

describe('ai-usage', () => {
  it('reports cost by model, translation outcomes, escalations and the busiest allowance', async () => {
    const report = await getAiUsage(period);
    expect(report.supported).toBe(true);
    expect(report.cost.calls).toBe(13);
    expect(report.cost.total_usd).toBeCloseTo(0.0188, 6);
    expect(report.cost.by_model[0]).toMatchObject({ model: 'claude-sonnet-5-5', calls: 1 });
    expect(report.translations.total).toBe(3);
    expect(report.translations.failures).toEqual([{ code: 'TRANSLATION_REFUSED', count: 1 }]);
    expect(report.translations.escalated_to_sonnet).toBe(1);
    expect(report.translations.minutes_translated).toBeCloseTo(3.0, 1);
    expect(report.allowance.top_users).toEqual([{ user_id: USER, spent_minutes: 10, days: 1 }]);
    expect(report.allowance.users_at_limit).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/segments|fingerprint/u);
  });
});

describe('diagnostic coverage', () => {
  it('maps every translation code to the function and the migration', () => {
    for (const code of TEAM_TRANSLATION_ERROR_CODES) {
      const found = lookupCodeLocations(`translation:transcript:${code}`);
      expect(found?.files).toContain('supabase/functions/transcript-translate/handler.ts');
    }
  });

  it('registers the capability beside the retired local translator', () => {
    const ids = COVERAGE_REGISTRY.map(capability => capability.id);
    expect(ids).toContain('translation.transcript');
    expect(ids).toContain('transcription.translate');
  });
});
