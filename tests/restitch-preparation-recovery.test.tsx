// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRestitchPreparation } from '../apps/web/src/team/restitch/useRestitchPreparation';

const seams = vi.hoisted(() => ({
  capability: vi.fn(),
  read: vi.fn(),
  cancel: vi.fn(),
  store: vi.fn(),
  folder: vi.fn(),
  grant: vi.fn(),
  prepare: vi.fn(),
  complete: vi.fn()
}));
vi.mock('../apps/web/src/api/client', () => ({
  agentCanRestitch: seams.capability,
  readTeamRestitchPreparation: seams.read,
  cancelTeamRestitchPreparation: seams.cancel,
  prepareTeamRestitchMaterials: seams.prepare
}));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    ensureWorkspaceFolder: seams.folder,
    listFolderTree: async () => [],
    listFolderPage: async () => ({
      rows: [{ id: 'material', kind: 'video', name: 'clip.mp4', driveVersion: '1' }],
      next: null
    }),
    getMaterialRestitchPrep: async () => new Map(),
    requestDownload: seams.grant,
    setMaterialRestitchPrep: seams.store
  }
}));
vi.mock('../apps/web/src/analytics/service', () => ({
  startTeamWorkflow: () => ({ flowId: 'flow' }),
  completeTeamWorkflow: seams.complete
}));
beforeEach(() => {
  vi.resetAllMocks();
  seams.capability.mockResolvedValue('yes');
  seams.folder.mockResolvedValue(undefined);
  seams.prepare.mockResolvedValue(undefined);
  seams.read.mockResolvedValue(null);
  seams.grant.mockResolvedValue({
    kind: 'agent',
    transferUrl: 'http://localhost/transfer',
    grant: 'fixture'
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('cancels polling immediately even when the agent cannot acknowledge cancellation', async () => {
  vi.useFakeTimers();
  seams.read.mockResolvedValue({
    state: 'running',
    findings: [],
    phase: 'converting',
    currentProgress: 25
  });
  seams.cancel.mockRejectedValue(new Error('offline'));
  const view = renderHook(() => useRestitchPreparation('team'));
  let work!: Promise<void>;
  await act(async () => {
    work = view.result.current.prepare();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(view.result.current.state).toMatchObject({
    phase: 'running',
    mediaPhase: 'converting',
    mediaProgress: 25
  });
  expect(seams.read).toHaveBeenCalledOnce();
  await act(async () => {
    await view.result.current.cancel();
    await work;
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1400);
  });
  expect(seams.cancel).toHaveBeenCalledExactlyOnceWith(seams.prepare.mock.calls[0][0].operationId);
  expect(seams.read).toHaveBeenCalledOnce();
  expect(view.result.current.state.phase).toBe('canceled');
  expect(seams.complete).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'cancelled' })
  );
  act(() => view.result.current.reset());
  expect(view.result.current.state).toMatchObject({ phase: 'idle', done: 0, total: 0 });
});

it('keeps completed findings visible when caching fails and counts a repeated finding once', async () => {
  const prep = { materialId: 'material' };
  const finding = { materialId: 'material', state: 'prepared', prep };
  seams.store.mockRejectedValue(new Error('storage temporarily unavailable'));
  seams.read.mockResolvedValue({
    state: 'finished',
    findings: [finding, finding],
    phase: 'verifying',
    currentProgress: 100
  });
  const view = renderHook(() => useRestitchPreparation('team'));
  await act(async () => {
    await view.result.current.prepare();
  });
  expect(seams.store).toHaveBeenCalledExactlyOnceWith(prep);
  expect(view.result.current.state).toMatchObject({
    phase: 'finished',
    done: 1,
    ready: 1,
    failed: 0
  });
});

it.each([
  ['too-old', 'AGENT_UPDATE_REQUIRED'],
  ['missing', 'AGENT_REQUIRED']
])('reports %s before creating folders or requesting a grant', async (capability, code) => {
  seams.capability.mockResolvedValue(capability);
  const view = renderHook(() => useRestitchPreparation('team'));
  await act(async () => {
    await view.result.current.prepare();
  });
  expect(view.result.current.state).toMatchObject({ phase: 'failed', errorCode: code });
  expect(seams.folder).not.toHaveBeenCalled();
  expect(seams.grant).not.toHaveBeenCalled();
});
