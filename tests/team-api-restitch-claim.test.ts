import { afterEach, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('../apps/web/src/lib/config', () => ({
  publicConfig: { ok: true, value: { supabaseUrl: 'http://127.0.0.1:54321' } }
}));
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ functions: { invoke } }),
  getSupabaseClient: () => ({ functions: { invoke } })
}));
const { teamApi } = await import('../apps/web/src/api/team');
afterEach(() => vi.resetAllMocks());

const job = {
  jobId: 'job',
  leaseToken: 'lease',
  operationId: 'operation',
  toolId: 'restitch',
  videoMaterialId: 'video',
  videoDriveVersion: null,
  sourceGrant: { ticket: 'source' },
  finalizeGrant: { ticket: 'finalize' },
  options: {
    defaults: { configured: true },
    prepared: null,
    teamId: 'team',
    screens: [
      {
        slot: 'start',
        materialId: 'image',
        checksum: 'md5',
        transfer: {
          transferUrl: 'http://kong:8000/functions/v1/drive-transfer/range',
          grant: { ticket: 'screen', purpose: 'download_range' }
        }
      }
    ]
  }
};

it('normalizes drawn screen download URLs to the configured public Supabase gateway before agent handoff', async () => {
  invoke.mockResolvedValue({ data: { ok: true, value: { job } }, error: null });
  const result = await teamApi.claimRestitchJob('team');
  expect(result).toEqual({
    ...job,
    options: {
      ...job.options,
      screens: [
        {
          ...job.options.screens[0],
          transfer: {
            ...job.options.screens[0]!.transfer,
            transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range'
          }
        }
      ]
    }
  });
  expect(job.options.screens[0]!.transfer.transferUrl).toContain('kong:8000');
});

it('preserves an empty claim without requiring any screen grants', async () => {
  invoke.mockResolvedValue({ data: { ok: true, value: { job: null } }, error: null });
  expect(await teamApi.claimRestitchJob('team')).toBeNull();
});
