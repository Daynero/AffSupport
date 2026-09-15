import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import {
  claimRestitchJob,
  completeRestitchJob,
  DEVICE_SECRET_HEADER,
  heartbeatRestitchJob,
  recordRestitchOutput,
  restitchedCopyName,
  type UpdaterDeviceDeps
} from '../supabase/functions/drive-ops/updater-device.js';

/**
 * Feature 023, delivery 2: the routes the re-stitching computer calls in drive-ops, with the
 * database, process start and Drive replaced by recording fakes.
 */

const DEVICE = '23200000-0000-4000-8000-000000000001';
const JOB = '23200000-0000-4000-8000-000000000002';
const SECRET = 'a'.repeat(64);
const LEASE = 'L'.repeat(43);

const claimed = {
  jobId: JOB,
  teamId: 'team',
  actorId: 'actor',
  attempt: 2,
  videoMaterialId: 'video',
  videoName: 'clip.final.mp4',
  destinationFolderId: 'folder',
  updateCount: 3,
  defaults: { operation: 'restitch', configured: true },
  prepared: null
};

function headers(secret: string | null = SECRET) {
  return new Headers(secret === null ? {} : { [DEVICE_SECRET_HEADER]: secret });
}

function setup(overrides: { claim?: unknown; start?: () => Promise<never>; bound?: boolean } = {}) {
  const rpc = vi.fn(async (name: string, _parameters: Record<string, unknown>) => {
    switch (name) {
      case 'service_claim_restitch_job':
        return 'claim' in overrides ? overrides.claim : claimed;
      case 'service_bind_restitch_job_operation':
        return overrides.bound ?? true;
      case 'service_heartbeat_restitch_job':
        return false;
      case 'service_complete_restitch_job':
        return true;
      case 'service_record_restitch_output':
        return 'spare';
      default:
        throw new Error(name);
    }
  });
  const deps: UpdaterDeviceDeps = {
    rpc,
    startProcess: vi.fn(
      overrides.start ??
        (async () => ({ operationId: 'op-1', sourceGrant: { s: 1 }, finalizeGrant: { f: 1 } }))
    ),
    abandonOperation: vi.fn(async () => undefined),
    hashHex: vi.fn(async (value: string) => `hash(${value})`),
    randomToken: () => LEASE,
    log: vi.fn()
  };
  const call = (name: string) => rpc.mock.calls.find(entry => entry[0] === name)?.[1];
  return { deps, rpc, call };
}

