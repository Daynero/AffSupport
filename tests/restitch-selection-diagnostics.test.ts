import { afterEach, expect, it } from 'vitest';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import {
  getRestitchSelectionEvidence,
  mergeRestitchSelectionInspection
} from '../scripts/analytics/restitch-selections';
import { getWorkspaceEvidence } from '../scripts/analytics/workspace';
const id = (n: number) => 'b1550000-0000-4000-8000-' + String(n).padStart(12, '0');
const actor = id(1),
  asOf = '2026-11-06T21:00:00Z';
const row = {
  operation_id: id(2),
  team_id: id(3),
  actor_id: actor,
  slot: 'end',
  pool_namespace_id: id(4),
  state: 'range_unconfirmed',
  snapshot_complete: true,
  candidate_count: 1,
  candidate_versions: [id(5)],
  range_count: 1,
  unconfirmed_range_count: 1,
  confirmed_bytes: 0,
  confirmed_io_ms: 0,
  retry_count: 0,
  refresh_count: 0,
  budget_revision: 2,
  created_at: asOf,
  updated_at: asOf
};
afterEach(() => setQueryExecutor(null));
function reader(
  options: { rows?: Record<string, unknown>[]; absent?: boolean; fails?: boolean } = {}
) {
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    if (sql.includes('information_schema.columns'))
      return options.absent ? [] : [{ kind: 'table', name: 'analytics_restitch_selection_slots' }];
    expect(sql).toContain('limit 101');
    expect(sql).toContain('updated_at <= $4::timestamptz');
    expect(params).toEqual([actor, null, null, asOf]);
    if (options.fails) throw Error('SYNTHETIC_READ_FAILURE');
    return options.rows ?? [row];
  });
}
it('retains independent screen evidence when the workspace projection is missing', async () => {
  reader();
  const result = await getWorkspaceEvidence(actor, null, asOf);
  expect(result.supported).toBe(false);
  expect(result.restitch_selections?.records).toHaveLength(1);
});
it('does not infer native processing or visible video delivery from a pending reservation', async () => {
  reader();
  const evidence = await getRestitchSelectionEvidence({ actorId: actor.toUpperCase(), asOf });
  const result = mergeRestitchSelectionInspection({ found: false, id: row.operation_id }, evidence);
  expect(result).toMatchObject({
    found: true,
    terminal: null,
    last_proven_stage: 'range_reserved'
  });
  if (!result.found) throw Error('Expected reservation');
  expect(result.stages.missing).toContain('video_processed');
  expect(result.stages.missing).toContain('result_visible');
  expect(evidence.blind_spots.join(' ')).toContain('storage-only');
});
it('keeps absent, failed and unprobed schema states distinct', async () => {
  reader({ absent: true });
  expect((await getRestitchSelectionEvidence({ actorId: actor, asOf })).supported).toBe(false);
  reader({ fails: true });
  const failed = await getRestitchSelectionEvidence({ actorId: actor, asOf });
  expect(failed).toMatchObject({ supported: true, records: [] });
  expect(failed.blind_spots.join(' ')).toContain('read failed');
  setQueryExecutor(async () => {
    throw Error('SYNTHETIC_SCHEMA_FAILURE');
  });
  expect((await getRestitchSelectionEvidence({ actorId: actor, asOf })).supported).toBeNull();
});
it('omits contradictory/foreign evidence and never serializes extra private fields', async () => {
  reader({
    rows: [
      { ...row, slot: { toString: () => 'end', secret: 'SYNTHETIC_PRIVATE' } },
      { ...row, actor_id: id(9) },
      { ...row, candidate_count: 0, candidate_versions: [] },
      { ...row, snapshot_complete: 'yes' },
      {
        ...row,
        candidate_count: 2,
        candidate_versions: [id(5), id(5).toUpperCase()],
        budget_revision: 3
      },
      { ...row, privatePayload: 'SYNTHETIC_PRIVATE' }
    ]
  });
  const evidence = await getRestitchSelectionEvidence({ actorId: actor, asOf });
  expect(evidence.records).toHaveLength(1);
  expect(JSON.stringify(evidence)).not.toContain('SYNTHETIC_PRIVATE');
  expect(evidence.blind_spots.join(' ')).toContain('Malformed');
});
it('bounds returned evidence and declares truncation', async () => {
  reader({ rows: Array.from({ length: 101 }, (_, n) => ({ ...row, operation_id: id(n + 20) })) });
  const result = await getRestitchSelectionEvidence({ actorId: actor, asOf });
  expect(result.records).toHaveLength(100);
  expect(result.blind_spots.join(' ')).toContain('truncated');
});

it('reports grant bookkeeping separately from I/O and retains legacy unknown coverage', async () => {
  reader({
    rows: [
      {
        ...row,
        range_count: 3,
        budget_revision: 6,
        grant_count: 3,
        issued_grant_count: 1,
        consumed_grant_count: 1,
        abandoned_grant_count: 1
      }
    ]
  });
  const evidence = await getRestitchSelectionEvidence({ actorId: actor, asOf });
  expect(evidence.records[0]?.authority).toEqual({
    total: 3,
    issued: 1,
    consumed: 1,
    abandoned: 1
  });
  const result = mergeRestitchSelectionInspection({ found: false, id: row.operation_id }, evidence);
  expect(result).toMatchObject({ terminal: null, last_proven_stage: 'range_accounted' });
  if (result.found) expect(result.stages.missing).toContain('video_processed');
  expect(evidence.blind_spots.join(' ')).toContain('Consumed authority');
  reader();
  const legacy = await getRestitchSelectionEvidence({ actorId: actor, asOf });
  expect(legacy.records[0]?.authority).toBeNull();
  expect(legacy.blind_spots.join(' ')).toContain('authority counters are unavailable');
});
it('refuses contradictory or partial authority counts without losing valid slot evidence', async () => {
  for (const counters of [
    { grant_count: 1 },
    { grant_count: 2, issued_grant_count: 1, consumed_grant_count: 1, abandoned_grant_count: 1 },
    { grant_count: 1, issued_grant_count: -1, consumed_grant_count: 1, abandoned_grant_count: 1 }
  ]) {
    reader({ rows: [{ ...row, ...counters }] });
    const evidence = await getRestitchSelectionEvidence({ actorId: actor, asOf });
    expect(evidence.records).toHaveLength(1);
    expect(evidence.records[0]?.authority).toBeNull();
    expect(evidence.blind_spots.join(' ')).toContain('authority counters are unavailable');
  }
});
it('accepts a disabled zero-candidate slot without inventing image work', async () => {
  reader({
    rows: [
      {
        ...row,
        state: 'disabled',
        candidate_count: 0,
        candidate_versions: [],
        range_count: 0,
        unconfirmed_range_count: 0,
        budget_revision: 0
      }
    ]
  });
  const evidence = await getRestitchSelectionEvidence({ actorId: actor, asOf });
  expect(evidence.records).toHaveLength(1);
  const result = mergeRestitchSelectionInspection({ found: false, id: row.operation_id }, evidence);
  expect(result).toMatchObject({ last_proven_stage: 'context_observed', terminal: null });
});
