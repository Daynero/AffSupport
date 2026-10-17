import { afterEach, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const invoke = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc, functions: { invoke } }),
  getSupabaseClient: () => ({ rpc, functions: { invoke } })
}));
const { teamApi } = await import('../apps/web/src/api/team');
afterEach(() => vi.resetAllMocks());

it('repeated background status reads preserve ready state without minting image grants', async () => {
  rpc.mockResolvedValue({
    data: [
      {
        material_id: 'm',
        preset: 'default',
        render_state: 'ready',
        valid: true,
        segment_count: 1,
        source_version: 'v1',
        fingerprint: 'f'
      }
    ],
    error: null
  });
  for (let i = 0; i < 3; i += 1) {
    expect(
      await teamApi.listLandingRenders('team', ['m'], 'default', { includeArtifacts: false })
    ).toEqual([
      { materialId: 'm', preset: 'default', state: 'ready', sourceVersion: 'v1', fingerprint: 'f' }
    ]);
  }
  expect(invoke).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(3);
});
