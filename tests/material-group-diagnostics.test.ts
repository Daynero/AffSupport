import { afterEach, expect, it } from 'vitest';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import {
  getMaterialGroupEvidence,
  mergeMaterialGroupInspection
} from '../scripts/analytics/material-groups';
import { getWorkspaceEvidence } from '../scripts/analytics/workspace';

const actor = 'b1510000-0000-4000-8000-000000000001';
const at = '2026-11-06T12:00:00Z';
const row = {
  id: 'b1510000-0000-4000-8000-000000000002',
  operation_id: 'b1510000-0000-4000-8000-000000000003',
  team_id: 'b1510000-0000-4000-8000-000000000004',
  actor_id: actor,
  action: 'trash',
  state: 'dispatch_unconfirmed',
  code: null,
  member_count: 2,
  confirmed_count: 0,
  has_unconfirmed_dispatch: true,
  created_at: at,
  updated_at: at
};
afterEach(() => setQueryExecutor(null));
function reader(
  options: {
    absent?: boolean;
    fails?: boolean;
    workspaceFails?: boolean;
    rows?: Record<string, unknown>[];
  } = {}
) {
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    if (sql.includes('information_schema.columns'))
      return options.absent
        ? []
        : [
            { kind: 'table', name: 'analytics_material_group_execution' },
            ...(options.workspaceFails
              ? [{ kind: 'table', name: 'analytics_workspace_operations' }]
              : [])
          ];
    if (options.workspaceFails && sql.includes('from public.analytics_workspace_operations'))
      throw Error('Synthetic workspace projection unavailable');
    expect(sql).toContain('limit 101');
    expect(sql).toContain('updated_at <= $4::timestamptz');
    expect(params).toEqual([actor, null, null, at]);
    if (options.fails) throw Error('Synthetic projection unavailable');
    return options.rows ?? [row];
  });
}
it('retains available group evidence when the independent workspace projection is missing', async () => {
  reader();
  const evidence = await getWorkspaceEvidence(actor, null, at);
  expect(evidence.supported).toBe(false);
  expect(evidence.material_groups?.records).toHaveLength(1);
  expect(evidence.blind_spots.join(' ')).toContain(
    'Workspace diagnostic projection is unavailable'
  );
});
it('retains independent group evidence when the workspace read fails', async () => {
  reader({ workspaceFails: true });
  const evidence = await getWorkspaceEvidence(actor, null, at);
  expect(evidence.material_groups?.records).toHaveLength(1);
  expect(evidence.blind_spots.join(' ')).toContain('Workspace diagnostic read failed');
});
it('normalizes opaque actor selectors and keeps current-state limitations explicit', async () => {
  reader();
  const evidence = await getMaterialGroupEvidence({ actorId: actor.toUpperCase(), asOf: at });
  expect(evidence.records).toHaveLength(1);
  expect(evidence.blind_spots.join(' ')).toContain('not reconstructed');
});
it('keeps unobserved execution and delivery stages missing when only a reservation is known', async () => {
  reader();
  const evidence = await getMaterialGroupEvidence({ actorId: actor, asOf: at });
  const detail = mergeMaterialGroupInspection({ found: false, id: row.operation_id }, evidence);
  expect(detail.found).toBe(true);
  if (!detail.found) throw Error('Expected hosted reservation');
  expect(detail.stages.observed).toEqual(['dispatch_reserved']);
  expect(detail.stages.missing).toContain('provider_confirmed');
  expect(detail.stages.missing).toContain('registered');
  expect(detail.stages.missing).toContain('result_visible');
  expect(detail.terminal).toBeNull();
});
it('reports unavailable and failed reads as blind spots', async () => {
  reader({ absent: true });
  expect(await getMaterialGroupEvidence({ actorId: actor, asOf: at })).toMatchObject({
    supported: false,
    records: []
  });
  reader({ fails: true });
  const evidence = await getMaterialGroupEvidence({ actorId: actor, asOf: at });
  expect(evidence.records).toEqual([]);
  expect(evidence.blind_spots.join(' ')).toContain('read failed');
});
it('omits contradictory terminal or foreign evidence and never serializes raw fields', async () => {
  reader({
    rows: [
      { ...row, state: 'registered', confirmed_count: 2 },
      { ...row, actor_id: row.team_id },
      { ...row, action: { toString: () => 'trash' } },
      { ...row, secret: 'SYNTHETIC-PRIVATE-CONTENT' }
    ]
  });
  const evidence = await getMaterialGroupEvidence({ actorId: actor, asOf: at });
  expect(evidence.records).toHaveLength(1);
  expect(evidence.blind_spots.join(' ')).toContain('Malformed or conflicting');
  expect(JSON.stringify(evidence)).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
});
it('bounds receipts at 100 and reports truncation and unknown closed causes', async () => {
  reader({ rows: Array.from({ length: 101 }, () => ({ ...row, code: 'UNRECOGNIZED_CAUSE' })) });
  const evidence = await getMaterialGroupEvidence({ actorId: actor, asOf: at });
  expect(evidence.records).toHaveLength(100);
  expect(evidence.records.every(value => value.code === 'UNKNOWN')).toBe(true);
  expect(evidence.blind_spots.join(' ')).toContain('truncated at 100');
});

it('exposes only the current fenced epoch through the bounded read-only projection', async () => {
  reader({ rows: [{ ...row, ownership_observed: true, claim_protocol: 2, execution_epoch: 3 }] });
  const evidence = await getMaterialGroupEvidence({ actorId: actor, asOf: at });
  expect(evidence.records[0]).toMatchObject({ claim_protocol: 2, execution_epoch: 3 });
  expect(JSON.stringify(evidence)).not.toContain('execution_owner');
});
it('keeps absent and malformed ownership separate from the independently known dispatch state', async () => {
  reader({ rows: [{ ...row, ownership_observed: true, claim_protocol: 2, execution_epoch: '3' }] });
  const malformed = await getMaterialGroupEvidence({ actorId: actor, asOf: at });
  expect(malformed.records[0]).toMatchObject({
    state: 'dispatch_unconfirmed',
    execution_epoch: null,
    claim_protocol: null
  });
  expect(malformed.blind_spots.join(' ')).toContain('Malformed execution ownership');
  reader();
  const absent = await getMaterialGroupEvidence({ actorId: actor, asOf: at });
  expect(absent.records[0]?.execution_epoch).toBeNull();
  expect(absent.blind_spots.join(' ')).toContain('epoch projection is unavailable');
});
