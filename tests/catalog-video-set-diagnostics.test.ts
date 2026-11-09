import { afterEach, expect, it, vi } from 'vitest';
import { setQueryExecutor, assertReadOnlySql } from '../scripts/analytics/db';
import { getCatalogVideoSetEvidence } from '../scripts/analytics/catalog-video-sets';
import { investigateOutputIsPrivate } from '../scripts/analytics/types';
const id = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const parent = {
  video_set_id: id(1),
  state: 'preparing',
  requested_count: 5,
  product_count: 100,
  registered_count: 2,
  working_count: 1,
  unknown_count: 0,
  queued_count: 2,
  catalog_material_id: null,
  catalog_intent_id: id(2),
  update_attempt_id: null,
  recipe_revision: 1,
  executor_bound: true,
  native_boot_observed: true,
  created_at: '2026-11-08T00:00:00Z',
  updated_at: '2026-11-08T01:00:00Z'
};
afterEach(() => setQueryExecutor(null));
it('joins original child and process IDs without claiming catalog delivery', async () => {
  setQueryExecutor(async sql => {
    assertReadOnlySql(sql);
    return sql.startsWith('select reference_id')
      ? []
      : sql.includes('analytics_catalog_updater_video_requests')
        ? []
        : sql.includes('select s.video_set_id')
          ? [parent]
          : [
              {
                video_set_id: id(1),
                video_variant_index: 0,
                request_id: id(3),
                operation_id: id(4),
                state: 'registered',
                output_registered: true,
                operation_state: 'succeeded'
              }
            ];
  });
  const result = await getCatalogVideoSetEvidence(id(4));
  expect(result).toMatchObject({
    status: 'available',
    browser_delivery: 'not_joined',
    records: [{ requested_count: 5, registered_count: 2 }],
    children: [{ request_id: id(3), operation_id: id(4) }]
  });
  expect(investigateOutputIsPrivate(result)).toBe(true);
});
it('does not reconstruct current child state at a historical cutoff', async () => {
  const read = vi.fn(async () => []);
  setQueryExecutor(read);
  expect(await getCatalogVideoSetEvidence(id(1), '2026-11-01T00:00:00Z')).toMatchObject({
    status: 'historical_state_unknown',
    records: []
  });
  expect(read).not.toHaveBeenCalled();
});
it('rejects inconsistent counts and does not return arbitrary payloads', async () => {
  setQueryExecutor(async sql =>
    sql.includes('analytics_catalog_updater_video_requests')
      ? []
      : [{ ...parent, registered_count: 6, providerPayload: 'https://private.invalid/secret' }]
  );
  const result = await getCatalogVideoSetEvidence(id(1));
  expect(result.status).toBe('unavailable');
  expect(result.invalid_record_count).toBe(1);
  expect(JSON.stringify(result)).not.toContain('private.invalid');
});
it('preserves a timed-out source as unknown', async () => {
  setQueryExecutor(async () => {
    throw Object.assign(Error('private provider error'), { code: 'ANALYTICS_QUERY_TIMEOUT' });
  });
  expect(await getCatalogVideoSetEvidence(id(1))).toMatchObject({
    status: 'unavailable',
    missing_sources: ['timeout', 'commands_timeout']
  });
});
