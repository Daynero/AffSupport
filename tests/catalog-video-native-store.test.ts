import { expect, it, vi } from 'vitest';
import { catalogVideoNativeStore } from '../supabase/functions/drive-ops/catalog-video-native-store';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
const authority = {
  setId: id(1),
  teamId: id(2),
  actorId: id(3),
  executorId: id(4),
  epoch: 1,
  nativeInstanceId: id(5)
};
const input = () => ({
  setId: id(1),
  nativeInstanceId: id(5),
  claimHash: 'synthetic-hash',
  protocolVersion: 1 as const
});
it('revalidates installed authority before every read or checkpoint and captures original native binding', async () => {
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_authorize_catalog_video_executor'
        ? authority
        : name === 'service_read_catalog_video_set'
          ? {
              setId: id(1),
              revision: 0,
              children: [
                { index: 0, requestId: id(10), operationId: null, state: 'queued', outputId: null }
              ]
            }
          : true
  }));
  const native = input(),
    store = catalogVideoNativeStore({ rpc }, native);
  native.nativeInstanceId = id(99);
  await store.load();
  await store.save(0, { setId: id(1), revision: 1, children: [] });
  expect(rpc.mock.calls.map(c => c[0])).toEqual([
    'service_authorize_catalog_video_executor',
    'service_read_catalog_video_set',
    'service_authorize_catalog_video_executor',
    'service_checkpoint_catalog_video_set'
  ]);
  expect(rpc).toHaveBeenCalledWith(
    'service_authorize_catalog_video_executor',
    expect.objectContaining({ p_native: id(5) })
  );
});
it('blocks changed owner scope before a write instead of adopting replacement authority', async () => {
  let count = 0;
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_authorize_catalog_video_executor'
        ? { ...authority, actorId: ++count === 1 ? id(3) : id(99) }
        : {
            setId: id(1),
            revision: 0,
            children: [
              { index: 0, requestId: id(10), operationId: null, state: 'queued', outputId: null }
            ]
          }
  }));
  const store = catalogVideoNativeStore({ rpc }, input());
  await store.load();
  await expect(store.save(0, { setId: id(1), revision: 1, children: [] })).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  expect(rpc.mock.calls.map(c => c[0])).not.toContain('service_checkpoint_catalog_video_set');
});
it('does not turn a consumed dispatch fence into another local execution permission', async () => {
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_authorize_catalog_video_executor'
        ? authority
        : { operationId: id(11), requestId: id(10), executionAllowed: false }
  }));
  expect(
    await catalogVideoNativeStore({ rpc }, input()).dispatch({
      index: 0,
      requestId: id(10),
      operationId: id(11)
    })
  ).toBe(false);
});
it('asks for a variant retry on reconcile but never from a heartbeat', async () => {
  // 1.4.3: a heartbeat observes a running child; it must not requeue anything.
  const child = { index: 0, requestId: id(10), operationId: id(50) };
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_authorize_catalog_video_executor'
        ? authority
        : name === 'service_retry_catalog_video_variant'
          ? { kind: 'retry', requestId: id(20), attempt: 1 }
          : name === 'service_read_catalog_video_acceptance'
            ? {
                parentState: 'preparing',
                snapshot: { children: [{ ...child, state: 'working', outputId: null }] }
              }
            : { kind: 'unknown' }
  }));
  const store = catalogVideoNativeStore({ rpc }, input());
  await store.heartbeat(child).catch(() => undefined);
  expect(rpc.mock.calls.map(c => c[0])).not.toContain('service_retry_catalog_video_variant');
  expect(await store.reconcile(child)).toEqual({ kind: 'unknown', retry: { attempt: 1 } });
  expect(rpc.mock.calls.map(c => c[0])).toContain('service_retry_catalog_video_variant');
});
