import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../scripts/analytics/db', () => ({ query: vi.fn() }));
import { query } from '../scripts/analytics/db';
import { getCatalogGrowthEvidence } from '../scripts/analytics/catalog-growth';

const id = '47000000-0000-4000-8000-000000000001';
const row = {
  attempt_id: id,
  team_id: id,
  actor_id: id,
  catalog_material_id: id,
  command_id: id,
  base_revision: 1,
  base_product_count: 2,
  product_count: 3,
  target_kind: 'source',
  video_set_id: null,
  recipe_revision: null,
  target_bound: false,
  applied_at: null
};
afterEach(() => vi.mocked(query).mockReset());

it('joins original growth attempts to publication commands with only bounded content-free fields', async () => {
  vi.mocked(query).mockResolvedValue([
    { ...row, raw_recipe: 'PRIVATE_USER_CONTENT', url: 'PRIVATE_URL' }
  ]);
  const result = await getCatalogGrowthEvidence(id);
  expect(result).toMatchObject({ status: 'available', records: [row] });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  const [sql, parameters] = vi.mocked(query).mock.calls[0]!;
  expect(sql).toMatch(/^select /u);
  expect(sql).toContain('attempt_id=$1::uuid');
  expect(sql).toContain('command_id=$1::uuid');
  expect(sql).toContain('limit 51');
  expect(parameters).toEqual([id]);
});

it('keeps malformed or inaccessible growth evidence explicitly unknown', async () => {
  vi.mocked(query).mockResolvedValueOnce([{ ...row, target_bound: true }]);
  expect(await getCatalogGrowthEvidence(id)).toMatchObject({
    status: 'unavailable',
    invalid_record_count: 1,
    records: []
  });
  vi.mocked(query).mockRejectedValueOnce({ code: '42501' });
  expect(await getCatalogGrowthEvidence(id)).toMatchObject({
    status: 'unavailable',
    missing_sources: ['read_denied']
  });
});

it('never reconstructs historical growth choices from current settings', async () => {
  expect(await getCatalogGrowthEvidence(id, '2026-11-08T00:00:00Z')).toMatchObject({
    status: 'historical_state_unknown',
    records: []
  });
  expect(query).not.toHaveBeenCalled();
});
