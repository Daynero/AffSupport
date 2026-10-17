import { launchConfig } from './fixtures/launches';
import { TeamApiError } from '../apps/web/src/api/team';
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LaunchDetail } from '../packages/shared/src/team/launches';
import { useLaunchGeneration } from '../apps/web/src/team/launches/useLaunchGeneration';
import { launchAction } from '../apps/web/src/team/launches/analytics';
const api = vi.hoisted(() => ({
  cancel: vi.fn(),
  cancelRequest: vi.fn(),
  detail: vi.fn(),
  save: vi.fn(),
  generate: vi.fn(),
  retryRestitch: vi.fn(),
  retryGeneration: vi.fn()
}));
const local = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn().mockResolvedValue(true),
  capable: vi.fn().mockResolvedValue('yes')
}));
vi.mock('../apps/web/src/team/launches/restitch-runner', () => ({ runLaunchRestitch: local.run }));
vi.mock('../apps/web/src/api/client', () => ({
  cancelTeamAgentProcess: local.cancel,
  agentCanRestitch: local.capable
}));
vi.mock('../apps/web/src/api/team', () => ({
  launchApi: api,
  TeamApiError: class extends Error {
    constructor(
      public code: string,
      public retryable: boolean
    ) {
      super(code);
    }
  }
}));
vi.mock('../apps/web/src/team/launches/analytics', () => ({
  launchIntent: vi.fn(),
  launchAction: vi.fn(),
  launchLocalStage: vi.fn()
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const detail = { id: 'launch', generation: { id: 'generation' } } as LaunchDetail;
it('retains the cancellation key after an uncertain reply and suppresses duplicate clicks', async () => {
  let fail: (error: Error) => void = () => undefined;
  api.cancel.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      })
  );
  api.cancel.mockResolvedValue(undefined);
  api.detail.mockResolvedValue(detail);
  const resultHandler = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', resultHandler));
  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = result.current.cancel(detail);
    // Install the rejection handler before simulating the network failure.
    void first.catch(() => undefined);
    await result.current.cancel(detail);
  });
  expect(api.cancel).toHaveBeenCalledTimes(1);
  await act(async () => {
    fail(new Error('network unavailable'));
    await expect(first).rejects.toThrow('network unavailable');
  });
  await act(async () => {
    await result.current.cancel(detail);
  });
  expect(api.cancel).toHaveBeenCalledTimes(2);
  expect(api.cancel.mock.calls[1]).toEqual(api.cancel.mock.calls[0]);
  expect(resultHandler).toHaveBeenCalledTimes(1);
  expect(result.current.busy).toBe(false);
});

it('updates the same saved draft after a proven pre-acceptance refusal instead of creating duplicates', async () => {
  api.save
    .mockResolvedValueOnce({ id: 'saved-launch', version: '1' })
    .mockResolvedValueOnce({ id: 'saved-launch', version: '2' });
  api.generate
    .mockRejectedValueOnce(new TeamApiError('NO_WORK', false))
    .mockResolvedValue(undefined);
  api.detail.mockResolvedValue({ id: 'saved-launch', generation: { state: 'succeeded' } });
  const onResult = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', onResult));
  await act(async () => {
    await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toMatchObject({
      code: 'NO_WORK'
    });
  });
  await act(async () => {
    await result.current.generate(null, launchConfig({ creativeAlias: 'v6' }), null, null);
  });
  expect(api.save.mock.calls[0][0]).toMatchObject({ id: null, version: null });
  expect(api.save.mock.calls[1][0]).toMatchObject({ id: 'saved-launch', version: '1' });
  expect(api.generate.mock.calls[1].slice(0, 3)).toEqual(['team', 'saved-launch', '2']);
  expect(onResult).toHaveBeenCalledTimes(1);
});

