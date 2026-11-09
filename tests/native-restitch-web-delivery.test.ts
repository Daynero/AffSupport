import { expect, it, vi } from 'vitest';
vi.mock('../apps/web/src/api/client', () => ({
  request: vi.fn(),
  requestBody: vi.fn(),
  cancelTeamDownload: vi.fn()
}));
vi.mock('../apps/web/src/api/team', () => ({
  invokeTeamFunction: vi.fn(),
  teamApi: { cancelOperation: vi.fn() }
}));
vi.mock('../apps/web/src/lib/config', () => ({ builtForEnvironment: () => 'beta' }));
vi.mock('../apps/web/src/team/private-cache-scope', () => ({ privateCacheActor: () => id(1) }));
import { runNativeManualRestitch } from '../apps/web/src/team/restitch/native-delivery';
const id = (n: number) => 'b1880000-0000-4000-8000-' + String(n).padStart(12, '0');
const input = {
  teamId: id(2),
  sourceMaterialId: id(3),
  operationId: id(4),
  transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
  transferGrant: {
    ticket: 'd'.repeat(43),
    purpose: 'download_range' as const,
    expiresAt: '2030-01-01T00:00:00Z',
    maxRangeBytes: 2097152,
    maxUses: 1
  },
  fileName: 'private-source.mp4',
  destination: '/private/local/folder'
};
function setup() {
  const calls: string[] = [];
  const edge = vi.fn(async (path: string) => {
    calls.push(path);
    return path.endsWith('/accept')
      ? {
          operationId: id(5),
          teamId: id(2),
          actorId: id(1),
          sourceMaterialId: id(3),
          operationState: 'running'
        }
      : {
          grantId: id(6),
          enrollmentId: id(6),
          rootOperationId: id(5),
          teamId: id(2),
          actorId: id(1),
          nativeInstanceId: id(7),
          redeemed: false
        };
  });
  const local = vi.fn(async (path: string) => {
    calls.push(path);
    return path.endsWith('/prepare')
      ? {
          rootOperationId: id(5),
          teamId: id(2),
          actorId: id(1),
          nativeInstanceId: id(7),
          enrollmentId: id(6),
          proofDigest: 'a'.repeat(64)
        }
      : path.endsWith('/redeem')
        ? { ready: true }
        : { saved: true, fileName: 'result.mp4', sizeBytes: 4, destination: input.destination };
  });
  const cancel = vi.fn(async () => {});
  const cancelLocal = vi.fn(async () => {});
  return { calls, edge, local, cancel, cancelLocal };
}
it('keeps local paths and the source grant out of cloud enrollment and hands off only after native redemption', async () => {
  const f = setup();
  expect(await runNativeManualRestitch(input, { ...f, currentActor: () => id(1) })).toMatchObject({
    saved: true,
    fileName: 'result.mp4'
  });
  expect(f.calls).toEqual([
    'drive-ops/restitch/manual/accept',
    '/api/team/restitch/native/prepare',
    'drive-ops/restitch/control/enroll',
    '/api/team/restitch/native/redeem',
    '/api/team/restitch/native/download'
  ]);
  expect(JSON.stringify(f.edge.mock.calls)).not.toMatch(
    /private-source|private\/local|transferGrant|ticket/u
  );
  expect(f.cancel).not.toHaveBeenCalled();
});
it('stops an actor replacement before handing the old root to the local controller', async () => {
  const f = setup();
  let reads = 0;
  await expect(
    runNativeManualRestitch(input, { ...f, currentActor: () => (++reads === 1 ? id(1) : id(99)) })
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(f.local).not.toHaveBeenCalled();
  expect(f.cancel).toHaveBeenCalledTimes(1);
});
it('does not cancel or repeat a handed-off native operation whose reply is unknown', async () => {
  const f = setup();
  const original = f.local.getMockImplementation()!;
  f.local.mockImplementation(async path => {
    if (path.endsWith('/download')) throw Error('CONNECTION_FAILED');
    return original(path);
  });
  await expect(runNativeManualRestitch(input, { ...f, currentActor: () => id(1) })).rejects.toThrow(
    'CONNECTION_FAILED'
  );
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.local.mock.calls.filter(c => c[0].endsWith('/download'))).toHaveLength(1);
});

it('cancels an accepted root before local preparation when the user stops during admission', async () => {
  const f = setup(),
    controller = new AbortController(),
    original = f.edge.getMockImplementation()!;
  f.edge.mockImplementation(async path => {
    const root = await original(path);
    controller.abort();
    return root;
  });
  await expect(
    runNativeManualRestitch(
      { ...input, signal: controller.signal },
      { ...f, currentActor: () => id(1) }
    )
  ).rejects.toThrow('PROCESS_CANCELED');
  expect(f.local).not.toHaveBeenCalled();
  expect(f.cancel).toHaveBeenCalledWith(input.teamId, id(5));
});
it('joins cancellation with both the original cloud root and native operation during handoff', async () => {
  const f = setup(),
    controller = new AbortController(),
    original = f.local.getMockImplementation()!;
  f.local.mockImplementation(async path => {
    if (path.endsWith('/download')) {
      controller.abort();
      throw Error('PROCESS_CANCELED');
    }
    return original(path);
  });
  await expect(
    runNativeManualRestitch(
      { ...input, signal: controller.signal },
      { ...f, currentActor: () => id(1) }
    )
  ).rejects.toThrow('PROCESS_CANCELED');
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.cancelLocal).toHaveBeenCalledWith(input.operationId);
});

it('preserves the original admission failure when the exact read has no accepted root', async () => {
  const { invokeTeamFunction } = await import('../apps/web/src/api/team');
  const original = Error('CONNECTION_FAILED');
  vi.mocked(invokeTeamFunction).mockImplementation(async (path, _body, guard) => {
    if (path.endsWith('/accept')) throw original;
    if (!guard(null)) throw Error('INVALID_RESPONSE');
    return null as never;
  });
  try {
    await expect(runNativeManualRestitch(input)).rejects.toBe(original);
    expect(vi.mocked(invokeTeamFunction).mock.calls.map(c => c[0])).toEqual([
      'drive-ops/restitch/manual/accept',
      'drive-ops/restitch/manual/read'
    ]);
  } finally {
    vi.mocked(invokeTeamFunction).mockReset();
  }
});
