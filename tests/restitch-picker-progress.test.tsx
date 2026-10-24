// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRestitchDelivery } from '../apps/web/src/team/restitch/useRestitchDelivery';

type Message = {
  type: string;
  operations: Array<{ operationId: string; state: string; stage: string; progress: number }>;
};
const seams = vi.hoisted(() => ({
  download: vi.fn(),
  complete: vi.fn(),
  error: vi.fn(),
  onMessage: null as ((event: Message) => void) | null
}));
vi.mock('../apps/web/src/api/client', () => ({
  agentCanRestitch: async () => 'yes',
  cancelTeamDownload: vi.fn(),
  downloadTeamFileWithAgent: seams.download,
  toolEventUrl: () => '/events'
}));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    getRestitchDefaults: async () => ({}),
    getMaterialRestitchPrep: async () => new Map(),
    requestDownload: async () => ({
      kind: 'agent',
      transferUrl: 'http://localhost/range',
      grant: {}
    })
  }
}));
vi.mock('../apps/web/src/AgentContext', () => ({ useOptionalAgent: () => null }));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({
  useAgentEventStream: (options: { onMessage: (event: Message) => void }) => {
    seams.onMessage = options.onMessage;
  }
}));
vi.mock('../apps/web/src/team/restitch/screens', () => ({
  prepareRestitchScreens: async () => ({ kind: 'ready', screens: {} })
}));
vi.mock('../apps/web/src/team/restitch/images', () => ({ ensureRestitchImages: vi.fn() }));
vi.mock('../apps/web/src/analytics/service', () => ({
  startTeamWorkflow: () => ({ workflowId: 'opaque-workflow' }),
  completeTeamWorkflow: seams.complete
}));
vi.mock('../apps/web/src/analytics/errors', () => ({ trackToolError: seams.error }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
const target = { materialId: 'own-video', fileName: 'own.mp4', driveVersion: null };

it('keeps the folder-choice phase until the agent actually starts the transfer', async () => {
  let reject!: (error: Error) => void;
  seams.download.mockImplementation(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      })
  );
  const view = renderHook(() => useRestitchDelivery('own-team'));
  let run!: Promise<void>;
  act(() => {
    run = view.result.current.deliver(target);
  });
  await waitFor(() => expect(seams.download).toHaveBeenCalledOnce());
  try {
    expect(view.result.current.states['own-video']).toMatchObject({
      kind: 'running',
      phase: 'choosing'
    });
    const operationId = seams.download.mock.calls[0][0].operationId as string;
    act(() =>
      seams.onMessage?.({
        type: 'team:operations',
        operations: [{ operationId, state: 'running', stage: 'downloading', progress: 10 }]
      })
    );
    expect(view.result.current.states['own-video']).toMatchObject({
      kind: 'running',
      phase: 'transferring',
      progress: 10
    });
  } finally {
    await act(async () => {
      reject(new Error('DOWNLOAD_CANCELED'));
      await run;
    });
  }
});

it('reports a canceled native destination choice as cancellation rather than failure', async () => {
  seams.download.mockRejectedValue(new Error('DOWNLOAD_CANCELED'));
  const view = renderHook(() => useRestitchDelivery('own-team'));
  await act(async () => view.result.current.deliver(target));
  expect(view.result.current.states['own-video']).toEqual({ kind: 'idle' });
  expect(seams.complete).toHaveBeenCalledWith(expect.anything(), {
    outcome: 'cancelled',
    retryable: false
  });
  expect(seams.error).not.toHaveBeenCalled();
});