it('releases a proven wrong-state rejection so catalog setup can be corrected', async () => {
  const config = launchConfig({ method: 'catalog' });
  api.save.mockResolvedValueOnce({ id: 'catalog-launch', version: '1' });
  api.generate.mockRejectedValueOnce(new TeamApiError('WRONG_STATE', false));
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toThrow('WRONG_STATE');
  });
  expect(result.current.hasUnresolvedRequest).toBe(false);
  expect(result.current.busy).toBe(false);
});
it('uses its own saved version after a refused generation of an existing Launch', async () => {
  const config = launchConfig();
  const detail = {
    id: 'existing-launch',
    version: '1',
    draft: config,
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: null
  } satisfies LaunchDetail;
  api.save
    .mockResolvedValueOnce({ id: detail.id, version: '2' })
    .mockResolvedValueOnce({ id: detail.id, version: '3' });
  api.generate.mockRejectedValueOnce(new TeamApiError('NO_WORK', false)).mockResolvedValueOnce({});
  api.detail.mockResolvedValue({ ...detail, version: '3', generation: { state: 'succeeded' } });
  const saved = vi.fn();
  const hook = renderHook(() => useLaunchGeneration('team', vi.fn(), saved));
  await act(async () => {
    await expect(hook.result.current.generate(detail, config, null, '1')).rejects.toThrow(
      'NO_WORK'
    );
  });
  await act(async () => {
    await hook.result.current.generate(detail, { ...config, age: 50 }, null, '1');
  });
  expect(api.save.mock.calls[0][0]).toMatchObject({ id: detail.id, version: '1' });
  expect(api.save.mock.calls[1][0]).toMatchObject({ id: detail.id, version: '2' });
  expect(saved.mock.calls[0][0]).toMatchObject({ id: detail.id, version: '2', config });
});

it('starts the accepted restitch after publishing its progress and cancels only the current child', async () => {
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const pending = {
    id: 'launch',
    draft: config,
    generation: { id: 'generation', state: 'accepted', restitchOperationId: 'child' }
  } as LaunchDetail;
  const canceled = {
    ...pending,
    generation: { ...pending.generation, state: 'cancel_requested' }
  } as LaunchDetail;
  api.save.mockResolvedValue({ id: 'launch', version: '1' });
  api.generate.mockResolvedValue(undefined);
  api.detail.mockResolvedValueOnce(pending).mockResolvedValue(canceled);
  api.cancel.mockResolvedValue(undefined);
  let finish: () => void = () => undefined;
  local.run.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const onResult = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', onResult));
  let generating: Promise<void> = Promise.resolve();
  await act(async () => {
    generating = result.current.generate(null, config, null, null);
  });
  expect(onResult).toHaveBeenCalledWith(pending);
  expect(result.current.busy).toBe(true);
  await act(async () => {
    await result.current.cancel(pending);
  });
  expect(local.cancel).toHaveBeenCalledWith('child');
  await act(async () => {
    finish();
    await generating;
  });
  expect(onResult.mock.calls.at(-1)?.[0]).toEqual(canceled);
  expect(result.current.busy).toBe(false);
});
it('does not send an obsolete callback after the generating surface unmounts', async () => {
  api.save.mockResolvedValue({ id: 'launch', version: '1' });
  let reply: (v: LaunchDetail) => void = () => undefined;
  api.detail.mockImplementationOnce(
    () =>
      new Promise<LaunchDetail>(resolve => {
        reply = resolve;
      })
  );
  const onResult = vi.fn();
  const { result, unmount } = renderHook(() => useLaunchGeneration('team', onResult));
  let running: Promise<void> = Promise.resolve();
  await act(async () => {
    running = result.current.generate(null, launchConfig(), null, null);
  });
  unmount();
  await act(async () => {
    reply({ id: 'launch', generation: { state: 'succeeded' } } as LaunchDetail);
    await running;
  });
  expect(onResult).not.toHaveBeenCalled();
  expect(api.cancel).not.toHaveBeenCalled();
  expect(api.cancelRequest).not.toHaveBeenCalled();
  expect(local.cancel).not.toHaveBeenCalled();
});
it('does not start generation when draft saving finishes after the session was replaced', async () => {
  let reply: (value: { id: string; version: string }) => void = () => undefined;
  api.save.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  const onResult = vi.fn();
  const { result, unmount } = renderHook(() => useLaunchGeneration('team', onResult));
  let running: Promise<void> = Promise.resolve();
  await act(async () => {
    running = result.current.generate(null, launchConfig(), null, null);
  });
  unmount();
  await act(async () => {
    reply({ id: 'launch', version: '1' });
    await running;
  });
  expect(api.generate).not.toHaveBeenCalled();
  expect(local.run).not.toHaveBeenCalled();
  expect(onResult).not.toHaveBeenCalled();
});
it('retains the explicit restitch retry key after an uncertain reply', async () => {
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const failed = {
    id: 'launch',
    draft: config,
    generation: {
      id: 'generation',
      state: 'failed',
      stage: 'restitch_processing',
      requestKey: 'accepted-key',
      inputVersion: '1'
    }
  } as LaunchDetail;
  const pending = {
    ...failed,
    generation: { ...failed.generation, state: 'waiting_dependency' }
  } as LaunchDetail;
  api.retryRestitch
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValue(undefined);
  api.detail.mockResolvedValue(pending);
  local.run.mockResolvedValue(undefined);
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.resume(failed)).rejects.toThrow('network unavailable');
  });
  await act(async () => {
    await result.current.resume(failed);
  });
  expect(api.retryRestitch.mock.calls[1]).toEqual(api.retryRestitch.mock.calls[0]);
  expect(api.generate).not.toHaveBeenCalled();
});
it('preserves success winning a cancellation race instead of stopping its child', async () => {
  api.cancel.mockResolvedValue(undefined);
  const completed = {
    id: 'launch',
    generation: { id: 'generation', state: 'succeeded', restitchOperationId: 'child' }
  } as LaunchDetail;
  api.detail.mockResolvedValue(completed);
  const onResult = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', onResult));
  await act(async () => {
    await result.current.cancel(detail);
  });
  expect(local.cancel).not.toHaveBeenCalled();
  expect(onResult).toHaveBeenCalledWith(completed);
});

