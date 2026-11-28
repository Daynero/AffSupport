// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 057 T050 — media of an R2 space in the web (T051, FR-036, FR-039): a picture keeps the first
 * address built for it, so the browser's cache answers it across grants (and reloads); an
 * address refused once is rebuilt from the current grant exactly once; the original's address
 * is content-addressed and a video gets it for Range; a download of any size is the browser's
 * own (no 32 MiB limit, no AGENT_REQUIRED) unless it has to be cleaned; a change of account
 * forgets the addresses and clears the files host's cache. The Worker's `immutable` answer and
 * its grant-free cache key are proven in space-read-worker.test.ts.
 */

vi.mock('../apps/web/src/lib/supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/supabase')>()),
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => {
    throw new Error('no transport in this test');
  }
}));

import {
  clearSpaceStorageCaches,
  rememberSpaceBackend,
  rememberSpaceMaterials,
  spaceStorageApi
} from '../apps/web/src/api/space-storage';
import { teamApi } from '../apps/web/src/api/team';
import { downloadMaterial } from '../apps/web/src/team/materials/download-material';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import {
  clearSpaceMediaUrls,
  forgetSpaceMediaUrl,
  stableSpaceMediaUrl
} from '../apps/web/src/team/storage/spaceMediaUrls';

const id = (n: number) => `05750000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEAM = id(1);
const MATERIAL = id(2);
const ACTOR = id(3);
const CONTENT = 'c'.repeat(64);
const FILES = 'https://files.soty.pp.ua';
const MIB = 1024 * 1024;
const grant = (n: number) => ({
  grant: `grant_${String(n).padStart(16, '0')}`,
  expiresAt: '2099-01-01T00:00:00.000Z',
  filesOrigin: FILES
});

beforeEach(() => {
  clearSpaceStorageCaches();
  clearSpaceMediaUrls(ACTOR);
  window.localStorage.clear();
  setPrivateCacheScope(ACTOR, `access-${Math.random()}`);
  rememberSpaceBackend(TEAM, 'r2');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a picture keeps its address', () => {
  it('the same URL under every later grant, content-addressed, the grant only in the query', () => {
    const first = stableSpaceMediaUrl({
      teamId: TEAM,
      contentId: CONTENT,
      variant: 'tile',
      filesOrigin: FILES,
      grant: grant(1).grant
    });
    const later = stableSpaceMediaUrl({
      teamId: TEAM,
      contentId: CONTENT,
      variant: 'tile',
      filesOrigin: FILES,
      grant: grant(2).grant
    });
    expect(later).toBe(first);
    const url = new URL(first);
    expect(url.pathname).toBe(`/t/${TEAM}/d/${CONTENT}/1/tile`);
    expect([...url.searchParams.keys()]).toEqual(['g']);
    // The original has its own content address too.
    const original = new URL(
      stableSpaceMediaUrl({
        teamId: TEAM,
        contentId: CONTENT,
        variant: null,
        filesOrigin: FILES,
        grant: grant(2).grant
      })
    );
    expect(original.pathname).toBe(`/t/${TEAM}/o/${CONTENT}`);
  });

  it('after a refusal it is rebuilt from the current grant — exactly once', () => {
    stableSpaceMediaUrl({
      teamId: TEAM,
      contentId: CONTENT,
      variant: 'tile',
      filesOrigin: FILES,
      grant: grant(1).grant
    });
    expect(forgetSpaceMediaUrl(TEAM, CONTENT, 'tile')).toBe(true);
    const rebuilt = stableSpaceMediaUrl({
      teamId: TEAM,
      contentId: CONTENT,
      variant: 'tile',
      filesOrigin: FILES,
      grant: grant(2).grant
    });
    expect(new URL(rebuilt).searchParams.get('g')).toBe(grant(2).grant);
    expect(forgetSpaceMediaUrl(TEAM, CONTENT, 'tile')).toBe(true);
    // The rebuilt one refused too: nothing left to forget, the tile shows its mark.
    expect(forgetSpaceMediaUrl(TEAM, CONTENT, 'tile')).toBe(false);
  });

  it('survives a reload, and the explorer reads it through the thumbnail session', () => {
    vi.useFakeTimers();
    rememberSpaceMaterials(TEAM, [{ id: MATERIAL, contentId: CONTENT, thumbnailReady: true }]);
    const session = {
      token: grant(1).grant,
      expiresAt: grant(1).expiresAt,
      teamId: TEAM,
      endpoint: FILES
    };
    const url = teamApi.thumbnailUrl(session, MATERIAL);
    vi.runAllTimers();
    expect(window.localStorage.getItem(`soty-space-media-urls/1:${ACTOR}`)).toContain(String(url));
    expect(teamApi.thumbnailUrl({ ...session, token: grant(5).grant }, MATERIAL)).toBe(url);
  });

  it('another account forgets them and clears the files host cache', () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const first = stableSpaceMediaUrl({
      teamId: TEAM,
      contentId: CONTENT,
      variant: 'tile',
      filesOrigin: FILES,
      grant: grant(1).grant
    });
    setPrivateCacheScope(id(9), 'other');
    expect(fetch).toHaveBeenCalledWith(
      `${FILES}/clear-site-data`,
      expect.objectContaining({ credentials: 'omit' })
    );
    setPrivateCacheScope(ACTOR, 'back');
    expect(
      stableSpaceMediaUrl({
        teamId: TEAM,
        contentId: CONTENT,
        variant: 'tile',
        filesOrigin: FILES,
        grant: grant(2).grant
      })
    ).not.toBe(first);
  });
});

describe('the original', () => {
  it('a video plays from its files host address, by Range; a repeat takes a fresh grant', async () => {
    rememberSpaceMaterials(TEAM, [
      { id: MATERIAL, contentId: CONTENT, mimeType: 'video/mp4', name: 'Clip.mp4' }
    ]);
    const readGrant = vi
      .spyOn(spaceStorageApi, 'readGrant')
      .mockImplementation(async (_team, options) => grant(options?.refresh ? 2 : 1));
    const first = await teamApi.previewMaterial(TEAM, MATERIAL, 'media');
    expect(first).toMatchObject({ kind: 'media', mimeType: 'video/mp4' });
    expect(first.kind === 'media' && new URL(first.rangeUrl).pathname).toBe(
      `/t/${TEAM}/o/${CONTENT}`
    );
    const again = await teamApi.previewMaterial(TEAM, MATERIAL, 'media', { fresh: true });
    expect(again.kind === 'media' && new URL(again.rangeUrl).searchParams.get('g')).toBe(
      grant(2).grant
    );
    expect(readGrant.mock.calls.map(call => call[1])).toEqual([{}, { refresh: true }]);
  });

  it('any size downloads in the browser itself, no relay and no agent', async () => {
    rememberSpaceMaterials(TEAM, [
      { id: MATERIAL, contentId: CONTENT, name: 'Clip.mp4', sizeBytes: String(4096 * MIB) }
    ]);
    vi.spyOn(spaceStorageApi, 'readGrant').mockResolvedValue(grant(1));
    const fetch = vi.spyOn(globalThis, 'fetch');
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const agent = vi.fn();
    const delivery = await downloadMaterial({
      teamId: TEAM,
      materialId: MATERIAL,
      fileName: 'Clip.mp4',
      metadata: 'original',
      requestDownload: (team, material, consumer) =>
        teamApi.requestDownload(team, material, consumer),
      downloadWithAgent: agent
    });
    expect(delivery).toBe('browser_handoff');
    expect(fetch).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(new URL(anchor.href).pathname).toBe(`/t/${TEAM}/o/${CONTENT}`);
    expect(new URL(anchor.href).searchParams.get('dl')).toBe('Clip.mp4');
  });

  it('a clean copy of a large video is Soty’s to make; a small one the browser cleans itself', async () => {
    vi.spyOn(spaceStorageApi, 'readGrant').mockResolvedValue(grant(1));
    const agent = vi.fn(async () => undefined);
    vi.spyOn(spaceStorageApi, 'agentDownloadGrant').mockResolvedValue({
      fileName: 'Clip.mp4',
      grant: {
        ticket: 't'.repeat(43),
        purpose: 'download_range',
        expiresAt: '2099-01-01T00:00:00Z',
        maxRangeBytes: MIB,
        maxUses: 4
      } as never
    });
    rememberSpaceMaterials(TEAM, [
      { id: MATERIAL, contentId: CONTENT, name: 'Clip.mp4', sizeBytes: String(512 * MIB) }
    ]);
    const input = {
      teamId: TEAM,
      materialId: MATERIAL,
      fileName: 'Clip.mp4',
      metadata: 'clean' as const,
      requestDownload: (team: string, material: string, consumer: 'browser' | 'agent') =>
        teamApi.requestDownload(team, material, consumer),
      downloadWithAgent: agent
    };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // 512 MiB is not fetched into the page to be cleaned: it goes the agent's way.
    await downloadMaterial(input).catch(() => undefined);
    expect(fetch).not.toHaveBeenCalled();
    rememberSpaceMaterials(TEAM, [{ id: MATERIAL, sizeBytes: String(8 * MIB) }]);
    await downloadMaterial(input).catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
