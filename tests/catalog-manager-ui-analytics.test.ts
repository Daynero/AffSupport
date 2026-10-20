import { describe, expect, it, vi } from 'vitest';
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));
import { beginCatalogUiFlow } from '../apps/web/src/team/catalog-updater/analytics';
import { COVERAGE_REGISTRY } from '../scripts/analytics/coverage-registry';

describe('catalog manager UI evidence', () => {
  it('keeps acknowledgement separate from visible delivery and deduplicates terminals', () => {
    const track = vi.fn();
    const flow = beginCatalogUiFlow('profile', { count: 1 }, { track });
    flow.stage('draft_changed');
    flow.stage('save_requested');
    flow.stage('save_confirmed');
    expect(track.mock.calls.some(([event]) => event === 'operation_completed')).toBe(false);
    flow.complete();
    flow.complete();
    flow.cancel();
    const calls = track.mock.calls;
    expect(calls.filter(([event]) => event === 'operation_completed')).toHaveLength(1);
    expect(calls.at(-1)?.[1]).toMatchObject({
      flow_id: flow.id,
      attempt_id: flow.id,
      action_identifier: 'result_visible'
    });
    expect(
      calls.every(([, properties]) => properties.flow_step === 'catalog_manager_profile')
    ).toBe(true);
    expect(Object.keys(calls[0][1]).sort()).toEqual([
      'action_identifier',
      'attempt_id',
      'duration_ms',
      'feature_identifier',
      'file_count',
      'flow_id',
      'flow_step',
      'item_count'
    ]);
  });
  it('reports conflict and cancellation without declaring visible success', () => {
    const track = vi.fn();
    beginCatalogUiFlow('bulk', { count: 3, hiddenCount: 1 }, { track }).fail('CONFLICT');
    beginCatalogUiFlow('filter', {}, { track }).cancel();
    expect(track.mock.calls.filter(([event]) => event === 'operation_completed')).toHaveLength(0);
    expect(track.mock.calls.find(([event]) => event === 'operation_failed')?.[1]).toMatchObject({
      error_code: 'CONFLICT',
      action_identifier: 'conflict'
    });
  });
  it('cannot fail a product action when persistence rejects telemetry', () => {
    const flow = beginCatalogUiFlow(
      'list',
      {},
      {
        track: () => {
          throw new Error('storage');
        }
      }
    );
    expect(() => flow.complete()).not.toThrow();
  });
  it('registers every UI action separately for bounded read-only diagnosis', () => {
    for (const action of ['list', 'filter', 'profile', 'bulk', 'template']) {
      const capability = COVERAGE_REGISTRY.find(
        entry => entry.id === `team.catalog_manager_${action}`
      );
      expect(capability?.start[0]).toMatchObject({
        flowStep: `catalog_manager_${action}`,
        correlate: 'attempt_id'
      });
      expect(capability?.unobservable.join(' ')).toContain('unknown');
    }
  });
});

it('diagnoses a creation-period result without collecting date bounds', () => {
  const track = vi.fn();
  const flow = beginCatalogUiFlow('filter', { field: 'createdAt', count: 0 }, { track });
  flow.stage('result_visible');
  flow.complete();
  expect(track.mock.calls.at(-1)?.[1]).toMatchObject({
    flow_step: 'catalog_manager_filter',
    setting_name: 'createdAt',
    item_count: 0,
    action_identifier: 'result_visible'
  });
  expect(track.mock.calls.at(-1)![1]).not.toHaveProperty('from');
  expect(track.mock.calls.at(-1)![1]).not.toHaveProperty('to');
});