it('resumes interrupted catalog work with the same reservation rather than a new generation', async () => {
  const config = launchConfig({ method: 'catalog' });
  const interrupted = {
    id: 'launch',
    draft: config,
    generation: {
      id: 'generation',
      state: 'interrupted',
      stage: 'catalog_creating',
      requestKey: 'original-generation-key',
      inputVersion: '1'
    }
  } as LaunchDetail;
  api.retryGeneration
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValue(undefined);
  api.detail.mockResolvedValue({
    ...interrupted,
    generation: { ...interrupted.generation, state: 'accepted' }
  });
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.resume(interrupted)).rejects.toThrow('network unavailable');
  });
  await act(async () => {
    await result.current.resume(interrupted);
  });
  expect(api.retryGeneration.mock.calls[1]).toEqual(api.retryGeneration.mock.calls[0]);
  expect(api.save).not.toHaveBeenCalled();
  expect(api.generate).toHaveBeenCalledWith('team', 'launch', '1', 'original-generation-key');
});

it('fences cancellation requested while the initial save reply is in flight without starting generation', async () => {
  let resolveSave: (value: { id: string; version: string }) => void = () => {};
  api.save.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveSave = resolve;
      })
  );
  api.cancelRequest.mockResolvedValueOnce({ state: 'canceled' });
  api.detail.mockResolvedValueOnce({ id: 'saved-launch', draft: launchConfig(), generation: null });
  const notify = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', notify));
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.generate(null, launchConfig(), null, null);
    await result.current.cancelPending();
  });
  expect(api.cancelRequest).not.toHaveBeenCalled();
  await act(async () => {
    resolveSave({ id: 'saved-launch', version: '1' });
    await pending;
  });
  expect(api.generate).not.toHaveBeenCalled();
  expect(local.run).not.toHaveBeenCalled();
  expect(api.cancelRequest).toHaveBeenCalledOnce();
  expect(api.cancelRequest.mock.calls[0].slice(0, 2)).toEqual(['team', 'saved-launch']);
  expect(result.current.busy).toBe(false);
  expect(result.current.hasUnresolvedRequest).toBe(false);
  expect(notify).toHaveBeenCalledOnce();
});

it('replays the same preaccept cancellation after a lost reply without retrying generation', async () => {
  api.save.mockResolvedValueOnce({ id: 'lost-cancel-launch', version: '1' });
  api.generate.mockRejectedValueOnce(new Error('lost acceptance reply'));
  api.cancelRequest
    .mockRejectedValueOnce(new Error('lost cancel reply'))
    .mockResolvedValueOnce({ state: 'canceled' });
  api.detail.mockResolvedValueOnce({
    id: 'lost-cancel-launch',
    draft: launchConfig(),
    generation: null
  });
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toThrow(
      'lost acceptance reply'
    );
  });
  await act(async () => {
    await expect(result.current.cancelPending()).rejects.toThrow('lost cancel reply');
  });
  expect(result.current.hasUnresolvedRequest).toBe(true);
  await act(async () => {
    await result.current.cancelPending();
  });
  expect(api.cancelRequest.mock.calls.at(-1)).toEqual(api.cancelRequest.mock.calls.at(-2));
  expect(result.current.hasUnresolvedRequest).toBe(false);
  expect(api.generate).toHaveBeenCalledOnce();
});

