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
