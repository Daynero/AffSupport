// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamPreviewResult, ThumbnailSession } from '@video-compressor/shared';
import { cachedPreview, clearPreviewUrlCache } from '../apps/web/src/team/preview-url-cache';
import {
  clearThumbnailSessions,
  getThumbnailSession
} from '../apps/web/src/team/explorer/useThumbnailSession';
import {
  resetMaterialNotes,
  saveMaterialNote,
  useMaterialNote
} from '../apps/web/src/team/materials/materialNotes';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { deferred } from './fixtures/catalog-sync';
afterEach(() => {
  cleanup();
  clearPreviewUrlCache();
  clearThumbnailSessions();
  resetMaterialNotes();
  vi.useRealTimers();
});
const media = {
  kind: 'media',
  rangeUrl: 'https://example.invalid/private',
  mimeType: 'video/mp4',
  expiresAt: '2099-01-01T00:00:00Z'
} as TeamPreviewResult;
const thumbnail = {
  token: 'synthetic',
  endpoint: 'https://example.invalid',
  expiresAt: '2099-01-01T00:00:00Z'
} as ThumbnailSession;
it('isolates preview providers and rejects a late old actor fill', async () => {
  setPrivateCacheScope('a', 'view');
  const old = deferred<TeamPreviewResult>();
  const first = vi.fn(() => old.promise);
  const pending = cachedPreview(first, 'team', 'file', 'media');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  setPrivateCacheScope('b', 'view');
  old.resolve(media);
  await rejected;
  const next = vi.fn(async () => media);
  await cachedPreview(next, 'team', 'file', 'media');
  await cachedPreview(next, 'team', 'file', 'media');
  expect(next).toHaveBeenCalledTimes(1);
  const other = vi.fn(async () => media);
  await cachedPreview(other, 'team', 'file', 'media');
  expect(other).toHaveBeenCalledTimes(1);
});
it('coalesces pending thumbnail mints and prevents old scope fills', async () => {
  setPrivateCacheScope('a', 'view');
  const old = deferred<ThumbnailSession>();
  const client = { mintThumbnailSession: vi.fn(() => old.promise), thumbnailUrl: () => '' };
  const first = getThumbnailSession(client, 'team');
  expect(getThumbnailSession(client, 'team')).toBe(first);
  await Promise.resolve();
  await Promise.resolve();
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  setPrivateCacheScope('a', 'revoked');
  old.resolve(thumbnail);
  await rejected;
  client.mintThumbnailSession.mockResolvedValue(thumbnail);
  await getThumbnailSession(client, 'team');
  expect(client.mintThumbnailSession).toHaveBeenCalledTimes(2);
});
it('notes share current saves, fence stale reads and hide old actor content', async () => {
  setPrivateCacheScope('a', 'view');
  const old = deferred<string | null>();
  const client = {
    getMaterialNote: vi.fn(() => old.promise),
    setMaterialNote: vi.fn(async () => 'new note')
  };
  const view = renderHook(() => useMaterialNote('team', 'file', { client }));
  await act(async () => {});
  await act(async () => {
    await saveMaterialNote('team', 'file', 'new note', client);
  });
  await act(async () => old.resolve('obsolete note'));
  expect(view.result.current).toEqual({ state: 'ready', note: 'new note' });
  const next = deferred<string | null>();
  client.getMaterialNote.mockReturnValue(next.promise);
  await act(async () => setPrivateCacheScope('b', 'view'));
  expect(view.result.current).toEqual({ state: 'loading' });
  await act(async () => next.resolve('actor b'));
  expect(view.result.current).toEqual({ state: 'ready', note: 'actor b' });
});

it('bounds thumbnail scopes to twenty and coalesces wrappers with a stable provider identity', async () => {
  setPrivateCacheScope('bounded', 'view');
  const mint = vi.fn(async () => thumbnail);
  const provider = {};
  const wrapper = () => ({ mintThumbnailSession: mint, thumbnailUrl: () => '' });
  const first = getThumbnailSession(wrapper(), 'team-0', provider);
  expect(getThumbnailSession(wrapper(), 'team-0', provider)).toBe(first);
  await first;
  for (let index = 1; index <= 20; index++)
    await getThumbnailSession(wrapper(), `team-${index}`, provider);
  expect(mint).toHaveBeenCalledTimes(21);
  await getThumbnailSession(wrapper(), 'team-0', provider);
  expect(mint).toHaveBeenCalledTimes(22);
});

it('rejects a late note save from a retired actor without filling the new actor cache', async () => {
  setPrivateCacheScope('old-save', 'view');
  const old = deferred<string | null>();
  const client = {
    getMaterialNote: vi.fn(async () => 'current'),
    setMaterialNote: vi.fn(() => old.promise)
  };
  const saving = saveMaterialNote('team', 'file', 'old private note', client);
  const rejected = expect(saving).rejects.toMatchObject({ name: 'AbortError' });
  setPrivateCacheScope('new-save', 'view');
  old.resolve('old private note');
  await rejected;
  const view = renderHook(() => useMaterialNote('team', 'file', { client }));
  await act(async () => {});
  expect(view.result.current).toEqual({ state: 'ready', note: 'current' });
});

