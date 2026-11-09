import { expect, it, vi } from 'vitest';
import { createNativeScreenRecoveryProvider } from '../apps/agent/src/team-bridge/native-screen-recovery-provider';
import { resolveScreensWithRecovery } from '../apps/agent/src/team-bridge/screen-recovery';
import { ScreenCacheError } from '../apps/agent/src/team-bridge/screen-cache';
const id = (n: number) => 'b1820000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = {
  rootOperationId: id(1),
  teamId: id(2),
  actorId: id(3),
  poolNamespaceId: id(4),
  executorId: id(5),
  epoch: 1,
  nativeInstanceId: id(6)
};
function selected(n: number) {
  const binding = {
    ...scope,
    selectionProtocol: 1 as const,
    slot: 'end' as const,
    versionId: id(n),
    acquisition: 0,
    materialId: id(n + 100),
    checksum: 'a'.repeat(32),
    mimeType: 'image/png' as const,
    sizeBytes: 4
  };
  return {
    kind: 'candidate',
    binding,
    candidate: {
      versionId: binding.versionId,
      acquisition: 0,
      screen: {
        slot: 'end',
        materialId: binding.materialId,
        checksum: binding.checksum,
        mimeType: binding.mimeType,
        sizeBytes: 4,
        fileName: 'screen.png',
        transfer: null
      }
    }
  };
}
it('connects same-click replacement to private selection calls and keeps known-bad versions excluded', async () => {
  const first = selected(10),
    second = selected(11);
  let draws = 0;
  const call = vi
    .fn<(action: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>>()
    .mockImplementation(async (action: string) =>
      action === 'next'
        ? ++draws === 1
          ? first
          : second
        : action === 'authorize'
          ? draws === 1
            ? first.binding
            : second.binding
          : true
    );
  const cache = {
    refusedProtected: vi.fn(async () => [{ slot: 'end' as const, versionId: id(99) }]),
    resolveProtected: vi.fn(
      async (binding: typeof first.binding, loader: { authorize: () => Promise<unknown> }) => {
        await loader.authorize();
        if (binding.versionId === first.binding.versionId)
          throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
        return { slot: 'end' as const, id: 'team:healthy', path: '/synthetic/healthy.png' };
      }
    )
  };
  const provider = createNativeScreenRecoveryProvider({
    scope,
    call,
    cache: cache as never,
    download: vi.fn(),
    refresh: vi.fn()
  });
  expect(await resolveScreensWithRecovery(['end'], provider, new AbortController().signal)).toEqual(
    [{ slot: 'end', id: 'team:healthy', path: '/synthetic/healthy.png' }]
  );
  expect(call.mock.calls.map(c => c[0])).toEqual([
    'next',
    'authorize',
    'reject',
    'next',
    'authorize',
    'accept'
  ]);
  expect(call.mock.calls[0]![1]).toMatchObject({ slot: 'end', excludeVersions: [id(99)] });
  expect(call.mock.calls[2]![1]).toMatchObject({
    versionId: first.binding.versionId,
    defect: 'unsupported'
  });
});
it('refuses a substituted root before using the cache or accepting an image', async () => {
  const value = selected(10);
  value.binding.rootOperationId = id(77);
  const cache = { refusedProtected: vi.fn(async () => []), resolveProtected: vi.fn() };
  const call = vi.fn(async () => value),
    provider = createNativeScreenRecoveryProvider({
      scope,
      call,
      cache: cache as never,
      download: vi.fn(),
      refresh: vi.fn()
    });
  await expect(provider.next('end', new AbortController().signal)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
  expect(cache.resolveProtected).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(1);
});
it('keeps an uncertain rejection as a failure instead of drawing again', async () => {
  const value = selected(10),
    call = vi.fn(async (action: string) => {
      if (action === 'reject') throw new ScreenCacheError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
      return action === 'authorize' ? value.binding : value;
    });
  const cache = {
    refusedProtected: vi.fn(async () => []),
    resolveProtected: vi.fn(async () => {
      throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
    })
  };
  const provider = createNativeScreenRecoveryProvider({
    scope,
    call,
    cache: cache as never,
    download: vi.fn(),
    refresh: vi.fn()
  });
  await expect(
    resolveScreensWithRecovery(['end'], provider, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(call.mock.calls.filter(c => c[0] === 'next')).toHaveLength(1);
});
