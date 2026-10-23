// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  prepareCatalogRestitch,
  type CatalogRestitchCheckpointAdapter
} from '../apps/web/src/team/product-catalog/catalog-orchestration';
import type { TeamRestitchDefaults } from '../packages/shared/src/team/restitch';
const defaults: TeamRestitchDefaults = {
  operation: 'restitch',
  startImageIds: [],
  endImageIds: [],
  fitMode: 'cover',
  finalDurationMode: 'random-30-40',
  customFinalDurationSeconds: 60,
  configured: true,
  sourceMode: 'drive',
  updatedAt: '2026-10-13T00:00:00Z',
  updatedBy: null
};
function fixture() {
  const client = {
    canRestitch: vi.fn().mockResolvedValue('yes'),
    prepareRestitchScreens: vi.fn().mockResolvedValue({
      kind: 'ready',
      screens: [
        {
          slot: 'end',
          materialId: 'screen',
          checksum: 'a'.repeat(32),
          mimeType: 'image/png',
          fileName: 'screen.png',
          sizeBytes: 10,
          transfer: {
            transferUrl: 'https://example.invalid/range',
            grant: { ticket: 'private-screen-ticket' }
          }
        }
      ]
    }),
    ensureRestitchedFolder: vi
      .fn()
      .mockResolvedValue({ materialId: 'folder', folderId: 'drive-folder' }),
    startProcess: vi.fn().mockResolvedValue({
      operationId: 'operation',
      sourceGrant: { ticket: 'private-source-ticket' },
      finalizeGrant: { ticket: 'private-finalize-ticket' }
    }),
    runAgentProcess: vi.fn().mockResolvedValue({ state: 'succeeded', materialId: 'copy' }),
    cancelOperation: vi.fn().mockResolvedValue(undefined)
  };
  const checkpoint: CatalogRestitchCheckpointAdapter = {
    completed: vi.fn(async () => null),
    prepared: vi.fn(async () => undefined),
    beforeStart: vi.fn(async () => undefined),
    started: vi.fn(async () => undefined),
    finished: vi.fn(async () => undefined)
  };
  const input = {
    teamId: 'team',
    video: { id: 'video', name: 'clip.mp4' },
    defaults,
    durationMode: 'random-30-40' as const,
    customSeconds: null,
    catalogKey: 'catalog-request',
    processKey: 'stable-process-request',
    client,
    checkpoint
  };
  return { client, checkpoint, input };
}
it('checkpoints prepared metadata and stable IDs without transfer credentials', async () => {
  const f = fixture();
  const receipt = await prepareCatalogRestitch(f.input);
  expect(receipt).toMatchObject({ operationId: 'operation', catalogKey: 'catalog-request' });
  expect(f.client.startProcess).toHaveBeenCalledWith(
    expect.objectContaining({ idempotencyKey: 'stable-process-request', toolContractVersion: 2 })
  );
  const persisted = JSON.stringify(vi.mocked(f.checkpoint.prepared).mock.calls);
  expect(persisted).toContain('screen.png');
  expect(persisted).not.toContain('private-screen-ticket');
  expect(persisted).not.toContain('transferUrl');
  expect(JSON.stringify(vi.mocked(f.checkpoint.started).mock.calls)).not.toContain(
    'private-source-ticket'
  );
  expect(f.checkpoint.finished).toHaveBeenCalledWith(receipt);
});
it('reuses a completed durable receipt without drawing pictures or running the agent', async () => {
  const f = fixture();
  const receipt = await prepareCatalogRestitch(f.input);
  vi.mocked(f.checkpoint.completed).mockResolvedValue(receipt);
  vi.clearAllMocks();
  expect(await prepareCatalogRestitch(f.input)).toEqual(receipt);
  expect(f.client.prepareRestitchScreens).not.toHaveBeenCalled();
  expect(f.client.startProcess).not.toHaveBeenCalled();
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
});
it('cancels the exact failed child while retaining the stable request keys', async () => {
  const f = fixture();
  f.client.runAgentProcess.mockRejectedValueOnce(new Error('PROCESS_FAILED'));
  await expect(prepareCatalogRestitch(f.input)).rejects.toThrow('PROCESS_FAILED');
  expect(f.client.cancelOperation).toHaveBeenCalledWith('team', 'operation');
  expect(f.checkpoint.finished).not.toHaveBeenCalled();
  expect(f.checkpoint.beforeStart).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: 'stable-process-request',
      catalogKey: 'catalog-request'
    })
  );
});

