import { expect, it, vi } from 'vitest';
import type { RestitchScreen } from '@video-compressor/shared';
import { ScreenCacheError } from '../apps/agent/src/team-bridge/screen-cache';
import {
  resolveScreensWithRecovery,
  ScreenRecoveryCandidateError,
  type ScreenRecoveryCandidate,
  type ScreenRecoveryProvider
} from '../apps/agent/src/team-bridge/screen-recovery';
const uuid = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function candidate(n: number, slot: RestitchScreen['slot'] = 'end'): ScreenRecoveryCandidate {
  return {
    versionId: uuid(n),
    acquisition: 0,
    screen: {
      slot,
      materialId: uuid(n + 100),
      checksum: 'a'.repeat(32),
      mimeType: 'image/png',
      fileName: 'screen.png',
      transfer: null,
      sizeBytes: 10
    }
  };
}
function provider(): ScreenRecoveryProvider {
  return {
    next: vi.fn(async slot => ({ kind: 'candidate' as const, candidate: candidate(1, slot) })),
    resolve: vi.fn(async value => ({
      candidate: value,
      resolved: {
        slot: value.screen.slot,
        id: 'team:' + value.versionId,
        path: '/fixture/' + value.versionId + '.png'
      }
    })),
    reject: vi.fn(async () => {}),
    accept: vi.fn(async () => {}),
    refresh: vi.fn(async value => value)
  };
}
it('replaces a proved bad image during one resolution while retaining the already valid opposite slot', async () => {
  const p = provider();
  vi.mocked(p.next).mockImplementation(async slot => ({
    kind: 'candidate',
    candidate: candidate(
      slot === 'start' ? 1 : vi.mocked(p.reject).mock.calls.length === 0 ? 2 : 3,
      slot
    )
  }));
  vi.mocked(p.resolve).mockImplementation(async value => {
    if (value.versionId === uuid(2)) throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
    return {
      candidate: value,
      resolved: {
        slot: value.screen.slot,
        id: 'team:' + value.versionId,
        path: '/fixture/' + value.versionId + '.png'
      }
    };
  });
  const result = await resolveScreensWithRecovery(
    ['start', 'end'],
    p,
    new AbortController().signal
  );
  expect(result.map(r => r.id)).toEqual(['team:' + uuid(1), 'team:' + uuid(3)]);
  expect(p.resolve).toHaveBeenCalledTimes(3);
  expect(p.reject).toHaveBeenCalledTimes(1);
  expect(p.accept).toHaveBeenCalledTimes(2);
  expect(vi.mocked(p.next).mock.calls.filter(([slot]) => slot === 'start')).toHaveLength(1);
});
it.each([
  new ScreenCacheError('DRIVE_UNAVAILABLE'),
  new ScreenCacheError('PERMISSION_DENIED'),
  new ScreenCacheError('DISK_FULL', 'cache_write_failed'),
  new ScreenCacheError('RESTITCH_SCREEN_FETCH_FAILED', 'cache_write_failed')
])('stops for a global failure without poisoning or rerolling the pool: %s', async cause => {
  const p = provider();
  vi.mocked(p.resolve).mockRejectedValue(cause);
  await expect(resolveScreensWithRecovery(['end'], p, new AbortController().signal)).rejects.toBe(
    cause
  );
  expect(p.next).toHaveBeenCalledOnce();
  expect(p.reject).not.toHaveBeenCalled();
  expect(p.accept).not.toHaveBeenCalled();
});
it('does not keep hitting a repeated last rejected version', async () => {
  const p = provider();
  vi.mocked(p.resolve).mockRejectedValue(new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED'));
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).rejects.toMatchObject({ message: 'INVALID_RESPONSE' });
  expect(p.resolve).toHaveBeenCalledOnce();
  expect(p.reject).toHaveBeenCalledOnce();
});
it.each([
  ['unusable', true, 'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED'],
  ['remembered', true, 'RESTITCH_SCREEN_PREVIOUS_FAILURES'],
  ['unusable', false, 'RESTITCH_SCREEN_SELECTION_LIMIT'],
  ['empty', true, 'RESTITCH_POOL_EMPTY']
] as const)('distinguishes pool evidence %s complete=%s', async (reason, complete, code) => {
  const p = provider();
  vi.mocked(p.next).mockResolvedValue({ kind: 'exhausted', reason, complete });
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).rejects.toMatchObject({ message: code });
  expect(p.resolve).not.toHaveBeenCalled();
});
it('refreshes an expired grant for the same version once without selecting another file', async () => {
  const p = provider();
  vi.mocked(p.resolve).mockRejectedValueOnce(new ScreenCacheError('EXPIRED'));
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).resolves.toHaveLength(1);
  expect(p.next).toHaveBeenCalledOnce();
  expect(p.refresh).toHaveBeenCalledOnce();
  expect(p.reject).not.toHaveBeenCalled();
});
it('refuses a refresh that silently substitutes another version', async () => {
  const p = provider();
  vi.mocked(p.resolve).mockRejectedValue(new ScreenCacheError('EXPIRED'));
  vi.mocked(p.refresh).mockResolvedValue(candidate(2));
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).rejects.toMatchObject({ message: 'INVALID_RESPONSE' });
  expect(p.resolve).toHaveBeenCalledOnce();
});
it('does not retry a lost acceptance reply as a screen defect or a fresh draw', async () => {
  const p = provider(),
    cause = new ScreenCacheError('EXPIRED');
  vi.mocked(p.accept).mockRejectedValue(cause);
  await expect(resolveScreensWithRecovery(['end'], p, new AbortController().signal)).rejects.toBe(
    cause
  );
  expect(p.resolve).toHaveBeenCalledOnce();
  expect(p.next).toHaveBeenCalledOnce();
  expect(p.reject).not.toHaveBeenCalled();
  expect(p.refresh).not.toHaveBeenCalled();
});
it('ends after cancellation between defect reporting and reselection', async () => {
  const p = provider(),
    controller = new AbortController();
  vi.mocked(p.resolve).mockRejectedValue(new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED'));
  vi.mocked(p.reject).mockImplementation(async () => controller.abort());
  await expect(resolveScreensWithRecovery(['end'], p, controller.signal)).rejects.toMatchObject({
    name: 'AbortError'
  });
  expect(p.next).toHaveBeenCalledOnce();
  expect(p.accept).not.toHaveBeenCalled();
});
it('reports a failure against the current acquisition after cache reacquisition', async () => {
  const p = provider(),
    first = candidate(1),
    latest = { ...first, acquisition: 1 };
  vi.mocked(p.next)
    .mockResolvedValueOnce({ kind: 'candidate', candidate: first })
    .mockResolvedValue({ kind: 'candidate', candidate: candidate(2) });
  vi.mocked(p.resolve).mockRejectedValueOnce(
    new ScreenRecoveryCandidateError(
      latest,
      new ScreenCacheError('SOURCE_CHANGED', 'source_changed')
    )
  );
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).resolves.toHaveLength(1);
  expect(vi.mocked(p.reject).mock.calls[0]![0]).toMatchObject({
    versionId: uuid(1),
    acquisition: 1
  });
});
it('never resolves more than32 candidates and can read final exhaustion without a33rd fetch', async () => {
  const p = provider();
  let n = 0;
  vi.mocked(p.next).mockImplementation(async () =>
    ++n <= 32
      ? { kind: 'candidate', candidate: candidate(n) }
      : { kind: 'exhausted', reason: 'unusable', complete: true }
  );
  vi.mocked(p.resolve).mockRejectedValue(new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED'));
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).rejects.toMatchObject({ message: 'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED' });
  expect(p.resolve).toHaveBeenCalledTimes(32);
  expect(p.next).toHaveBeenCalledTimes(33);
});