it('releases a refused request when re-stitch settings are missing, preserving the editable saved draft', async () => {
  api.save
    .mockResolvedValueOnce({ id: 'settings-launch', version: '1' })
    .mockResolvedValueOnce({ id: 'settings-launch', version: '2' });
  api.generate
    .mockRejectedValueOnce(new TeamApiError('RESTITCH_INVALID', false))
    .mockResolvedValueOnce({});
  api.detail.mockResolvedValueOnce({ id: 'settings-launch', generation: null });
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toMatchObject({
      code: 'RESTITCH_INVALID'
    });
  });
  expect(result.current.busy).toBe(false);
  expect(result.current.hasUnresolvedRequest).toBe(false);
  expect(launchAction).toHaveBeenCalledWith(
    expect.objectContaining({ launchId: 'settings-launch' }),
    'generate',
    'failure',
    'RESTITCH_INVALID'
  );
  await act(async () => {
    await result.current.generate(null, launchConfig({ creativeAlias: 'corrected' }), null, null);
  });
  expect(api.save.mock.calls.at(-1)?.[0]).toMatchObject({
    id: 'settings-launch',
    version: '1',
    config: { creativeAlias: 'corrected' }
  });
  expect(api.generate.mock.calls[0][3]).not.toBe(api.generate.mock.calls[1][3]);
});

