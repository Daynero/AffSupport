import { afterEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
const team = '22222222-2222-4222-8222-222222222222';
const schedule = {
  enabled: true,
  count: 200,
  nextRunAt: '2026-11-04T14:00:00Z',
  lastRunAt: null,
  lastError: null
};
afterEach(() => rpc.mockReset());
describe('catalog text schedule RPC boundary', () => {
  it('reads and saves the server schedule without generating immediately', async () => {
    rpc.mockResolvedValue({ data: schedule, error: null });
    expect(await teamApi.getProductCatalogTextSchedule(team)).toEqual(schedule);
    expect(
      await teamApi.setProductCatalogTextSchedule(team, { enabled: true, count: 200 })
    ).toEqual(schedule);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'get_team_product_catalog_text_schedule',
      'set_team_product_catalog_text_schedule'
    ]);
    expect(rpc).toHaveBeenLastCalledWith('set_team_product_catalog_text_schedule', {
      p_team: team,
      p_enabled: true,
      p_count: 200
    });
  });
  it('refuses malformed counts and dates rather than displaying a false next run', async () => {
    for (const data of [
      { ...schedule, count: 1001 },
      { ...schedule, count: 0 },
      { ...schedule, nextRunAt: 'bad' }
    ]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(teamApi.getProductCatalogTextSchedule(team)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      });
    }
  });
});