it('preserves an active Launch child when another tab retries or the reply is lost', async () => {
  for (const code of [
    'WRONG_STATE',
    'CONNECTION_FAILED',
    'TIMEOUT',
    'INVALID_RESPONSE',
    'PERMISSION_DENIED'
  ]) {
    const f = fixture();
    f.client.runAgentProcess.mockRejectedValueOnce(new Error(code));
    await expect(prepareCatalogRestitch(f.input)).rejects.toThrow(code);
    expect(f.client.cancelOperation).not.toHaveBeenCalled();
    expect(f.checkpoint.finished).not.toHaveBeenCalled();
  }
});

it('does not cancel a child after a lost bind reply before local execution', async () => {
  const f = fixture();
  vi.mocked(f.checkpoint.started).mockRejectedValueOnce(new Error('INVALID_RESPONSE'));
  await expect(prepareCatalogRestitch(f.input)).rejects.toThrow('INVALID_RESPONSE');
  expect(f.client.runAgentProcess).not.toHaveBeenCalled();
  expect(f.client.cancelOperation).not.toHaveBeenCalled();
});

it('freezes independent range bounds and reuses the finished video on a catalog retry', async () => {
  const f = fixture();
  const random = vi.fn(() => 0.5);
  const input = {
    ...f.input,
    durationMode: 'random-centered' as const,
    customSeconds: 1800,
    durationRangeSeconds: [600, 3000] as const,
    random
  };
  const receipt = await prepareCatalogRestitch(input);
  expect(f.client.runAgentProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        defaults: expect.objectContaining({
          finalDurationMode: 'custom',
          customFinalDurationSeconds: 1800
        })
      })
    })
  );
  vi.mocked(f.checkpoint.completed).mockResolvedValue(receipt);
  expect(await prepareCatalogRestitch(input)).toEqual(receipt);
  expect(random).toHaveBeenCalledOnce();
  expect(f.client.runAgentProcess).toHaveBeenCalledOnce();
  // The same center with different bounds describes a different video request.
  await prepareCatalogRestitch({
    ...input,
    durationRangeSeconds: [1200, 2400],
    processKey: 'changed-process-request'
  });
  expect(f.client.runAgentProcess).toHaveBeenCalledTimes(2);
});

it.each([
  [0, 1200],
  [1800, 1200],
  [60, 3660],
  [61, 1200]
])('rejects invalid range %s–%s before any preparation or operation', async (low, high) => {
  const f = fixture();
  await expect(
    prepareCatalogRestitch({
      ...f.input,
      durationMode: 'random-centered',
      customSeconds: 1800,
      durationRangeSeconds: [low, high]
    })
  ).rejects.toThrow('RESTITCH_DEFAULTS_INVALID');
  expect(f.client.prepareRestitchScreens).not.toHaveBeenCalled();
  expect(f.client.startProcess).not.toHaveBeenCalled();
});

it('uses the selected exact seconds and the selected legacy random center', async () => {
  for (const durationMode of ['custom', 'random-centered'] as const) {
    const f = fixture();
    await prepareCatalogRestitch({ ...f.input, durationMode, customSeconds: 1200 });
    expect(f.client.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          defaults: expect.objectContaining({
            finalDurationMode: durationMode,
            customFinalDurationSeconds: 1200
          })
        })
      })
    );
  }
});
