import { beforeEach, expect, it, vi } from 'vitest';
import { launchApi } from '../apps/web/src/api/launches';
import { launchConfig } from './fixtures/launches';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({ rpc }),
  withFreshSession: (run: () => Promise<unknown>) => run()
}));
vi.mock('../apps/web/src/api/team', () => ({
  TeamApiError: class extends Error {
    constructor(
      public code: string,
      public retryable: boolean
    ) {
      super(code);
    }
  },
  throwRpc: (error: unknown) => {
    if (error) throw error;
  }
}));
beforeEach(() => rpc.mockReset());
it('routes scopes to distinct RPCs and sends only reusable values, including manual budgets', async () => {
  rpc.mockResolvedValue({ data: { version: '1' }, error: null });
  const config = launchConfig({
    budgetMode: 'manual',
    budgets: [10, 25, 30],
    minBudget: 10,
    originalUrl: 'SYNTHETIC_PRIVATE_URL'
  });
  await launchApi.setDefaults('team', null, 'offer-key', config, 'offer');
  const [name, args] = rpc.mock.calls[0];
  expect(name).toBe('set_launch_offer_defaults');
  expect(args).toMatchObject({
    p_team: 'team',
    p_offer: 'offer',
    p_expected_version: null,
    p_key: 'offer-key',
    p_config: { budgetMode: 'manual', budgets: [10, 25, 30], minBudget: 10 },
    p_sub_config: config.subConfig
  });
  expect(args.p_config.originalUrl).toBe('SYNTHETIC_PRIVATE_URL');
  expect(args.p_config.launchDate).toBe(config.launchDate);
  expect(args.p_config.timezone).toBe(config.timezone);
  for (const key of ['offerId', 'agentRowId', 'materialId', 'creativeAlias', 'subConfig'])
    expect(args.p_config).not.toHaveProperty(key);
  await launchApi.setDefaults('team', '1', 'general-key', config);
  expect(rpc.mock.calls[1][0]).toBe('set_launch_defaults');
  expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_offer');
});
it('does not accept malformed save receipts as success', async () => {
  for (const data of [null, {}, { version: 2 }, []]) {
    rpc.mockResolvedValue({ data, error: null });
    await expect(
      launchApi.setDefaults('team', null, 'request-key', launchConfig(), 'offer')
    ).rejects.toThrow('INVALID_RESPONSE');
  }
});
it('distinguishes a missing profile from failed or malformed reads', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: null });
  expect(await launchApi.defaults('team', 'offer')).toBeNull();
  expect(rpc).toHaveBeenLastCalledWith('get_launch_offer_defaults', {
    p_team: 'team',
    p_offer: 'offer'
  });
  rpc.mockResolvedValueOnce({ data: null, error: new Error('PERMISSION_DENIED') });
  await expect(launchApi.defaults('team', 'offer')).rejects.toThrow('PERMISSION_DENIED');
  rpc.mockResolvedValueOnce({ data: {}, error: null });
  await expect(launchApi.defaults('team', 'offer')).rejects.toThrow('INVALID_RESPONSE');
  rpc.mockResolvedValueOnce({
    data: { config: { campaignCount: 3 }, subConfig: launchConfig().subConfig, version: '1' },
    error: null
  });
  expect(await launchApi.defaults('team')).toMatchObject({
    config: { campaignCount: 3 },
    version: '1'
  });
  expect(rpc).toHaveBeenLastCalledWith('get_launch_defaults', { p_team: 'team' });
});
