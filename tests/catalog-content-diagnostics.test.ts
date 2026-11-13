import { describe, expect, it } from 'vitest';
import { parseCatalogContentEvidence } from '../scripts/analytics/catalog-content';
import {
  mergeCatalogGenerationInspection,
  type CatalogGenerationEvidence,
  type CatalogGenerationSnapshot
} from '../scripts/analytics/catalog-generations';
import { investigatePrivacyFailure, type InspectData } from '../scripts/analytics/types';

const ID = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const valid = {
  content_receipt_status: 'frozen',
  content_policy_version: 1,
  planned_row_count: 200,
  automatic_row_count: 20,
  retained_row_count: 180
};
function record(patch: Partial<CatalogGenerationSnapshot> = {}): CatalogGenerationSnapshot {
  return {
    ...parseCatalogContentEvidence(valid),
    intent_id: ID,
    operation_id: OPERATION,
    attempt: 1,
    origin: 'standalone',
    state: 'planned',
    safe_error_code: null,
    created_at: '2026-11-13T10:00:00.000Z',
    updated_at: '2026-11-13T10:01:00.000Z',
    settings_observed: false,
    source_observed: true,
    rows_planned: true,
    provider_result_observed: false,
    result_registered: false,
    performance: null,
    native_sheet_mode: null,
    native_sheet_bound: null,
    native_write_acknowledged: null,
    ...patch
  };
}
function evidence(rows: CatalogGenerationSnapshot[]): CatalogGenerationEvidence {
  return {
    supported: true,
    scope: 'current_snapshot_not_transition_history',
    records: rows,
    truncated: false,
    unknown_projection: false,
    blind_spots: []
  };
}

describe('bounded frozen content evidence', () => {
  it('distinguishes absent, selected and frozen without interpreting legacy content', () => {
    expect(parseCatalogContentEvidence({})).toMatchObject({
      content_receipt_status: 'unavailable',
      content_policy_version: null
    });
    expect(
      parseCatalogContentEvidence({
        content_receipt_status: 'policy_selected',
        content_policy_version: 1
      })
    ).toMatchObject({ content_receipt_status: 'policy_selected', planned_row_count: null });
    expect(parseCatalogContentEvidence(valid)).toEqual(valid);
    expect(
      parseCatalogContentEvidence({ ...valid, automatic_row_count: 0, retained_row_count: 200 })
    ).toMatchObject({ automatic_row_count: 0, retained_row_count: 200 });
  });
  it.each([
    { content_policy_version: 2 },
    { planned_row_count: 401 },
    { automatic_row_count: -1 },
    { planned_row_count: 0, automatic_row_count: 0, retained_row_count: 0 },
    { automatic_row_count: 10 },
    { retained_row_count: 0.5 },
    { planned_row_count: '200' },
    { content_receipt_status: 'private-value' },
    { content_receipt_status: undefined },
    { content_receipt_status: 'policy_selected' }
  ])('rejects malformed or mismatched receipt %j without content leakage', patch => {
    expect(parseCatalogContentEvidence({ ...valid, ...patch })).toEqual({
      content_receipt_status: 'invalid',
      content_policy_version: null,
      planned_row_count: null,
      automatic_row_count: null,
      retained_row_count: null
    });
  });
  it('joins only exact intent or operation IDs, never a matching actor or team search', () => {
    expect(
      mergeCatalogGenerationInspection({ found: false, id: OPERATION }, evidence([record()]))
    ).toMatchObject({ found: true, capability: 'team.product_catalog' });
    const unrelated: InspectData = { found: false, id: '33333333-3333-4333-8333-333333333333' };
    expect(mergeCatalogGenerationInspection(unrelated, evidence([record()]))).toBe(unrelated);
  });
  it('keeps persisted success separate from invalid recipe evidence and browser visibility', () => {
    const result = mergeCatalogGenerationInspection(
      { found: false, id: ID },
      evidence([
        record({
          ...parseCatalogContentEvidence({ ...valid, automatic_row_count: 201 }),
          state: 'registered',
          result_registered: true
        })
      ])
    );
    expect(result).toMatchObject({
      found: true,
      terminal: { event: 'catalog_registered', outcome: 'success' },
      stages: { missing: expect.arrayContaining(['result_visible']) },
      catalog_generations: { records: [{ content_receipt_status: 'invalid' }] }
    });
    expect(investigatePrivacyFailure(result)).toBeNull();
  });
  it('preserves batch, rename and native inspection terminals when adding catalog evidence', () => {
    const core = mergeCatalogGenerationInspection(
      { found: false, id: ID },
      evidence([record({ state: 'registered', result_registered: true })])
    );
    if (!core.found) throw new Error('Expected fixture inspection');
    const existing = {
      ...core,
      capability: 'update.native_app',
      terminal: { event: 'native_terminal', outcome: 'failure', occurred_at: core.last_seen_at! }
    };
    const result = mergeCatalogGenerationInspection(existing, evidence([record()]));
    expect(result).toMatchObject({ capability: 'update.native_app', terminal: existing.terminal });
    expect(result.found && result.stages).toEqual(existing.stages);
  });
  it('does not relabel interruption or an unknown current outcome as terminal failure', () => {
    const result = mergeCatalogGenerationInspection(
      { found: false, id: ID },
      evidence([
        record({ state: 'interrupted', safe_error_code: 'GLOBAL_IMAGE_ALLOCATION_UNKNOWN' })
      ])
    );
    expect(result).toMatchObject({ terminal: null, last_proven_stage: 'interrupted' });
  });
});