it('releases a stalled preview owner at the deadline so the same tile can retry', async () => {
  vi.useFakeTimers();
  setPrivateCacheScope('preview-timeout', 'view');
  const stalled = deferred<TeamPreviewResult>();
  const fetcher = vi.fn().mockReturnValueOnce(stalled.promise).mockResolvedValue(media);
  const first = cachedPreview(fetcher, 'team', 'file', 'media');
  const failed = expect(first).rejects.toMatchObject({ code: 'WORKSPACE_READ_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  expect(await cachedPreview(fetcher, 'team', 'file', 'media')).toBe(media);
  stalled.resolve({ ...media, rangeUrl: 'https://example.invalid/obsolete' } as TeamPreviewResult);
  await Promise.resolve();
  expect(await cachedPreview(fetcher, 'team', 'file', 'media')).toBe(media);
  vi.useRealTimers();
});

it('cancels a retired thumbnail deadline even when the authenticated actor remains the same', async () => {
  vi.useFakeTimers();
  setPrivateCacheScope('same-actor', 'view');
  const stalled = deferred<ThumbnailSession>();
  const client = { mintThumbnailSession: vi.fn(() => stalled.promise), thumbnailUrl: () => '' };
  const first = getThumbnailSession(client, 'team');
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  await Promise.resolve();
  expect(client.mintThumbnailSession).toHaveBeenCalledTimes(1);
  setPrivateCacheScope('same-actor', 'revoked');
  await cancelled;
  // Clearing must cancel the timer itself, not just hide its eventual result.
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(15_000);
  stalled.resolve(thumbnail);
  vi.useRealTimers();
});

it('a revision read arriving during a note save cannot leave the confirmed save stale', async () => {
  setPrivateCacheScope('note-write-order', 'view');
  let stored = 'before';
  const commit = deferred<string | null>();
  const client = {
    getMaterialNote: vi.fn(async () => stored),
    setMaterialNote: vi.fn(async () => {
      const saved = await commit.promise;
      stored = saved!;
      return saved;
    })
  };
  const hook = renderHook(({ revision }) => useMaterialNote('team', 'file', { client, revision }), {
    initialProps: { revision: 0 }
  });
  await act(async () => {});
  let saving!: Promise<string | null>;
  act(() => {
    saving = saveMaterialNote('team', 'file', 'confirmed', client);
  });
  hook.rerender({ revision: 1 });
  await act(async () => {});
  await act(async () => {
    commit.resolve('confirmed');
    await saving;
  });
  expect(hook.result.current).toEqual({ state: 'ready', note: 'confirmed' });
});

it('serializes saves of one note so late older commits cannot roll back the latest confirmed value', async () => {
  setPrivateCacheScope('note-concurrent-writes', 'view');
  let stored = 'before';
  const older = deferred<void>(),
    newer = deferred<void>();
  const client = {
    getMaterialNote: vi.fn(async () => stored),
    setMaterialNote: vi.fn(async (_team: string, _file: string, note: string) => {
      await (note === 'older' ? older.promise : newer.promise);
      stored = note;
      return stored;
    })
  };
  const hook = renderHook(() => useMaterialNote('team', 'file', { client }));
  await act(async () => {});
  let first!: Promise<string | null>, second!: Promise<string | null>;
  await act(async () => {
    first = saveMaterialNote('team', 'file', 'older', client);
    second = saveMaterialNote('team', 'file', 'newer', client);
  });
  expect(client.setMaterialNote).toHaveBeenCalledTimes(1);
  // The newer transport would finish first without per-note ordering.
  newer.resolve();
  await act(async () => {
    older.resolve();
    await Promise.all([first, second]);
  });
  expect(stored).toBe('newer');
  expect(hook.result.current).toEqual({ state: 'ready', note: 'newer' });
});

it('continues a note write lane after failure and does not serialize unrelated notes', async () => {
  setPrivateCacheScope('note-lane-failure', 'view');
  const failed = deferred<string | null>();
  const client = {
    getMaterialNote: vi.fn(async () => null),
    setMaterialNote: vi.fn((_team: string, _file: string, note: string) =>
      note === 'first' ? failed.promise : Promise.resolve(note)
    )
  };
  const first = saveMaterialNote('team', 'file', 'first', client);
  const firstRejected = expect(first).rejects.toThrow('first-write-failed');
  const second = saveMaterialNote('team', 'file', 'second', client);
  const unrelated = saveMaterialNote('team', 'other-file', 'independent', client);
  expect(await unrelated).toBe('independent');
  expect(client.setMaterialNote).toHaveBeenCalledTimes(2);
  failed.reject(new Error('first-write-failed'));
  await firstRejected;
  expect(await second).toBe('second');
  expect(client.setMaterialNote).toHaveBeenCalledTimes(3);
});
