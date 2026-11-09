import { afterEach, expect, it, vi } from 'vitest';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { getCatalogPublicationEvidence } from '../scripts/analytics/catalog-publications';
const id = (n: number) => '77000000-0000-4000-8000-' + String(n).padStart(12, '0');
const row = {
  catalog_material_id: id(1),
  team_id: id(2),
  policy_revision: 2,
  publication_mode: 'immediate',
  due_at: null,
  job_due_at: '2030-01-01T00:00:00Z',
  job_time_zone: 'UTC',
  requested_mode: 'scheduled',
  job_target_kind: 'source',
  job_source_material_id: id(3),
  job_source_version: 'v1',
  job_video_set_id: null,
  job_recipe_revision: null,
  requested_generated_video_count: null,
  registered_generated_video_count: null,
  job_id: id(4),
  command_id: id(5),
  job_revision: 1,
  job_state: 'published',
  blocked_reason: null,
  writer_fence_present: true,
  dispatched_at: '2029-12-31T23:59:00Z',
  lease_until: null,
  job_created_at: '2029-12-31T00:00:00Z',
  job_provider_revision: 'v2',
  job_verified_at: '2030-01-01T00:00:00.000001Z',
  active_verified_at: '2030-01-01T00:00:00.000001Z',
  active_target_kind: 'source',
  legacy_delivery_unverified: false,
  observed_at: '2030-01-02T00:00:00Z',
  verified_within_cutoff: false
};
afterEach(() => setQueryExecutor(null));
it('does not infer a future provider verification from current state or configuration', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    calls.push({ sql, params });
    return sql.includes('analytics_catalog_video_publications') ? [row] : [];
  });
  const result = await getCatalogPublicationEvidence({
    id: id(4),
    asOf: '2030-01-01T00:00:00.000000Z'
  });
  expect(result.records[0]).toMatchObject({
    provider_delivery: 'not_observed',
    ui_delivery: 'not_joined',
    lateness_ms: 0,
    active_delivery_basis: 'current_snapshot_only_not_reconstructed'
  });
  expect(calls.find(c => c.sql.includes('analytics_catalog_video_publications'))?.sql).toContain(
    'job_verified_at<=$3::timestamptz'
  );
});
it('resolves a baseline check UUID to its bounded catalog evidence without reading content', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    calls.push({ sql, params });
    return sql.includes('check_id=$1::uuid')
      ? [{ catalog_material_id: id(1) }]
      : sql.includes('analytics_catalog_video_publications')
        ? [{ ...row, verified_within_cutoff: true }]
        : [];
  });
  expect((await getCatalogPublicationEvidence({ id: id(6) })).records[0]).toMatchObject({
    catalog_material_id: id(1),
    provider_delivery: 'verified_settlement'
  });
  expect(
    calls.find(c => c.sql.includes('analytics_catalog_video_publications'))?.params[3]
  ).toEqual([id(1)]);
  expect(calls.every(c => !c.sql.includes('video_cells_digest'))).toBe(true);
});
it('preserves timeout and malformed sources as unknown without leaking arbitrary payloads', async () => {
  setQueryExecutor(async () => {
    throw Object.assign(Error('read timeout'), { code: 'ANALYTICS_QUERY_TIMEOUT' });
  });
  const timeout = await getCatalogPublicationEvidence({ id: id(1) });
  expect(timeout.status).toBe('unavailable');
  expect(timeout.missing_sources).toContainEqual({ source: 'publications', reason: 'timeout' });
  setQueryExecutor(async () => [{ providerPayload: 'https://private.example.invalid/secret' }]);
  const malformed = await getCatalogPublicationEvidence({ id: id(1) });
  expect(malformed.status).toBe('unavailable');
  expect(malformed.invalid_record_count).toBe(1);
  expect(JSON.stringify(malformed)).not.toContain('private.example');
});
it('refuses invalid identifiers and bounds before issuing any query', async () => {
  const read = vi.fn(async () => []);
  setQueryExecutor(read);
  await expect(getCatalogPublicationEvidence({ id: 'not-id' })).rejects.toThrow();
  await expect(getCatalogPublicationEvidence({ id: id(1), limit: 51 })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('whitelists normalized fields instead of leaking arbitrary projection extras', async () => {
  setQueryExecutor(async sql =>
    sql.includes('analytics_catalog_video_publications')
      ? [{ ...row, provider_payload: 'PRIVATE_PAYLOAD', raw_path: '/private/raw-source' }]
      : []
  );
  const result = await getCatalogPublicationEvidence({ id: id(4) });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).not.toHaveProperty('provider_payload');
  expect(result.records[0]).not.toHaveProperty('raw_path');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_PAYLOAD');
});