it.each([
  { kind: 'exhausted', reason: 'unusable', complete: 'yes' },
  { kind: 'exhausted', reason: 'unknown', complete: true },
  { kind: 'exhausted', reason: 'empty' },
  { kind: 'candidate', candidate: { ...candidate(1), acquisition: 3 } }
])('refuses malformed pool evidence before resolving an image: %j', async reply => {
  const p = provider();
  vi.mocked(p.next).mockResolvedValue(reply as never);
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(p.resolve).not.toHaveBeenCalled();
});
it('keeps a global access refusal out of image history even with a contradictory defect hint', async () => {
  const p = provider(),
    cause = new ScreenCacheError('PERMISSION_DENIED', 'source_missing');
  vi.mocked(p.resolve).mockRejectedValue(cause);
  await expect(resolveScreensWithRecovery(['end'], p, new AbortController().signal)).rejects.toBe(
    cause
  );
  expect(p.reject).not.toHaveBeenCalled();
  expect(p.next).toHaveBeenCalledOnce();
});
it('never fetches a thirty-third candidate and does not claim the complete pool is unusable', async () => {
  const p = provider();
  let n = 0;
  vi.mocked(p.next).mockImplementation(async () => ({
    kind: 'candidate',
    candidate: candidate(++n)
  }));
  vi.mocked(p.resolve).mockRejectedValue(new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED'));
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_SELECTION_LIMIT' });
  expect(p.resolve).toHaveBeenCalledTimes(32);
});
it('does not let a diagnostic observer failure interrupt a valid preparation', async () => {
  const p = provider();
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal, () => {
      throw new Error('observer');
    })
  ).resolves.toHaveLength(1);
  expect(p.accept).toHaveBeenCalledOnce();
});

it('treats case variants of one opaque UUID as the same rejected version', async () => {
  const p = provider();
  const first = { ...candidate(1), versionId: 'abcdef12-0000-4000-8000-000000000001' };
  vi.mocked(p.next)
    .mockResolvedValueOnce({ kind: 'candidate', candidate: first })
    .mockResolvedValue({
      kind: 'candidate',
      candidate: { ...first, versionId: first.versionId.toUpperCase() }
    });
  vi.mocked(p.resolve).mockRejectedValue(new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED'));
  await expect(
    resolveScreensWithRecovery(['end'], p, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(p.resolve).toHaveBeenCalledOnce();
});
