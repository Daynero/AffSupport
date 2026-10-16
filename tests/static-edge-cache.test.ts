import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StaticEdgeTrimCache } from '../apps/agent/src/images/static-edge-cache.js';

const source = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: source.stat }));
const identity = () => ({
  dev: 1n,
  ino: 2n,
  size: 100n,
  mtimeNs: 10n,
  ctimeNs: 11n,
  isFile: () => true
});
const trims = { startSeconds: 0.25, endSeconds: 30 };
beforeEach(() => {
  source.stat.mockReset().mockResolvedValue(identity());
});

describe('completed static edge scan cache', () => {
  it('reuses an unchanged source and never lets callers mutate cached trims', async () => {
    const scan = vi.fn(async () => ({ ...trims }));
    const cache = new StaticEdgeTrimCache(scan);
    const first = await cache.detect('/video.mp4', 60, 30);
    first.startSeconds = 99;
    expect(await cache.detect('/video.mp4', 60, 30)).toEqual(trims);
    expect(scan).toHaveBeenCalledOnce();
  });

  it.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)(
    'invalidates when %s changes',
    async field => {
      const scan = vi.fn(async () => ({ ...trims }));
      const cache = new StaticEdgeTrimCache(scan);
      await cache.detect('/video.mp4', 60, 30);
      source.stat.mockResolvedValue({ ...identity(), [field]: 999n });
      await cache.detect('/video.mp4', 60, 30);
      expect(scan).toHaveBeenCalledTimes(2);
    }
  );

  it('keys path, duration and frame rate independently', async () => {
    const scan = vi.fn(async () => ({ ...trims }));
    const cache = new StaticEdgeTrimCache(scan);
    await cache.detect('/video.mp4', 60, 30);
    await cache.detect('/other.mp4', 60, 30);
    await cache.detect('/video.mp4', 61, 30);
    await cache.detect('/video.mp4', 60, 60);
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it('does not cache a source that changes during inspection or cannot be statted', async () => {
    const scan = vi.fn(async () => ({ ...trims }));
    const cache = new StaticEdgeTrimCache(scan);
    source.stat
      .mockResolvedValueOnce(identity())
      .mockResolvedValue({ ...identity(), ctimeNs: 99n });
    await cache.detect('/video.mp4', 60, 30);
    await cache.detect('/video.mp4', 60, 30);
    expect(scan).toHaveBeenCalledTimes(2);
    source.stat.mockRejectedValue(new Error('unavailable'));
    await cache.detect('/video.mp4', 60, 30);
    await cache.detect('/video.mp4', 60, 30);
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it('does not cache failures and honors cancellation even on a cache hit', async () => {
    const scan = vi
      .fn(async () => ({ ...trims }))
      .mockRejectedValueOnce(new Error('decode failed'));
    const cache = new StaticEdgeTrimCache(scan);
    await expect(cache.detect('/video.mp4', 60, 30)).rejects.toThrow('decode failed');
    await expect(cache.detect('/video.mp4', 60, 30)).resolves.toEqual(trims);
    const abort = new AbortController();
    abort.abort();
    await expect(cache.detect('/video.mp4', 60, 30, abort.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not share an in-flight scan or its cancellation between callers', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const scan = vi.fn(async () => {
      await pending;
      return { ...trims };
    });
    const cache = new StaticEdgeTrimCache(scan);
    const abort = new AbortController();
    const cancelled = cache.detect('/video.mp4', 60, 30, abort.signal).catch(error => error);
    const independent = cache.detect('/video.mp4', 60, 30);
    await Promise.resolve();
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(2);
    abort.abort();
    release();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(await independent).toEqual(trims);
    expect(await cache.detect('/video.mp4', 60, 30)).toEqual(trims);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used completed scan', async () => {
    const scan = vi.fn(async () => ({ ...trims }));
    const cache = new StaticEdgeTrimCache(scan, 2);
    await cache.detect('/a.mp4', 60, 30);
    await cache.detect('/b.mp4', 60, 30);
    await cache.detect('/a.mp4', 60, 30);
    await cache.detect('/c.mp4', 60, 30);
    await cache.detect('/a.mp4', 60, 30);
    expect(scan).toHaveBeenCalledTimes(3);
    await cache.detect('/b.mp4', 60, 30);
    expect(scan).toHaveBeenCalledTimes(4);
  });
});
