import { afterEach, describe, expect, it } from 'vitest';
import { setQueryExecutor } from '../scripts/analytics/db.js';
import {
  getCatalogUpdateDiagnosis,
  getTeamCatalogUpdateDiagnosis
} from '../scripts/analytics/catalog-updates.js';

const CATALOG = '23000000-0000-4000-8000-000000000001';
const ATTEMPT = '23000000-0000-4000-8000-000000000002';

afterEach(() => setQueryExecutor(null));

describe('catalog update diagnosis', () => {
  it('exposes a queued video blocked by its still-running operation and maps its exact cause', async () => {
    setQueryExecutor(async () => [
      {
        catalog_material_id: CATALOG,
        team_id: CATALOG,
        video_preparation_state: 'queued',
        video_operation_state: 'running',
        video_operation_stage: 'awaiting_agent',
        video_preparation_error: 'BODY_HEAD_FAILED'
      }
    ]);
    const diagnosis = await getCatalogUpdateDiagnosis(CATALOG);
    expect(diagnosis.video_preparation).toMatchObject({
      failure_code: 'BODY_HEAD_FAILED',
      retry_blocked_by_open_operation: true,
      code_locations: { matched: 'catalog:video:BODY_HEAD_FAILED' }
    });
  });
  it('discovers a bounded set of catalogs in exactly one team without names or content', async () => {
    const calls: unknown[][] = [];
    setQueryExecutor(async (sql, params) => {
      calls.push(params);
      if (sql.includes('group by catalog_material_id')) {
        expect(sql).toContain('where team_id = $1::uuid');
        return [{ catalog_material_id: CATALOG }];
      }
      return [];
    });
    expect(await getTeamCatalogUpdateDiagnosis(ATTEMPT, 1000)).toMatchObject({
      team_id: ATTEMPT,
      catalogs: [{ subject: null }]
    });
    expect(calls).toEqual([
      [ATTEMPT, 50],
      [CATALOG, 3]
    ]);
    await expect(getTeamCatalogUpdateDiagnosis('invalid')).rejects.toThrow('Expected a team UUID');
    expect(calls).toHaveLength(2);
  });
  it('uses a bounded read-only query and separates proven delivery from unknown results', async () => {
    let sql = '';
    setQueryExecutor(async (statement, params) => {
      sql = statement;
      expect(params).toEqual([CATALOG, 10]);
      return [
        {
          attempt_id: ATTEMPT,
          catalog_material_id: CATALOG,
          team_id: CATALOG,
          trigger_kind: 'manual',
          started_at: '2026-10-18T10:00:00Z',
          ended_at: null,
          result: 'unknown',
          failure_code: null,
          delivery_verified_at: null,
          profile_version: 2,
          source_attempt_id: null,
          current_profile_version: 2,
          update_interval: null,
          next_run_at: null,
          schedule: { timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' },
          attempt_schedule: { timeZone: 'Europe/Kyiv', weekday: 1, time: '09:00' },
          last_success_at: null,
          last_error_code: null,
          last_error_at: null,
          video_preparation_state: 'queued',
          video_preparation_error: 'NOT_FOUND',
          video_preparation_retry_at: '2026-10-18T10:05:00Z',
          video_preparation_lease_until: null
        }
      ];
    });
    const diagnosis = await getCatalogUpdateDiagnosis(CATALOG);
    expect(sql.trim().toLowerCase().startsWith('select')).toBe(true);
    expect(diagnosis.attempts[0]?.delivery_proven).toBe(false);
    expect(sql).toContain('schedule, attempt_schedule');
    expect(diagnosis.profile?.schedule).toEqual({
      timeZone: 'Europe/Kyiv',
      weekday: 7,
      time: '18:00'
    });
    expect(diagnosis.attempts[0]?.schedule).toEqual({
      timeZone: 'Europe/Kyiv',
      weekday: 1,
      time: '09:00'
    });
    expect(diagnosis.video_preparation).toMatchObject({
      state: 'queued',
      failure_code: 'NOT_FOUND',
      retry_at: '2026-10-18T10:05:00Z'
    });
    expect(diagnosis.blind_spots).toContain(
      'The last attempt has no conclusive delivery evidence.'
    );
    expect(JSON.stringify(diagnosis)).not.toContain('sheet_url');
  });

  it('rejects identifiers before querying', async () => {
    await expect(getCatalogUpdateDiagnosis('not-an-id')).rejects.toThrow('Expected a catalog');
  });
});