it.each(['SOURCE_CHANGED', 'RESTITCH_INVALID'] as const)(
  'does not forget acceptance when restitch preparation subsequently rejects with %s',
  async code => {
    const config = launchConfig({
      method: 'catalog',
      catalog: {
        productCount: 100,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 120
      }
    });
    api.save.mockResolvedValueOnce({ id: 'accepted-launch', version: '1' });
    api.generate.mockResolvedValueOnce({});
    api.detail.mockResolvedValueOnce({
      id: 'accepted-launch',
      draft: config,
      generation: { id: 'accepted-generation', state: 'accepted' }
    });
    local.run.mockRejectedValueOnce(new TeamApiError(code, false));
    const notify = vi.fn();
    const { result } = renderHook(() => useLaunchGeneration('team', notify));
    await act(async () => {
      await expect(result.current.generate(null, config, null, null)).rejects.toThrow(code);
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(result.current.hasUnresolvedRequest).toBe(true);
    expect(api.save).toHaveBeenCalledOnce();
    expect(api.generate).toHaveBeenCalledOnce();
  }
);

it('releases a hung save reply as uncertain and replays the same saved intent without late side effects', async () => {
  vi.useFakeTimers();
  try {
    let resolve: (value: { id: string; version: string }) => void = () => {};
    api.save
      .mockImplementationOnce(
        () =>
          new Promise(done => {
            resolve = done;
          })
      )
      .mockResolvedValueOnce({ id: 'late-save', version: '1' });
    api.generate.mockResolvedValueOnce({});
    api.detail.mockResolvedValueOnce({ id: 'late-save', generation: null });
    const notify = vi.fn();
    const { result } = renderHook(() => useLaunchGeneration('team', notify));
    let pending: Promise<void> = Promise.resolve();
    let rejection: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.generate(null, launchConfig(), null, null);
      rejection = expect(pending).rejects.toMatchObject({
        code: 'LAUNCH_RESULT_UNCERTAIN',
        retryable: true
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.hasUnresolvedRequest).toBe(true);
    await act(async () => {
      resolve({ id: 'late-save', version: '1' });
    });
    expect(api.generate).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.generate(null, launchConfig(), null, null);
    });
    expect(api.save.mock.calls.at(-1)).toEqual(api.save.mock.calls.at(-2));
    expect(api.generate).toHaveBeenCalledOnce();
    expect(result.current.hasUnresolvedRequest).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('reconciles a lost acceptance reply by its exact request key without restarting work on a status read', async () => {
  vi.useFakeTimers();
  try {
    api.save.mockResolvedValueOnce({ id: 'uncertain-launch', version: '1' });
    api.generate.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
    let rejection: Promise<unknown> = Promise.resolve();
    await act(async () => {
      rejection = expect(
        result.current.generate(null, launchConfig(), null, null)
      ).rejects.toMatchObject({ code: 'LAUNCH_RESULT_UNCERTAIN' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.hasUnresolvedRequest).toBe(true);
    const receipt = {
      id: 'uncertain-launch',
      generation: { id: 'generation', requestKey: 'different', state: 'accepted' }
    } as LaunchDetail;
    act(() => {
      expect(result.current.observe(receipt)).toBe(false);
    });
    expect(result.current.hasUnresolvedRequest).toBe(true);
    act(() => {
      expect(
        result.current.observe({
          ...receipt,
          generation: { ...receipt.generation!, requestKey: api.generate.mock.calls.at(-1)?.[3] }
        })
      ).toBe(true);
    });
    expect(result.current.hasUnresolvedRequest).toBe(false);
    expect(result.current.pendingStage).toBeNull();
    expect(api.generate).toHaveBeenCalledOnce();
    expect(local.run).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('does not apply a network reply deadline to real native video work', async () => {
  vi.useFakeTimers();
  try {
    let finish: () => void = () => {};
    const config = launchConfig({
      method: 'catalog',
      catalog: {
        productCount: 3,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 120
      }
    });
    api.save.mockResolvedValueOnce({ id: 'native-launch', version: '1' });
    api.generate.mockResolvedValueOnce({});
    api.detail
      .mockResolvedValueOnce({
        id: 'native-launch',
        draft: config,
        generation: { id: 'native-generation', state: 'accepted' }
      })
      .mockResolvedValueOnce({
        id: 'native-launch',
        draft: config,
        generation: { id: 'native-generation', state: 'succeeded' }
      });
    local.run.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.generate(null, config, null, null);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(result.current.busy).toBe(true);
    expect(local.run).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await pending;
    });
    expect(result.current.busy).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('releases a confirmed terminal receipt even when the old native reply is lost, and ignores its late completion', async () => {
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 3,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  api.save.mockResolvedValue({ id: 'terminal-launch', version: '1' });
  api.generate.mockResolvedValue({});
  api.detail.mockResolvedValue({
    id: 'terminal-launch',
    draft: config,
    generation: { id: 'terminal-generation', state: 'accepted' }
  });
  let finish: () => void = () => {};
  local.run.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const notify = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', notify));
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.generate(null, config, null, null);
  });
  expect(result.current.busy).toBe(true);
  act(() => {
    result.current.observe({
      id: 'terminal-launch',
      generation: {
        id: 'terminal-generation',
        state: 'succeeded',
        requestKey: api.generate.mock.calls.at(-1)?.[3]
      }
    } as LaunchDetail);
  });
  expect(result.current.busy).toBe(false);
  expect(result.current.hasUnresolvedRequest).toBe(false);
  const delivered = notify.mock.calls.length;
  await act(async () => {
    await pending;
  });
  await act(async () => {
    finish();
  });
  expect(notify).toHaveBeenCalledTimes(delivered);
  expect(api.detail).toHaveBeenCalledOnce();
});

it('does not let realtime acceptance arriving before the POST reply skip the native workflow', async () => {
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 3,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  api.save.mockResolvedValueOnce({ id: 'early-launch', version: '1' });
  let accept: (value: unknown) => void = () => {};
  api.generate.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        accept = resolve;
      })
  );
  const accepted = {
    id: 'early-launch',
    draft: config,
    generation: { id: 'early-generation', state: 'accepted', requestKey: '' }
  } as LaunchDetail;
  api.detail.mockImplementation(async () => accepted);
  local.run.mockResolvedValueOnce({});
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.generate(null, config, null, null);
  });
  accepted.generation!.requestKey = api.generate.mock.calls.at(-1)?.[3];
  act(() => {
    result.current.observe(accepted);
  });
  expect(result.current.hasUnresolvedRequest).toBe(true);
  await act(async () => {
    accept({});
    await pending;
  });
  expect(local.run).toHaveBeenCalledOnce();
});

it('releases a terminal receipt before the POST reply and never starts work from its late reply', async () => {
  api.save.mockResolvedValueOnce({ id: 'early-terminal', version: '1' });
  let accept: (value: unknown) => void = () => {};
  api.generate.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        accept = resolve;
      })
  );
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.generate(null, launchConfig(), null, null);
  });
  act(() => {
    result.current.observe({
      id: 'early-terminal',
      generation: {
        id: 'generation',
        state: 'canceled',
        requestKey: api.generate.mock.calls.at(-1)?.[3]
      }
    } as LaunchDetail);
  });
  await act(async () => {
    await pending;
  });
  expect(result.current.busy).toBe(false);
  expect(result.current.hasUnresolvedRequest).toBe(false);
  await act(async () => {
    accept({});
  });
  expect(api.detail).not.toHaveBeenCalled();
  expect(local.run).not.toHaveBeenCalled();
});
