// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamOperationSnapshot } from '../apps/web/src/api/team';
import { useAgentEventStream } from '../apps/web/src/api/useAgentEventStream';
import { useTeamOperation } from '../apps/web/src/team/processing/useTeamOperation';
const seams = vi.hoisted(() => ({
  revision: 0,
  channel: vi.fn(),
  getOperation: vi.fn(),
  cancelOperation: vi.fn()
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useOptionalTeam: () => ({ revision: seams.revision })
}));
vi.mock('../apps/web/src/AgentContext', () => ({ useOptionalAgent: () => null }));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: vi.fn() }));
vi.mock('../apps/web/src/api/client', () => ({
  cancelTeamAgentProcess: vi.fn(),
  toolEventUrl: () => 'unused'
}));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: seams }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  getSupabaseClient: () => ({ channel: seams.channel })
}));
vi.mock('../apps/web/src/analytics/errors', () => ({
  teamOperationErrorStage: vi.fn(),
  trackToolError: vi.fn()
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  seams.revision = 0;
});
function snapshot(id: string): TeamOperationSnapshot {
  return { id, state: 'running', kind: 'process' } as TeamOperationSnapshot;
}
it('observes Launch children through the workspace revision without opening a private channel', async () => {
  seams.getOperation.mockResolvedValue(snapshot('child'));
  const { result, rerender } = renderHook(() =>
    useTeamOperation({
      teamId: 'team',
      operationId: 'child',
      agentEnabled: false,
      workspaceObservation: true
    })
  );
  await act(async () => undefined);
  expect(result.current.operation?.id).toBe('child');
  const previousReads = seams.getOperation.mock.calls.length;
  seams.revision += 1;
  rerender();
  await act(async () => undefined);
  expect(seams.getOperation.mock.calls.length).toBeGreaterThan(previousReads);
  expect(seams.channel).not.toHaveBeenCalled();
});
it('ignores a late response for an operation replaced while its read was in flight', async () => {
  const pending: Array<(value: TeamOperationSnapshot) => void> = [];
  seams.getOperation.mockImplementation((_team: string, id: string) =>
    id === 'old' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(snapshot(id))
  );
  const { result, rerender } = renderHook(
    ({ id }) =>
      useTeamOperation({
        teamId: 'team',
        operationId: id,
        agentEnabled: false,
        workspaceObservation: true
      }),
    { initialProps: { id: 'old' } }
  );
  rerender({ id: 'new' });
  await act(async () => undefined);
  expect(result.current.operation?.id).toBe('new');
  await act(async () => {
    pending.forEach(resolve => resolve(snapshot('old')));
  });
  expect(result.current.operation?.id).toBe('new');
});

it('clears stale local progress on disconnect and reconciles the same child when the stream returns', async () => {
  seams.getOperation.mockResolvedValue({ ...snapshot('child'), stage: 'processing', progress: 40 });
  const { result } = renderHook(() =>
    useTeamOperation({ teamId: 'team', operationId: 'child', workspaceObservation: true })
  );
  await act(async () => undefined);
  const stream = () => vi.mocked(useAgentEventStream).mock.calls.at(-1)![0];
  act(() =>
    stream().onMessage({
      type: 'team:operations',
      operations: [
        {
          operationId: 'child',
          state: 'running',
          stage: 'uploading',
          progress: 90,
          errorCode: null,
          updatedAt: '2026-10-16T18:00:00Z'
        }
      ]
    })
  );
  expect(result.current.localProgress).toMatchObject({ stage: 'uploading', progress: 90 });
  act(() => stream().onDisconnect?.('network'));
  expect(result.current.streamDisconnected).toBe(true);
  expect(result.current.localProgress).toBeNull();
  expect(result.current.operation?.state).toBe('running');
  const before = seams.getOperation.mock.calls.length;
  await act(async () => {
    stream().onOpen?.();
  });
  expect(result.current.streamDisconnected).toBe(false);
  expect(seams.getOperation.mock.calls.length).toBeGreaterThan(before);
  expect(result.current.localProgress).toBeNull();
});