describe('claiming', () => {
  it('refuses a request without a well-formed secret before touching the database', async () => {
    const { deps, rpc } = setup();
    await expect(claimRestitchJob(deps, headers(null), { deviceId: DEVICE })).rejects.toThrow(
      TeamFunctionError
    );
    await expect(claimRestitchJob(deps, headers('short'), { deviceId: DEVICE })).rejects.toThrow(
      /AUTH_REQUIRED/
    );
    await expect(claimRestitchJob(deps, headers(), { deviceId: 'x' })).rejects.toThrow(
      /INVALID_INPUT/
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('starts the process as the enrolling member and hands back a process request', async () => {
    const { deps, call } = setup();
    const result = await claimRestitchJob(deps, headers(), {
      deviceId: DEVICE,
      build: '1.2.0',
      toolContracts: { teamUpdaterRestitch: 1, 'bad key': 3, stitcher: 'x' }
    });
    expect(call('service_claim_restitch_job')).toMatchObject({
      p_device: DEVICE,
      p_secret_hash: `hash(${SECRET})`,
      p_contracts: { teamUpdaterRestitch: 1 },
      p_lease_token_hash: `hash(${LEASE})`
    });
    expect(deps.startProcess).toHaveBeenCalledWith('actor', {
      teamId: 'team',
      materialId: 'video',
      destinationFolderId: 'folder',
      idempotencyKey: `updater-${JOB}-${LEASE.slice(0, 16)}`,
      toolId: 'restitch',
      outputName: 'clip.final restitched 4.mp4',
      conflictMode: 'keep_both',
      agentContractVersion: 1,
      toolContractVersion: 1
    });
    expect(call('service_bind_restitch_job_operation')).toEqual({
      p_job: JOB,
      p_lease_token_hash: `hash(${LEASE})`,
      p_operation: 'op-1'
    });
    expect(result).toEqual({
      job: {
        jobId: JOB,
        leaseToken: LEASE,
        operationId: 'op-1',
        toolId: 'restitch',
        options: { defaults: claimed.defaults, prepared: null },
        sourceGrant: { s: 1 },
        finalizeGrant: { f: 1 }
      }
    });
  });

  it('closes the operations lapsed leases left open before starting again', async () => {
    const { deps } = setup({ claim: { ...claimed, openOperationIds: ['op-old', 'op-older'] } });
    await claimRestitchJob(deps, headers(), { deviceId: DEVICE });
    expect(deps.abandonOperation).toHaveBeenCalledWith('op-old');
    expect(deps.abandonOperation).toHaveBeenCalledWith('op-older');
    expect(vi.mocked(deps.abandonOperation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.startProcess).mock.invocationCallOrder[0]!
    );
  });

  it('answers nothing to do', async () => {
    const { deps } = setup({ claim: null });
    expect(await claimRestitchJob(deps, headers(), { deviceId: DEVICE })).toEqual({ job: null });
    expect(deps.startProcess).not.toHaveBeenCalled();
  });

  it('fails the job instead of starting a run the space is not set up for', async () => {
    const { deps, call } = setup({ claim: { ...claimed, defaults: { configured: false } } });
    expect(await claimRestitchJob(deps, headers(), { deviceId: DEVICE })).toEqual({ job: null });
    expect(deps.startProcess).not.toHaveBeenCalled();
    expect(call('service_complete_restitch_job')).toMatchObject({
      p_outcome: 'failed',
      p_error: 'RESTITCH_INVALID'
    });
  });

  it('records why the process could not start', async () => {
    const { deps, call } = setup({
      start: async () => {
        throw new TeamFunctionError('TOO_LARGE');
      }
    });
    expect(await claimRestitchJob(deps, headers(), { deviceId: DEVICE })).toEqual({ job: null });
    expect(call('service_complete_restitch_job')).toMatchObject({ p_error: 'TOO_LARGE' });
  });

  it('gives nothing out when the lease was lost before the operation was bound', async () => {
    const { deps } = setup({ bound: false });
    expect(await claimRestitchJob(deps, headers(), { deviceId: DEVICE })).toEqual({ job: null });
  });
});

describe('heartbeat and completion', () => {
  it('renews with hashed secret and lease', async () => {
    const { deps, call } = setup();
    expect(
      await heartbeatRestitchJob(deps, headers(), {
        deviceId: DEVICE,
        jobId: JOB,
        leaseToken: LEASE
      })
    ).toEqual({ cancel: false });
    expect(call('service_heartbeat_restitch_job')).toMatchObject({
      p_secret_hash: `hash(${SECRET})`,
      p_lease_token_hash: `hash(${LEASE})`
    });
    await expect(
      heartbeatRestitchJob(deps, headers(), { deviceId: DEVICE, jobId: JOB, leaseToken: 'x' })
    ).rejects.toThrow(/INVALID_INPUT/);
  });

  it('passes the outcome, a clean error code and the discovery', async () => {
    const { deps, call } = setup();
    await completeRestitchJob(deps, headers(), {
      deviceId: DEVICE,
      jobId: JOB,
      leaseToken: LEASE,
      outcome: 'failed',
      errorCode: 'not a code',
      discovered: { detectorVersion: 2 }
    });
    expect(call('service_complete_restitch_job')).toMatchObject({
      p_outcome: 'failed',
      p_error: 'PROCESS_FAILED',
      p_discovered: { detectorVersion: 2 }
    });
    await expect(
      completeRestitchJob(deps, headers(), {
        deviceId: DEVICE,
        jobId: JOB,
        leaseToken: LEASE,
        outcome: 'maybe'
      })
    ).rejects.toThrow(/INVALID_INPUT/);
  });
});

describe('the committed copy', () => {
  it('is shared by link and recorded with that link', async () => {
    const { rpc } = setup();
    const drive = {
      listAnyonePermissions: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'anyone', role: 'reader' }]),
      createAnyoneReaderPermission: vi.fn(async () => undefined)
    };
    const outcome = await recordRestitchOutput(
      { rpc, drive: drive as never, log: vi.fn() },
      { operationId: 'op', materialId: 'm', driveFileId: 'file-1' }
    );
    expect(outcome).toBe('spare');
    expect(drive.createAnyoneReaderPermission).toHaveBeenCalledWith('file-1');
    expect(rpc).toHaveBeenCalledWith('service_record_restitch_output', {
      p_operation: 'op',
      p_material: 'm',
      p_drive_file_id: 'file-1',
      p_shared_link: 'https://drive.google.com/file/d/file-1/view?usp=sharing'
    });
  });

  it('is recorded without a link when sharing fails, so it is not used', async () => {
    const { rpc } = setup();
    const drive = {
      listAnyonePermissions: vi.fn(async () => {
        throw new TeamFunctionError('PERMISSION_DENIED');
      }),
      createAnyoneReaderPermission: vi.fn()
    };
    await recordRestitchOutput(
      { rpc, drive: drive as never, log: vi.fn() },
      { operationId: 'op', materialId: 'm', driveFileId: 'file-1' }
    );
    expect(rpc).toHaveBeenCalledWith(
      'service_record_restitch_output',
      expect.objectContaining({ p_shared_link: null })
    );
  });

  it('names copies after the video and the update they are for', () => {
    expect(restitchedCopyName('clip.mp4', 0)).toBe('clip restitched 1.mp4');
    expect(restitchedCopyName('.mp4', 9)).toBe('.mp4 restitched 10.mp4');
  });
});
