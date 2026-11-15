import { describe, expect, it, vi } from 'vitest';
import { searchWithLayoutFallback } from '../apps/web/src/lib/layoutFallback';

describe('a server search on the other keyboard layout', () => {
  it('asks again for the same keys on the other layout only when nothing was found', async () => {
    const ask = vi.fn(async (query: string) => ({ items: query === 'my' ? ['MY_1.mp4'] : [] }));
    await expect(searchWithLayoutFallback('ьн', ask)).resolves.toEqual({ items: ['MY_1.mp4'] });
    expect(ask.mock.calls.map(call => call[0])).toEqual(['ьн', 'my']);
  });

  it('keeps what the words as typed found and does not ask twice', async () => {
    const ask = vi.fn(async () => ({ items: ['found'] }));
    await searchWithLayoutFallback('ghjrfgc', ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('keeps the empty answer when the other layout finds nothing or fails', async () => {
    const empty = vi.fn(async () => ({ items: [] as string[] }));
    await expect(searchWithLayoutFallback('ghjrfgc', empty)).resolves.toEqual({ items: [] });
    const failing = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error('TEAM_TRANSPORT_UNAVAILABLE'));
    await expect(searchWithLayoutFallback('ghjrfgc', failing)).resolves.toEqual({ items: [] });
  });

  it('does not guess from a single letter or from digits', async () => {
    const ask = vi.fn(async () => ({ items: [] as string[] }));
    await searchWithLayoutFallback('g', ask);
    await searchWithLayoutFallback('602', ask);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
