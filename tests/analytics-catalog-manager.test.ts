import { afterEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '../scripts/analytics/periods';
import { setQueryExecutor } from '../scripts/analytics/db.js';
import {
  getCatalogUpdateDiagnosis,
  getTeamCatalogUpdateDiagnosis,
  getOwnedCatalogClaimEvidence
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
    expect(calls).toEqual([[ATTEMPT, 50], [CATALOG, 3], []]);
    await expect(getTeamCatalogUpdateDiagnosis('invalid')).rejects.toThrow('Expected a team UUID');
    expect(calls).toHaveLength(3);
  });
  it('uses a bounded read-only query and separates proven delivery from unknown results', async () => {
    let sql = '';
    setQueryExecutor(async (statement, params) => {
      if (statement.includes('information_schema.views')) return [{ present: false }];
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

  it('keeps missing and historical eligibility unknown rather than claiming an empty queue', async () => {
    let calls = 0;
    setQueryExecutor(async () => {
      calls++;
      return [{ present: false }];
    });
    expect(await getOwnedCatalogClaimEvidence(CATALOG)).toMatchObject({
      status: 'unavailable',
      records: []
    });
    expect(await getOwnedCatalogClaimEvidence(CATALOG, '2026-11-04T23:49:16Z')).toMatchObject({
      status: 'unavailable',
      records: []
    });
    expect(calls).toBe(1);
  });
  it('bounds live owner evidence and declares truncation without reading content', async () => {
    setQueryExecutor(async (sql, params) => {
      if (sql.includes('information_schema.views')) return [{ present: true }];
      expect(sql).toContain('where owner_id=$1::uuid');
      expect(sql).toContain('limit 51');
      expect(params).toEqual([CATALOG]);
      return Array.from({ length: 51 }, () => ({
        catalog_id: CATALOG,
        blockers: ['previous_operation_open'],
        observed_at: '2026-11-05T00:00:00Z'
      }));
    });
    const result = await getOwnedCatalogClaimEvidence(CATALOG);
    expect(result).toMatchObject({ status: 'observed', truncated: true });
    expect(result.records).toHaveLength(50);
  });

  it('rejects identifiers before querying', async () => {
    await expect(getCatalogUpdateDiagnosis('not-an-id')).rejects.toThrow('Expected a catalog');
  });
});

it('pins attempt discovery and never presents a later receipt as as-of success', async () => {
  const period = resolvePeriod('7d', undefined, '2026-11-05T12:00:00Z');
  setQueryExecutor(async (sql, params) => {
    if (sql.includes('information_schema.views')) return [{ present: true }];
    expect(sql).toContain('started_at <= $4::timestamptz');
    expect(params).toEqual([CATALOG, 10, period.start, period.end]);
    return [
      {
        attempt_id: ATTEMPT,
        catalog_material_id: CATALOG,
        started_at: '2026-11-05T11:00:00Z',
        ended_at: '2026-11-05T13:00:00Z',
        result: 'success',
        delivery_verified_at: '2026-11-05T13:00:00Z',
        current_profile_version: 5,
        content_receipt_status: 'frozen',
        content_policy_version: 1,
        planned_row_count: 2,
        automatic_row_count: 1,
        retained_row_count: 1,
        stage_history: [
          { stage: 'queued', at: '2026-11-05T11:00:00Z' },
          { stage: 'complete', at: '2026-11-05T13:00:00Z' }
        ]
      }
    ];
  });
  const data = await getCatalogUpdateDiagnosis(CATALOG, 10, period);
  expect(data.attempts[0]).toMatchObject({
    result: 'unknown',
    ended_at: null,
    delivery_verified_at: null,
    delivery_proven: false,
    actual_changes: null,
    content_receipt_status: 'unavailable',
    content_policy_version: null,
    planned_row_count: null,
    stages: [{ stage: 'queued', at: '2026-11-05T11:00:00Z' }]
  });
  expect(data.temporal_scope.current_fields_basis).toBe('current_snapshot_only');
  expect(data.claim_eligibility.status).toBe('unavailable');
});

it('keeps unknown delivery and actual terminal outcomes independent of content receipt quality', async () => {
  setQueryExecutor(async sql =>
    sql.includes('information_schema.views')
      ? [{ present: false }]
      : [
          {
            attempt_id: ATTEMPT,
            catalog_material_id: CATALOG,
            team_id: CATALOG,
            result: 'unknown',
            started_at: '2026-11-13T10:00:00Z',
            ended_at: null,
            content_receipt_status: 'frozen',
            content_policy_version: 1,
            planned_row_count: 200,
            automatic_row_count: 20,
            retained_row_count: 180
          },
          {
            attempt_id: CATALOG,
            catalog_material_id: CATALOG,
            team_id: CATALOG,
            result: 'success',
            started_at: '2026-11-13T09:00:00Z',
            ended_at: '2026-11-13T09:01:00Z',
            delivery_verified_at: '2026-11-13T09:01:00Z',
            content_receipt_status: 'frozen',
            content_policy_version: 1,
            planned_row_count: 200,
            automatic_row_count: 200,
            retained_row_count: 20
          }
        ]
  );
  const result = await getCatalogUpdateDiagnosis(CATALOG);
  expect(result.attempts[0]).toMatchObject({
    result: 'unknown',
    delivery_proven: false,
    content_receipt_status: 'frozen',
    automatic_row_count: 20,
    retained_row_count: 180
  });
  expect(result.attempts[1]).toMatchObject({
    result: 'success',
    delivery_proven: true,
    content_receipt_status: 'invalid',
    planned_row_count: null
  });
  expect(result.blind_spots.join(' ')).toContain('invalid');
});
