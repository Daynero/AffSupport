import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamErrorMessage } from '../apps/web/src/team/errors';

const rpc = vi.fn();
vi.mock('../apps/web/src/lib/supabase', () => ({
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => ({ rpc }),
  getSupabaseClient: () => ({ rpc })
}));
const { teamApi } = await import('../apps/web/src/api/team');
afterEach(() => rpc.mockReset());

const status = {
  jobId: 'job',
  scopeFolderId: 'folder',
  state: 'running',
  phase: 'replaying_changes',
  discoveredFiles: 20,
  completedFolders: 2,
  pendingFolders: 0,
  lastProgressAt: '2026-09-24T12:00:00Z',
  completedAt: null,
  errorCode: null
};

describe('folder sync API boundary', () => {
  it('returns acceptance, never completion, from a request', async () => {
    rpc.mockResolvedValue({
      data: [{ sync_job_id: 'job', initial_sync_state: 'scanning' }],
      error: null
    });
    expect(await teamApi.resyncFolder('team', 'folder')).toEqual({
      syncJobId: 'job',
      initialSyncState: 'scanning'
    });
  });
  it.each([
    { data: [] },
    { data: [{ sync_job_id: '', initial_sync_state: 'scanning' }] },
    { data: [{ sync_job_id: 'job', initial_sync_state: 'ready' }] }
  ])('rejects an invalid acceptance response', async ({ data }) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(teamApi.resyncFolder('team', 'folder')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });
  it('reads the safe authoritative status without extra progress requests', async () => {
    rpc.mockResolvedValue({ data: status, error: null });
    expect(await teamApi.getFolderSyncStatus('team', 'job')).toEqual(status);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_team_folder_sync_status', {
      p_team: 'team',
      p_job: 'job'
    });
  });
  it.each([
    { ...status, lease_owner: 'private' },
    { ...status, discoveredFiles: -1 },
    { ...status, jobId: 'other-job' }
  ])('rejects private fields, invalid counts and another job response', async data => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(teamApi.getFolderSyncStatus('team', 'job')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    });
  });
  it('preserves an authorization error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PERMISSION_DENIED', code: '42501' } });
    await expect(teamApi.getFolderSyncStatus('team', 'job')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });
  });
  it('maps sync failure codes without displaying raw server messages', () => {
    expect(teamErrorMessage('INCOMPLETE_SCAN', key => key)).toBe('teamErrorInvalidResponse');
    expect(teamErrorMessage('RETRY_EXHAUSTED', key => key)).toBe('teamErrorDriveUnavailable');
    expect(teamErrorMessage('private provider text', key => key)).toBe('teamErrorUnknown');
  });
});
