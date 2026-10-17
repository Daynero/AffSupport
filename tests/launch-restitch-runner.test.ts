// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  runLaunchRestitch,
  type LaunchRestitchRunnerDeps
} from '../apps/web/src/team/launches/restitch-runner';
import { TeamApiError } from '../apps/web/src/api/team';
import type {
  TeamRestitchDefaults,
  RestitchDrawResult
} from '../packages/shared/src/team/restitch';
const input = {
  teamId: 'team',
  generationId: 'generation',
  video: { id: 'video', name: 'clip.mp4' }
};
function fixture(operationId: string | null = null) {
  const defaults: TeamRestitchDefaults = {
    operation: 'restitch',
    startImageIds: [],
    endImageIds: [],
    fitMode: 'cover',
    finalDurationMode: 'custom',
    customFinalDurationSeconds: 120,
    configured: true,
    sourceMode: 'drive',
    updatedAt: '2026-10-13T00:00:00Z',
    updatedBy: null
  };
  const draw: RestitchDrawResult = {
    sourceMode: 'drive',
    pool: { start: 'empty', end: 'ready' },
    screens: [
      {
        slot: 'end',
        materialId: 'picture',
        checksum: 'a'.repeat(32),
        mimeType: 'image/png',
        fileName: 'picture.png',
        sizeBytes: 10,
        driveVersion: '1'
      }
    ]
  };
  const preparation = { defaults, draw, processKey: 'launch-restitch:generation:1', operationId };
  const launches = {
    pauseRestitch: vi.fn().mockResolvedValue(undefined),
    restitchReuse: vi.fn().mockResolvedValue(null),
    restitchPreparation: vi.fn().mockResolvedValue(preparation),
    prepareRestitch: vi.fn().mockResolvedValue(preparation),
    bindRestitch: vi.fn().mockResolvedValue(undefined),
    settleRestitch: vi.fn().mockResolvedValue(true)
  };
  const client = {
    canRestitch: vi.fn().mockResolvedValue('yes'),
    ensureRestitchedFolder: vi
      .fn()
      .mockResolvedValue({ materialId: 'folder', folderId: 'drive-folder' }),
    startProcess: vi.fn().mockResolvedValue({
      operationId: 'child',
      sourceGrant: { ticket: 'source-private' },
      finalizeGrant: { ticket: 'finalize-private' }
    }),
    runAgentProcess: vi.fn().mockResolvedValue({ state: 'succeeded', materialId: 'copy' }),
    cancelOperation: vi.fn().mockResolvedValue(undefined)
  };
  const screens = {
    capable: vi.fn().mockResolvedValue('yes'),
    grant: vi.fn().mockResolvedValue({
      kind: 'agent',
      transferUrl: 'https://example.invalid/',
      grant: { ticket: 'screen-private' }
    })
  };
  const operation = vi.fn().mockResolvedValue({
    id: 'child',
    teamId: 'team',
    state: 'pending',
    sourceMaterialId: 'video',
    resultMaterialId: null
  });
  const deps: LaunchRestitchRunnerDeps = { launches, client, screens, operation };
  return { deps, launches, client, screens, operation, preparation };
}
it('uses frozen screens and duration, binds the stable child before local execution and settles after completion', async () => {
  const f = fixture();
  const receipt = await runLaunchRestitch(input, f.deps);
  expect(receipt.operationId).toBe('child');
  expect(f.launches.prepareRestitch).not.toHaveBeenCalled();
  expect(f.screens.grant).toHaveBeenCalledWith('team', 'picture', 'agent');
  expect(f.client.startProcess).toHaveBeenCalledWith(
    expect.objectContaining({ idempotencyKey: f.preparation.processKey, toolContractVersion: 2 })
  );
  expect(f.launches.bindRestitch).toHaveBeenCalledWith('team', 'generation', 'child');
  expect(f.launches.bindRestitch.mock.invocationCallOrder[0]).toBeLessThan(
    f.client.runAgentProcess.mock.invocationCallOrder[0]!
  );
  expect(f.client.runAgentProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        defaults: expect.objectContaining({ customFinalDurationSeconds: 120 }),
        screens: [expect.objectContaining({ materialId: 'picture' })]
      })
    })
  );
  expect(f.launches.settleRestitch).toHaveBeenCalledWith('team', 'generation');
  expect(JSON.stringify(f.launches.bindRestitch.mock.calls)).not.toContain('private');
});
it('recovers the completed child without drawing, granting, starting or invoking the agent', async () => {
  const f = fixture('child');
  f.operation.mockResolvedValue({
    id: 'child',
    teamId: 'team',
    state: 'succeeded',
    sourceMaterialId: 'video',
    resultMaterialId: 'copy'
  });
  expect((await runLaunchRestitch(input, f.deps)).operationId).toBe('child');
  expect(f.screens.grant).not.toHaveBeenCalled();
  expect(f.client.startProcess).not.toHaveBeenCalled();
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
  expect(f.launches.settleRestitch).toHaveBeenCalledTimes(1);
});
it('preserves a child still running after a lost browser reply', async () => {
  const f = fixture('child');
  f.operation.mockResolvedValue({
    id: 'child',
    teamId: 'team',
    state: 'running',
    sourceMaterialId: 'video',
    resultMaterialId: null
  });
  await expect(runLaunchRestitch(input, f.deps)).rejects.toMatchObject({ code: 'LAUNCH_BUSY' });
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
  expect(f.client.cancelOperation).not.toHaveBeenCalled();
});
it('fences a cancellation arriving while transient screen grants are being prepared', async () => {
  const f = fixture();
  f.launches.restitchPreparation.mockRejectedValueOnce(new TeamApiError('WRONG_STATE', false));
  // First read succeeds; the authority check just before starting sees cancellation.
  f.launches.restitchPreparation
    .mockReset()
    .mockResolvedValueOnce(f.preparation)
    .mockRejectedValueOnce(new TeamApiError('WRONG_STATE', false));
  await expect(runLaunchRestitch(input, f.deps)).rejects.toMatchObject({ code: 'WRONG_STATE' });
  expect(f.client.startProcess).not.toHaveBeenCalled();
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
});
it('does not automatically restart a failed child', async () => {
  const f = fixture('child');
  f.operation.mockResolvedValue({
    id: 'child',
    teamId: 'team',
    state: 'failed',
    sourceMaterialId: 'video',
    resultMaterialId: null,
    errorCode: 'SOURCE_CHANGED'
  });
  await expect(runLaunchRestitch(input, f.deps)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(f.launches.settleRestitch).toHaveBeenCalledTimes(1);
  expect(f.client.startProcess).not.toHaveBeenCalled();
});

it('reuses the same Launch history video for a changed URL without even preparing local work', async () => {
  const f = fixture();
  f.launches.restitchReuse.mockResolvedValue({
    operationId: 'previous-child',
    materialId: 'previous-copy'
  });
  expect((await runLaunchRestitch(input, f.deps)).operationId).toBe('previous-child');
  expect(f.launches.restitchPreparation).not.toHaveBeenCalled();
  expect(f.launches.prepareRestitch).not.toHaveBeenCalled();
  expect(f.screens.grant).not.toHaveBeenCalled();
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
});

it('persists an absent agent as a resumable dependency without starting any local job', async () => {
  const f = fixture();
  f.client.canRestitch.mockResolvedValue('unreachable');
  await expect(runLaunchRestitch(input, f.deps)).rejects.toMatchObject({
    code: 'AGENT_REQUIRED',
    retryable: true
  });
  expect(f.launches.pauseRestitch).toHaveBeenCalledWith('team', 'generation', 'AGENT_REQUIRED');
  expect(f.screens.grant).not.toHaveBeenCalled();
  expect(f.client.startProcess).not.toHaveBeenCalled();
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
  f.client.canRestitch.mockResolvedValue('yes');
  expect((await runLaunchRestitch(input, f.deps)).operationId).toBe('child');
});

it('bounds a stalled preparation read and never starts a child from its late reply', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let resolve!: (value: typeof f.preparation) => void;
    f.launches.restitchPreparation.mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    );
    const outcome = expect(runLaunchRestitch(input, f.deps)).rejects.toMatchObject({
      code: 'LAUNCH_RESULT_UNCERTAIN'
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    resolve(f.preparation);
    await Promise.resolve();
    expect(f.client.startProcess).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('fences a late screen grant after the UI execution was cancelled', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.screens.grant.mockImplementationOnce(async () => {
    controller.abort();
    return { kind: 'agent', transferUrl: 'https://example.invalid', grant: { ticket: 'late' } };
  });
  await expect(
    runLaunchRestitch({ ...input, signal: controller.signal }, f.deps)
  ).rejects.toBeTruthy();
  expect(f.client.startProcess).not.toHaveBeenCalled();
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
});

it('does not hang on a lost cancellation reply after a proven native failure', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.client.runAgentProcess.mockResolvedValue({ state: 'failed', materialId: '' });
    f.client.cancelOperation.mockImplementation(() => new Promise(() => {}));
    const outcome = expect(runLaunchRestitch(input, f.deps)).rejects.toThrow('PROCESS_FAILED');
    await vi.advanceTimersByTimeAsync(30_001);
    await outcome;
    expect(f.client.cancelOperation).toHaveBeenCalledOnce();
    expect(f.launches.settleRestitch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
