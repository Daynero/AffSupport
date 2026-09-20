// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RestitchClaim } from '../apps/web/src/api/team';

/**
 * Feature 023: a member's tab preparing one of the updater's spare copies with the Soty app — what it
 * hands the app, how it keeps and loses the lease, and what it reports.
 */

const { runRestitchClaim } =
  await import('../apps/web/src/team/catalog-updater/useRestitchPreparer');
type Client = Parameters<typeof runRestitchClaim>[1];

const grant = {
  ticket: 't'.repeat(40),
  purpose: 'process_input' as const,
  expiresAt: '2026-09-15T00:00:00Z',
  maxRangeBytes: 1,
  maxUses: 1
};

const claim: RestitchClaim = {
  jobId: 'job-1',
  leaseToken: 'L'.repeat(43),
  operationId: 'op-1',
  toolId: 'restitch',
  videoMaterialId: 'video-1',
  videoDriveVersion: '19',
  options: {
    defaults: { configured: true, operation: 'stitch' },
    prepared: {
      materialId: 'video-1',
      driveVersion: '17',
      detectorVersion: 2,
      detectedStartSeconds: 0,
      detectedEndSeconds: 0,
      profile: null,
      unsupportedReason: 'container',
      preparedAt: ''
    }
  },
  sourceGrant: grant,
  finalizeGrant: { ...grant, purpose: 'finalize' as const }
};

function client(overrides: Partial<Client> = {}): Client {
  return {
    claimRestitchJob: vi.fn(),
    heartbeatRestitchJob: vi.fn(async () => false),
    completeRestitchJob: vi.fn(async () => true),
    startProcess: vi.fn(async () => ({
      operationId: 'op-1',
      state: 'succeeded' as const,
      materialId: 'copy-1',
      reused: false
    })),
    cancelProcess: vi.fn(async () => true),
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('preparing a spare copy', () => {
  it('hands the app the process, without a preparation for another version of the file', async () => {
    const api = client();
    await runRestitchClaim(claim, api, () => false);
    expect(api.startProcess).toHaveBeenCalledWith({
      operationId: 'op-1',
      toolId: 'restitch',
      options: { defaults: claim.options.defaults, prepared: null },
      sourceGrant: claim.sourceGrant,
      finalizeGrant: claim.finalizeGrant
    });
    expect(api.completeRestitchJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      leaseToken: claim.leaseToken,
      outcome: 'finalized',
      errorCode: null
    });
  });

  it('reports the code a failed run gave', async () => {
    const api = client({
      startProcess: vi.fn(async () => {
        throw new Error('UNSUPPORTED_MEDIA');
      })
    });
    await runRestitchClaim(claim, api, () => false);
    expect(api.completeRestitchJob).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', errorCode: 'UNSUPPORTED_MEDIA' })
    );
  });

  it('cancels the run when the heartbeat says the updater no longer wants it, and reports nothing', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const api = client({
      heartbeatRestitchJob: vi.fn(async () => true),
      startProcess: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            finish = () => reject(new Error('PROCESS_CANCELED'));
          })
      )
    });
    const running = runRestitchClaim(claim, api, () => false);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(api.cancelProcess).toHaveBeenCalledWith('op-1');
    finish();
    await running;
    expect(api.completeRestitchJob).not.toHaveBeenCalled();
  });
});
