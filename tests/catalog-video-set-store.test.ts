import { expect, it, vi } from 'vitest';
import { catalogVideoSetStore } from '../supabase/functions/drive-ops/catalog-video-set-store';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
const identity = () => ({
  setId: id(1),
  teamId: id(2),
  actorId: id(3),
  executorId: id(4),
  epoch: 1
});
it('captures original authority identities before asynchronous caller mutation', async () => {
  const scope = identity();
  const rpc = vi.fn(async () => ({
    data: {
      setId: id(1),
      revision: 0,
      children: [
        { index: 0, requestId: id(10), operationId: null, state: 'queued', outputId: null }
      ]
    },
    error: null
  }));
  const store = catalogVideoSetStore({ rpc }, scope);
  scope.actorId = id(99);
  await store.load();
  expect(rpc.mock.calls[0]).toEqual([
    'service_read_catalog_video_set',
    { p_set: id(1), p_team: id(2), p_actor: id(3), p_executor: id(4), p_epoch: 1 }
  ]);
});
it('keeps uncertain original process evidence unknown instead of permitting a new child', async () => {
  const rpc = vi.fn(async () => ({ data: { kind: 'unknown' }, error: null }));
  expect(await catalogVideoSetStore({ rpc }, identity()).reconcile(0, id(10))).toEqual({
    kind: 'unknown'
  });
  expect(rpc).toHaveBeenCalledWith(
    'service_reconcile_catalog_video_variant',
    expect.objectContaining({ p_index: 0, p_request: id(10) })
  );
});
it('does not expose a private provider error or fabricate a successful checkpoint', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'PRIVATE_PROVIDER_BODY' } }));
  await expect(catalogVideoSetStore({ rpc }, identity()).checkpoint(0, [])).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
});
