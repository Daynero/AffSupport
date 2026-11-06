// Defaults are server data: malformed values must remain unknown, never guessed booleans.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
beforeEach(() => setPrivateCacheScope('47000000-0000-4000-8000-000000000001', 'owner'));
const pairs = [
  ['getCatalogUpdaterRefreshImages', 'setCatalogUpdaterRefreshImages'],
  ['getCatalogUpdaterRefreshTexts', 'setCatalogUpdaterRefreshTexts'],
  ['getCatalogUpdaterRandomLinkVariation', 'setCatalogUpdaterRandomLinkVariation'],
  ['getCatalogUpdaterGrow', 'setCatalogUpdaterGrow']
] as const;
afterEach(() => rpc.mockReset());
for (const [get, set] of pairs) {
  describe(get + ' / ' + set + ' wire contract', () => {
    it.each([null, undefined, 0, 'false', {}, []])(
      'does not turn malformed server value %j into a setting',
      async data => {
        rpc.mockResolvedValue({ data, error: null });
        await expect(teamApi[get]('team')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        await expect(teamApi[set]('team', true)).rejects.toMatchObject({
          code: 'INVALID_RESPONSE'
        });
      }
    );
    it.each([false, true])('retains the actual boolean result %s, including false', async data => {
      rpc.mockResolvedValue({ data, error: null });
      expect(await teamApi[get]('team')).toBe(data);
      expect(await teamApi[set]('team', true)).toBe(data);
    });
  });
}
