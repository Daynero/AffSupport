import { expect, it, vi } from 'vitest';
import { readCatalogVideoFailure } from '../supabase/functions/drive-ops/catalog-video-failure';
import { safeLaunchAnalyticsCode } from '../packages/shared/src/team/launches/lifecycle';
const scope = { teamId: 'team', actorId: 'actor', sourceMaterialId: 'source', setId: 'set' },
  child = { state: 'unknown', operationId: 'op', requestId: 'request' };
const service = {
  rpc: vi.fn(async () => ({ data: { snapshot: { setId: 'set', children: [child] } }, error: null }))
};
const original = {
  id: 'op',
  team_id: 'team',
  actor_id: 'actor',
  source_material_id: 'source',
  kind: 'process',
  state: 'failed',
  idempotency_key: 'catalog-variant:request',
  error_code: 'STITCH_PLAN_VIDEO_CODEC'
};
it('preserves the actual closed original child codec failure in Launch readback', async () => {
  expect(await readCatalogVideoFailure(service, scope, async () => [original])).toBe(
    'STITCH_PLAN_VIDEO_CODEC'
  );
  expect(safeLaunchAnalyticsCode('STITCH_PLAN_VIDEO_CODEC')).toBe('STITCH_PLAN_VIDEO_CODEC');
});
it.each([
  { actor_id: 'other' },
  { source_material_id: 'other' },
  { idempotency_key: 'catalog-variant:other' },
  { state: 'running' },
  { error_code: 'private user content' }
])('does not attribute foreign or unclassified output %j', async patch => {
  expect(
    await readCatalogVideoFailure(service, scope, async () => [{ ...original, ...patch }])
  ).toBeNull();
});
