import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCatalogTextScheduleDiagnosis } from '../scripts/analytics/catalog-texts';
import { resolvePeriod } from '../scripts/analytics/periods';
import { query } from '../scripts/analytics/db';
import { getSchema } from '../scripts/analytics/schema';
vi.mock('../scripts/analytics/db', () => ({ query: vi.fn() }));
vi.mock('../scripts/analytics/schema', () => ({ getSchema: vi.fn() }));
const id = '22222222-2222-4222-8222-222222222222';
const period = resolvePeriod('7d', undefined, '2026-10-28T00:00:00Z');
const tables = {
  analytics_catalog_text_schedule: true,
  analytics_catalog_text_schedule_journal: true,
  analytics_catalog_text_schedule_coverage: true
};
afterEach(() => vi.resetAllMocks());
function schema(available: boolean) {
  vi.mocked(getSchema).mockResolvedValue({
    events: { attempt_id: false, agent_instance_id: false, agent_platform: false },
    tables: {
      agent_journal_records: false,
      analytics_daily_events: false,
      analytics_daily_tool_outcomes: false,
      analytics_catalog_sync_jobs: false,
      ...(available ? tables : {})
    }
  });
}
describe('weekly text schedule agent diagnostics', () => {
  it('does not mistake missing projections for no failures', async () => {
    schema(false);
    const result = await getCatalogTextScheduleDiagnosis(id, period);
    expect(result.supported).toBe(false);
    expect(result.missing).toContain('analytics_catalog_text_schedule_journal');
    expect(query).not.toHaveBeenCalled();
  });
  it('keeps as-of history separate from current configuration and exposes truncation', async () => {
    schema(true);
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('_coverage')
        ? [{ installed_at: '2026-10-25T00:00:00Z', schema_version: 1, capture_enabled: true }]
        : ([
            { evidence_id: '2', team_id: id, run_id: id, stage: 'claimed', code: null },
            { evidence_id: '1', team_id: id, run_id: id, stage: 'configured', code: null }
          ] as never)
    );
    const result = await getCatalogTextScheduleDiagnosis(id, period, 1);
    expect(result.current).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.last_proven_stage).toBe('claimed');
    expect(result.missing).toContain('catalog_text_schedule_before_installation_unobserved');
    expect(result.findings).toContain(
      'No terminal receipt in this bounded result; completion is unknown.'
    );
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([id, period.start, period.end, 2]);
    expect(
      vi.mocked(query).mock.calls.some(([sql]) => sql.includes('select team_id,enabled'))
    ).toBe(false);
  });
  it('reports disabled capture and failed runs without collecting content', async () => {
    schema(true);
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('_coverage')
        ? [{ installed_at: '2026-10-01T00:00:00Z', schema_version: 1, capture_enabled: false }]
        : ([
            { evidence_id: '1', team_id: id, run_id: id, stage: 'failed', code: 'READ_FAILED' }
          ] as never)
    );
    const result = await getCatalogTextScheduleDiagnosis(id, period);
    expect(result.missing).toContain('catalog_text_schedule_capture_unconfirmed');
    expect(result.last_proven_stage).toBe('failed');
    expect(vi.mocked(query).mock.calls.every(([sql]) => !sql.includes('description'))).toBe(true);
  });
});
