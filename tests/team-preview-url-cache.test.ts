import type { TeamPreviewResult } from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedPreview, clearPreviewUrlCache } from '../apps/web/src/team/preview-url-cache';

const TEAM_ID = '11000000-0000-4000-8000-000000000001';
const MATERIAL_ID = '21000000-0000-4000-8000-000000000001';

function media(expiresInMs: number, rangeUrl = 'https://example.test/grant'): TeamPreviewResult {
  return {
    kind: 'media',
    rangeUrl,
    mimeType: 'video/mp4',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString()
  };
}

afterEach(() => {
  clearPreviewUrlCache();
});

/**
 * A grid of tiles re-renders constantly; each re-render used to buy another
 * signed URL (finding P2). These cover the three things that stops: a live
 * grant is reused, concurrent tiles share one request, and a grant close to
 * lapsing is replaced rather than handed out.
 */
describe('preview URL cache', () => {
  it('reuses a live grant instead of asking again', async () => {
    const fetcher = vi.fn(async () => media(10 * 60_000));
    const first = await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media');
    const second = await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('keys by material and mode, so neighbours never share a grant', async () => {
    const fetcher = vi.fn(async (_team: string, materialId: string) =>
      media(10 * 60_000, `https://example.test/${materialId}`)
    );
    await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media');
    await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'transcript');
    await cachedPreview(fetcher, TEAM_ID, '21000000-0000-4000-8000-000000000002', 'media');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('collapses concurrent callers for the same tile into one request', async () => {
    let release: (value: TeamPreviewResult) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<TeamPreviewResult>(resolve => {
          release = resolve;
        })
    );
    const pending = [
      cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media'),
      cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media'),
      cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media')
    ];
    release(media(10 * 60_000));
    const results = await Promise.all(pending);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('re-fetches a grant that is about to lapse rather than serving it', async () => {
    // Inside the safety margin: still valid on paper, too close to hand to a
    // video element that will start reading seconds from now.
    const fetcher = vi.fn(async () => media(10_000));
    await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media');
    await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not trust a result with no expiry forever', async () => {
    const fetcher = vi.fn(async (): Promise<TeamPreviewResult> => ({
      kind: 'unavailable',
      reason: 'unsupported',
      allowedActions: ['download']
    }));
    const first = await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media');
    const second = await cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('lets a failed request be retried', async () => {
    const fetcher = vi
      .fn<[], Promise<TeamPreviewResult>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(media(10 * 60_000));
    await expect(cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media')).rejects.toThrow('offline');
    await expect(cachedPreview(fetcher, TEAM_ID, MATERIAL_ID, 'media')).resolves.toMatchObject({
      kind: 'media'
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
