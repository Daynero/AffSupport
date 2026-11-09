// @vitest-environment jsdom
import React, { StrictMode, type PropsWithChildren } from 'react';
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  native: vi.fn(async () => ({ saved: true, fileName: 'qa.mp4', destination: '/test' })),
  cancel: vi.fn(async () => true)
}));
vi.mock('../apps/web/src/api/client', () => ({
  agentCanRestitch: async () => 'yes',
  cancelTeamDownload: mocks.cancel,
  downloadTeamFileWithAgent: vi.fn(),
  toolEventUrl: () => ''
}));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: () => {} }));
vi.mock('../apps/web/src/AgentContext', () => ({ useOptionalAgent: () => null }));
vi.mock('../apps/web/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../apps/web/src/team/errors', () => ({ teamErrorMessageFor: () => 'failed' }));
vi.mock('../apps/web/src/analytics/service', () => ({
  startTeamWorkflow: () => ({ workflowId: 'test' }),
  isTeamWorkflowCurrent: () => true,
  completeTeamWorkflow: vi.fn()
}));
vi.mock('../apps/web/src/analytics/errors', () => ({ trackToolError: vi.fn() }));
vi.mock('../apps/web/src/team/restitch/images', () => ({ ensureRestitchImages: vi.fn() }));
vi.mock('../apps/web/src/team/restitch/screens', () => ({ prepareRestitchScreens: vi.fn() }));
vi.mock('../apps/web/src/team/restitch/native-delivery', () => ({
  nativeManualRestitchSupported: async () => true,
  runNativeManualRestitch: mocks.native
}));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    getRestitchDefaults: async () => ({
      configured: true,
      sourceMode: 'drive',
      operation: 'restitch'
    }),
    getMaterialRestitchPrep: async () => new Map(),
    requestDownload: async () => ({ kind: 'agent', transferUrl: '/test', grant: {} })
  }
}));
import { useRestitchDelivery } from '../apps/web/src/team/restitch/useRestitchDelivery';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('admits a real click after StrictMode replays mounting effects instead of treating it as canceled', async () => {
  const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
  const abort = vi.spyOn(AbortController.prototype, 'abort');
  const { result } = renderHook(() => useRestitchDelivery('team'), {
    wrapper,
    reactStrictMode: true
  });
  expect(abort).toHaveBeenCalled();
  await act(() =>
    result.current.deliver({ materialId: 'video', fileName: 'qa.mp4', driveVersion: null })
  );
  expect(mocks.native).toHaveBeenCalledTimes(1);
  expect(result.current.states.video).toEqual({ kind: 'delivered', fileName: 'qa.mp4' });
});

it('reports a defaults-read failure instead of silently rejecting the delivery click', async () => {
  const { teamApi } = await import('../apps/web/src/api/team');
  const { completeTeamWorkflow } = await import('../apps/web/src/analytics/service');
  const { trackToolError } = await import('../apps/web/src/analytics/errors');
  vi.spyOn(teamApi, 'getRestitchDefaults').mockRejectedValueOnce(Error('DRIVE_UNAVAILABLE'));
  const { result } = renderHook(() => useRestitchDelivery('team'));
  await act(async () => {
    await result.current.deliver({ materialId: 'video', fileName: 'qa.mp4', driveVersion: null });
  });
  expect(result.current.states.video).toEqual({ kind: 'failed', message: 'failed' });
  expect(mocks.native).not.toHaveBeenCalled();
  expect(completeTeamWorkflow).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'failure' })
  );
  expect(trackToolError).toHaveBeenCalledWith(
    expect.objectContaining({ tool: 'team', stage: 'library', workflowId: 'test' })
  );
});
it('shows and cancels a pending defaults read before local preparation can start', async () => {
  const { teamApi } = await import('../apps/web/src/api/team');
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const original = teamApi.getRestitchDefaults;
  vi.spyOn(teamApi, 'getRestitchDefaults').mockImplementationOnce(async team => {
    await pending;
    return original(team);
  });
  const { result } = renderHook(() => useRestitchDelivery('team'));
  let delivery!: Promise<void>;
  await act(async () => {
    delivery = result.current.deliver({
      materialId: 'video',
      fileName: 'qa.mp4',
      driveVersion: null
    });
  });
  expect(result.current.states.video).toMatchObject({ kind: 'running', phase: 'checking' });
  await act(async () => {
    await result.current.cancel('video');
  });
  await act(async () => {
    release();
    await delivery;
  });
  expect(mocks.native).not.toHaveBeenCalled();
  expect(result.current.states.video).toMatchObject({ kind: 'idle' });
});

it('keeps a double click on the same material within one pending configuration read', async () => {
  const { teamApi } = await import('../apps/web/src/api/team');
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const original = teamApi.getRestitchDefaults;
  const read = vi.spyOn(teamApi, 'getRestitchDefaults').mockImplementationOnce(async team => {
    await pending;
    return original(team);
  });
  const { result } = renderHook(() => useRestitchDelivery('team'));
  let first!: Promise<void>;
  await act(async () => {
    first = result.current.deliver({ materialId: 'video', fileName: 'qa.mp4', driveVersion: null });
  });
  await act(async () => {
    await result.current.deliver({ materialId: 'video', fileName: 'qa.mp4', driveVersion: null });
  });
  expect(read).toHaveBeenCalledOnce();
  await act(async () => {
    release();
    await first;
  });
  expect(mocks.native).toHaveBeenCalledOnce();
});
