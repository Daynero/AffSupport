// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentQueue, type AgentQueueItem } from '../apps/web/src/team/explorer/useAgentQueue';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  grant: vi.fn(),
  run: vi.fn(),
  local: vi.fn(),
  cancelLocal: vi.fn(),
  cancelAgent: vi.fn(),
  pause: vi.fn(),
  push: vi.fn(),
  changed: vi.fn(),
  rename: vi.fn(),
  t: (key: string) => key,
  track: vi.fn(),
  complete: vi.fn(),
  workflow: vi.fn(() => ({ workflowId: 'qa-workflow' }))
}));
vi.mock('../apps/web/src/analytics/service', () => ({
  analytics: { track: mocks.track },
  startTeamWorkflow: mocks.workflow,
  completeTeamWorkflow: mocks.complete
}));
vi.mock('../apps/web/src/api/team', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/team')>();
  return {
    ...actual,
    teamApi: {
      ...actual.teamApi,
      startProcess: mocks.start,
      cancelOperation: mocks.cancel,
      requestDownload: mocks.grant
    }
  };
});
vi.mock('../apps/web/src/api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/client')>();
  return {
    ...actual,
    startTeamAgentProcess: mocks.run,
    downloadTeamFileWithAgent: mocks.local,
    cancelTeamAgentProcess: mocks.cancelAgent,
    cancelTeamDownload: mocks.cancelLocal,
    pauseTeamAgentProcess: mocks.pause
  };
});
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({
  useAgentEventStream: () => undefined
}));
vi.mock('../apps/web/src/components/toast', () => ({ useToasts: () => ({ push: mocks.push }) }));
vi.mock('../apps/web/src/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('../apps/web/src/AgentContext', () => ({ useOptionalAgent: () => null }));
vi.mock('../apps/web/src/team/processing/useTeamOperation', () => ({
  useTeamOperation: () => ({ operation: null, localProgress: null })
}));
vi.mock('../apps/web/src/team/explorer/TeamCompressorDialog', () => ({
  rememberLocalFolder: vi.fn()
}));
vi.mock('../apps/web/src/team/materials/tail', () => ({
  carryTranscriptAfterProcess: vi.fn(),
  reuseTranscriptFor: vi.fn(async () => null)
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const job = (id: string): AgentQueueItem => ({
  id,
  name: `${id}.mp4`,
  folderId: 'qa-folder',
  tool: 'compressor',
  outputName: `${id}_out.mp4`
});
function setup() {
  return renderHook(() =>
    useAgentQueue({
      teamId: 'qa-team',
      actionsClient: { renameMaterial: mocks.rename },
      onChanged: mocks.changed
    })
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancel.mockResolvedValue(true);
  mocks.cancelAgent.mockResolvedValue(true);
  mocks.cancelLocal.mockResolvedValue(true);
  mocks.run.mockResolvedValue({ materialId: null });
});
afterEach(cleanup);

it('cancels the late cloud receipt after Stop instead of dispatching it to the agent', async () => {
  const receipt = deferred<{ operationId: string }>();
  mocks.start.mockReturnValueOnce(receipt.promise);
  const hook = setup();
  act(() => hook.result.current.enqueue([job('first')]));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  await act(async () => {
    await hook.result.current.stopNow();
  });
  await act(async () => {
    receipt.resolve({ operationId: 'late-operation' });
  });
  await waitFor(() => expect(hook.result.current.active).toBeNull());
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.cancel).toHaveBeenCalledWith('qa-team', 'late-operation');
  expect(mocks.complete).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'cancelled', stage: 'downloading' })
  );
  expect(mocks.track).toHaveBeenCalledWith(
    'operation_cancelled',
    expect.objectContaining({ run_id: 'late-operation', workflow_id: 'qa-workflow' })
  );
});

it('does not drop a newly queued job when the stopped request finally answers', async () => {
  const receipt = deferred<{ operationId: string }>();
  mocks.start
    .mockReturnValueOnce(receipt.promise)
    .mockResolvedValueOnce({ operationId: 'second-operation' });
  const hook = setup();
  act(() => hook.result.current.enqueue([job('first')]));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  await act(async () => {
    await hook.result.current.stopNow();
  });
  act(() => hook.result.current.enqueue([job('second')]));
  await act(async () => {
    receipt.resolve({ operationId: 'stopped-operation' });
  });
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: 'second-operation' })
  );
});

it('does not start a local download when Stop was pressed while its grant was pending', async () => {
  const grant = deferred<{ kind: string }>();
  mocks.grant.mockReturnValueOnce(grant.promise);
  const hook = setup();
  act(() =>
    hook.result.current.enqueue([{ ...job('local'), local: { embed: false, suffix: '_out' } }])
  );
  await waitFor(() => expect(mocks.grant).toHaveBeenCalledTimes(1));
  await act(async () => {
    await hook.result.current.stopNow();
  });
  await act(async () => {
    grant.resolve({ kind: 'agent' });
  });
  await waitFor(() => expect(hook.result.current.active).toBeNull());
  expect(mocks.local).not.toHaveBeenCalled();
});

it('fences a dispatched cloud operation as well as stopping the agent', async () => {
  const finished = deferred<{ materialId: null }>();
  mocks.start.mockResolvedValueOnce({ operationId: 'running-operation' });
  mocks.run.mockReturnValueOnce(finished.promise);
  const hook = setup();
  act(() => hook.result.current.enqueue([job('running')]));
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
  await act(async () => {
    await hook.result.current.stopNow();
  });
  expect(mocks.cancel).toHaveBeenCalledWith('qa-team', 'running-operation');
  expect(mocks.cancelAgent).toHaveBeenCalledWith('running-operation');
  await act(async () => {
    finished.resolve({ materialId: null });
  });
  await waitFor(() => expect(hook.result.current.active).toBeNull());
});
