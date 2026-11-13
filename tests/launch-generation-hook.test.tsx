import type {
  CatalogForegroundBinding,
  CatalogForegroundExecutor
} from '../apps/web/src/api/catalog-video-foreground';
import { launchConfig } from './fixtures/launches';
import { TeamApiError } from '../apps/web/src/api/team';
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LaunchDetail } from '../packages/shared/src/team/launches';
import { useLaunchGeneration } from '../apps/web/src/team/launches/useLaunchGeneration';
import { launchAction } from '../apps/web/src/team/launches/analytics';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
const foreground = vi.hoisted(() => ({
  prepare: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined)
}));
vi.mock('../apps/web/src/api/catalog-video-foreground-client', async () => {
  const { admitCatalogForeground } = await import('../apps/web/src/api/catalog-video-foreground');
  return {
    catalogForeground: {
      ...foreground,
      admit: <T,>(
        binding: CatalogForegroundBinding,
        run: (executor: CatalogForegroundExecutor | undefined) => Promise<T>,
        signal?: AbortSignal,
        prepared?: CatalogForegroundExecutor
      ) =>
        admitCatalogForeground({
          prepare: async () =>
            prepared ??
            ((await foreground.prepare(binding, signal)) as CatalogForegroundExecutor | undefined),
          admit: run,
          current: () => {
            if (signal?.aborted) throw Error('PROCESS_CANCELED');
          }
        })
    }
  };
});
const api = vi.hoisted(() => ({
  cancel: vi.fn(),
  cancelCatalogVideoGeneration: vi.fn(),
  cancelRequest: vi.fn(),
  detail: vi.fn(),
  save: vi.fn(),
  generate: vi.fn(),
  retryRestitch: vi.fn(),
  retryGeneration: vi.fn(),
  cancelOperation: vi.fn(),
  settleRestitch: vi.fn()
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
  teamApi: api,
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
  setPrivateCacheScope(null, 'signed-out');
});
const detail = { id: 'launch', generation: { id: 'generation' } } as LaunchDetail;
const createdWithVideoPending = {
  ...detail,
  generation: {
    ...detail.generation,
    state: 'succeeded',
    videoGeneration: {
      setId: '47000000-0000-4000-8000-000000000001',
      requestedCount: 5,
      registeredCount: 2,
      state: 'preparing',
      activeChildOperationId: 'child'
    }
  }
} as LaunchDetail;
it('cancels only remaining videos after catalog success and keeps the original cancel key on a lost reply', async () => {
  api.cancelCatalogVideoGeneration
    .mockRejectedValueOnce(new Error('lost reply'))
    .mockResolvedValueOnce({ state: 'cancel_requested' });
  const latest = {
    ...createdWithVideoPending,
    generation: {
      ...createdWithVideoPending.generation!,
      videoGeneration: {
        ...createdWithVideoPending.generation!.videoGeneration!,
        state: 'cancel_requested'
      }
    }
  } as LaunchDetail;
  api.detail.mockResolvedValue(latest);
  const notify = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', notify));
  await act(async () => {
    await expect(result.current.cancel(createdWithVideoPending)).rejects.toThrow('lost reply');
  });
  await act(async () => {
    await result.current.cancel(createdWithVideoPending);
  });
  expect(api.cancelCatalogVideoGeneration).toHaveBeenCalledTimes(2);
  expect(api.cancelCatalogVideoGeneration.mock.calls[1]).toEqual(
    api.cancelCatalogVideoGeneration.mock.calls[0]
  );
  expect(api.cancel).not.toHaveBeenCalled();
  expect(local.cancel).toHaveBeenCalledWith('child');
  expect(notify).toHaveBeenCalledWith(latest);
  expect(latest.generation?.state).toBe('succeeded');
});
it('does not apply a post-created video cancellation reply to a replacement actor', async () => {
  setPrivateCacheScope('47000000-0000-4000-8000-000000000001', 'owner');
  let resolve!: (value: unknown) => void;
  api.cancelCatalogVideoGeneration.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r;
      })
  );
  const notify = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', notify));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.cancel(createdWithVideoPending);
  });
  await act(async () => {
    setPrivateCacheScope('47000000-0000-4000-8000-000000000002', 'viewer');
    resolve({ state: 'cancel_requested' });
    await pending;
  });
  expect(notify).not.toHaveBeenCalled();
  expect(local.cancel).not.toHaveBeenCalled();
});
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

it.each(['WRONG_STATE', 'AGENT_REQUIRED'] as const)(
  'releases a proven %s rejection so catalog setup can be corrected',
  async code => {
    const config = launchConfig({ method: 'catalog' });
    api.save.mockResolvedValueOnce({ id: 'catalog-launch', version: '1' });
    api.generate.mockRejectedValueOnce(new TeamApiError(code, false));
    const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
    await act(async () => {
      await expect(result.current.generate(null, config, null, null)).rejects.toThrow(code);
    });
    expect(result.current.hasUnresolvedRequest).toBe(false);
    expect(result.current.busy).toBe(false);
  }
);
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
  api.cancelRequest.mockResolvedValue({ state: 'cancel_requested', detail: canceled });
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
    await result.current.cancelPending();
  });
  expect(local.cancel).toHaveBeenCalledWith('child');
  expect(api.detail).toHaveBeenCalledOnce();
  expect(api.cancel).not.toHaveBeenCalled();
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
it('keeps generating when the same account refreshes its access while the draft is saving', async () => {
  // A realtime membership signal or a teams re-read re-keys the private cache
  // epoch for the same person. That must not abort a Launch with a false
  // PERMISSION_DENIED (1.4.2, "Запуск не почався — У вас немає дозволу").
  const actor = '47000000-0000-4000-8000-000000000001';
  setPrivateCacheScope(actor, 'access-a');
  let reply: (value: { id: string; version: string }) => void = () => undefined;
  api.save.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  api.generate.mockResolvedValue(undefined);
  api.detail.mockResolvedValue({ id: 'launch', generation: { state: 'succeeded' } });
  const onResult = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', onResult));
  let running: Promise<void> = Promise.resolve();
  await act(async () => {
    running = result.current.generate(null, launchConfig(), null, null);
  });
  setPrivateCacheScope(actor, 'access-b');
  await act(async () => {
    reply({ id: 'launch', version: '1' });
    await running;
  });
  expect(api.generate).toHaveBeenCalledTimes(1);
  expect(onResult).toHaveBeenCalledTimes(1);
});

it('refuses to finish a Launch under another account that signed in mid-request', async () => {
  setPrivateCacheScope('47000000-0000-4000-8000-000000000001', 'access-a');
  let reply: (value: { id: string; version: string }) => void = () => undefined;
  api.save.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  const onResult = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', onResult));
  let running: Promise<void> = Promise.resolve();
  await act(async () => {
    running = result.current.generate(null, launchConfig(), null, null);
  });
  setPrivateCacheScope('47000000-0000-4000-8000-000000000002', 'access-a');
  await act(async () => {
    reply({ id: 'launch', version: '1' });
    await running.catch(() => undefined);
  });
  expect(api.generate).not.toHaveBeenCalled();
  expect(onResult).not.toHaveBeenCalled();
});

it('finishes an accepted restitch after the detail modal closes', async () => {
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const accepted = {
    id: 'launch',
    draft: config,
    generation: { id: 'generation', state: 'accepted' }
  } as LaunchDetail;
  let finish: () => void = () => undefined;
  api.save.mockResolvedValue({ id: 'launch', version: '1' });
  api.generate.mockResolvedValue({});
  api.detail.mockResolvedValueOnce(accepted).mockResolvedValueOnce({
    ...accepted,
    generation: { ...accepted.generation!, state: 'succeeded' }
  });
  local.run.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () => resolve({ operationId: 'child' });
      })
  );
  const onResult = vi.fn();
  const hook = renderHook(() => useLaunchGeneration('team', onResult));
  let running: Promise<void> = Promise.resolve();
  act(() => {
    running = hook.result.current.generate(null, config, null, null);
  });
  await waitFor(() => expect(local.run).toHaveBeenCalledOnce());
  hook.unmount();
  await act(async () => {
    finish();
    await running;
  });
  expect(api.detail).toHaveBeenCalledTimes(2);
  expect(onResult).toHaveBeenCalledTimes(1);
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
it('retries a Drive failure already settled from a stale waiting snapshot in one click', async () => {
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  const waiting = {
    id: 'launch',
    draft: config,
    generation: {
      id: 'generation',
      state: 'waiting_dependency',
      stage: 'restitch_processing',
      requestKey: 'accepted-key',
      inputVersion: '1'
    }
  } as LaunchDetail;
  const failed = {
    ...waiting,
    generation: { ...waiting.generation!, state: 'failed', errorCode: 'DRIVE_UNAVAILABLE' }
  } as LaunchDetail;
  api.settleRestitch.mockResolvedValue(true);
  api.detail.mockResolvedValueOnce(failed).mockResolvedValue({
    ...waiting,
    generation: { ...waiting.generation!, stage: 'restitch_preparing' }
  });
  api.retryRestitch.mockResolvedValue(undefined);
  local.run.mockResolvedValue(undefined);
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await result.current.resume(waiting);
  });
  expect(api.settleRestitch).toHaveBeenCalledWith('team', 'generation');
  expect(api.retryRestitch).toHaveBeenCalledOnce();
  expect(local.run).toHaveBeenCalledOnce();
  expect(api.generate).not.toHaveBeenCalled();
});

it('turns Repeat after a lost acceptance reply into retry of the failed generation, without saving a duplicate', async () => {
  const config = launchConfig({ method: 'catalog' });
  api.save.mockResolvedValue({ id: 'launch', version: '1' });
  api.generate
    .mockRejectedValueOnce(new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true))
    .mockResolvedValue(undefined);
  api.retryGeneration.mockResolvedValue(undefined);
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toMatchObject({
      code: 'LAUNCH_RESULT_UNCERTAIN'
    });
  });
  const key = api.generate.mock.calls[0][3];
  const failed = {
    id: 'launch',
    draft: config,
    generation: {
      id: 'generation',
      state: 'interrupted',
      stage: 'catalog_creating',
      requestKey: key,
      inputVersion: '1',
      errorCode: 'DRIVE_UNAVAILABLE'
    }
  } as LaunchDetail;
  api.detail.mockResolvedValueOnce(failed).mockResolvedValue({
    ...failed,
    generation: { ...failed.generation!, state: 'accepted' }
  });
  await act(async () => {
    await result.current.retry(null, config, null, null);
  });
  expect(api.retryGeneration).toHaveBeenCalledOnce();
  expect(api.generate).toHaveBeenLastCalledWith('team', 'launch', '1', key);
  expect(api.save).toHaveBeenCalledOnce();
  expect(result.current.hasUnresolvedRequest).toBe(false);
});

it('keeps the original request when Repeat cannot reconcile, and fences duplicate clicks', async () => {
  const config = launchConfig();
  api.save.mockResolvedValue({ id: 'retry-launch', version: '1' });
  // An uncertain (lost) reply, not a transient refusal: that one is now sent again by itself.
  api.generate
    .mockRejectedValueOnce(new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true))
    .mockResolvedValue(undefined);
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toMatchObject({
      code: 'LAUNCH_RESULT_UNCERTAIN'
    });
  });
  const original = api.generate.mock.calls[0];
  let rejectRead!: (error: Error) => void;
  api.detail.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      })
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.retry(null, config, null, null);
    void pending.catch(() => undefined);
    await result.current.retry(null, config, null, null);
  });
  expect(api.detail).toHaveBeenCalledOnce();
  await act(async () => {
    rejectRead(new TeamApiError('DRIVE_UNAVAILABLE', true));
    await expect(pending).rejects.toMatchObject({ code: 'DRIVE_UNAVAILABLE' });
  });
  expect(result.current.hasUnresolvedRequest).toBe(true);
  api.detail
    .mockResolvedValueOnce({ id: 'retry-launch', draft: config, generation: null })
    .mockResolvedValue({
      id: 'retry-launch',
      draft: config,
      generation: {
        id: 'generation',
        state: 'succeeded',
        requestKey: original[3]
      }
    });
  await act(async () => {
    await result.current.retry(null, config, null, null);
  });
  expect(api.generate.mock.calls[1]).toEqual(original);
  expect(api.save).toHaveBeenCalledOnce();
});

it.each(['succeeded', 'canceled'] as const)(
  'does not restart a waiting generation already %s',
  async state => {
    const waiting = {
      id: 'launch',
      draft: launchConfig(),
      generation: {
        id: 'generation',
        state: 'waiting_dependency',
        requestKey: 'key',
        inputVersion: '1'
      }
    } as LaunchDetail;
    api.settleRestitch.mockResolvedValue(true);
    const terminal = { ...waiting, generation: { ...waiting.generation!, state } } as LaunchDetail;
    api.detail.mockResolvedValue(terminal);
    const notify = vi.fn();
    const { result } = renderHook(() => useLaunchGeneration('team', notify));
    await act(async () => {
      await result.current.resume(waiting);
    });
    expect(api.retryRestitch).not.toHaveBeenCalled();
    expect(api.retryGeneration).not.toHaveBeenCalled();
    expect(api.generate).not.toHaveBeenCalled();
    expect(local.run).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(terminal);
  }
);

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
  api.detail.mockResolvedValueOnce({
    id: 'settings-launch',
    generation: { id: 'generation', state: 'succeeded' }
  });
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
    api.detail.mockResolvedValueOnce({
      id: 'late-save',
      generation: { id: 'generation', state: 'succeeded' }
    });
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

it('starts native cancellation immediately after acceptance and never waits for its reply', async () => {
  api.cancel.mockResolvedValue({ id: 'generation', state: 'cancel_requested' });
  let read!: (value: LaunchDetail) => void;
  api.detail.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        read = resolve;
      })
  );
  local.cancel.mockImplementationOnce(() => new Promise(() => {}));
  const current = {
    id: 'launch',
    generation: { id: 'generation', state: 'waiting_dependency', restitchOperationId: 'child' }
  } as LaunchDetail;
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  let work!: Promise<void>;
  act(() => {
    work = result.current.cancel(current);
  });
  await waitFor(() => expect(local.cancel).toHaveBeenCalledWith('child'));
  expect(result.current.pendingStage).toBe('cancel');
  await act(async () => {
    read({ ...current, generation: { ...current.generation!, state: 'cancel_requested' } });
    await work;
  });
  expect(result.current.busy).toBe(false);
});

it('explicitly retires a locally failed legacy child before choosing a new restitch attempt', async () => {
  const config = launchConfig({ method: 'catalog' });
  config.catalog.restitchEnabled = true;
  const current = {
    id: 'launch',
    draft: config,
    generation: {
      id: 'generation',
      requestKey: 'request',
      inputVersion: '1',
      state: 'waiting_dependency',
      stage: 'restitch_processing',
      restitchOperationId: 'child'
    }
  } as LaunchDetail;
  api.cancelOperation.mockResolvedValue({ state: 'canceled' });
  api.settleRestitch.mockResolvedValue(true);
  api.detail.mockResolvedValue({
    ...current,
    generation: { ...current.generation!, state: 'failed' }
  });
  api.retryRestitch.mockResolvedValue(undefined);
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await result.current.resume(current, 'child');
  });
  expect(api.cancelOperation).toHaveBeenCalledWith('team', 'child');
  expect(api.cancelOperation.mock.invocationCallOrder.at(-1)).toBeLessThan(
    api.settleRestitch.mock.invocationCallOrder.at(-1)!
  );
  expect(api.retryRestitch).toHaveBeenCalledWith('team', 'generation', expect.any(String));
});

it('uses cancellation readback from the receipt without another network request', async () => {
  const canceled = {
    id: 'launch',
    generation: { id: 'generation', state: 'cancel_requested', restitchOperationId: 'child' }
  } as LaunchDetail;
  api.cancel.mockResolvedValueOnce({
    id: 'generation',
    state: 'cancel_requested',
    detail: canceled
  });
  const notify = vi.fn();
  const { result } = renderHook(() => useLaunchGeneration('team', notify));
  await act(async () => {
    await result.current.cancel({
      ...canceled,
      generation: { ...canceled.generation!, state: 'waiting_dependency' }
    });
  });
  expect(api.detail).not.toHaveBeenCalled();
  expect(local.cancel).toHaveBeenCalledExactlyOnceWith('child');
  expect(notify).toHaveBeenCalledWith(canceled);
});

it.each(['cancel_requested', 'canceled_with_cleanup_pending'] as const)(
  'does not report a no-op retry as success during %s',
  async state => {
    const current = {
      id: 'launch',
      generation: { id: 'generation', requestKey: 'request', inputVersion: '1', state }
    } as LaunchDetail;
    const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
    await expect(result.current.resume(current)).rejects.toMatchObject({ code: 'LAUNCH_BUSY' });
    expect(api.generate).not.toHaveBeenCalled();
    expect(launchAction).not.toHaveBeenCalledWith(expect.anything(), 'retry', 'success');
  }
);

it('never cancels a newer child when replay readback belongs to another generation', async () => {
  api.save.mockResolvedValueOnce({ id: 'launch', version: '1' });
  api.generate.mockRejectedValueOnce(new Error('lost acceptance reply'));
  const newer = {
    id: 'launch',
    generation: {
      id: 'newer-generation',
      state: 'cancel_requested',
      restitchOperationId: 'newer-child'
    }
  } as LaunchDetail;
  api.cancelRequest.mockResolvedValueOnce({
    id: 'original-generation',
    state: 'canceled',
    detail: newer
  });
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toThrow(
      'lost acceptance reply'
    );
  });
  await act(async () => {
    await result.current.cancelPending();
  });
  expect(local.cancel).not.toHaveBeenCalled();
});

it.each(['canceled', 'succeeded'] as const)(
  'reconciles a lost cancellation reply from an exact authoritative %s receipt',
  async state => {
    api.save.mockResolvedValueOnce({ id: 'cancel-observed', version: '1' });
    api.generate.mockRejectedValueOnce(new Error('lost acceptance'));
    api.cancelRequest.mockRejectedValueOnce(new Error('lost cancellation'));
    const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
    await act(async () => {
      await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toThrow(
        'lost acceptance'
      );
    });
    await act(async () => {
      await expect(result.current.cancelPending()).rejects.toThrow('lost cancellation');
    });
    act(() => {
      result.current.observe({
        id: 'cancel-observed',
        version: '2',
        generation: {
          id: 'generation',
          state,
          stateVersion: '2',
          requestKey: api.generate.mock.calls.at(-1)?.[3]
        }
      } as LaunchDetail);
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.hasUnresolvedRequest).toBe(false);
    expect(result.current.pendingStage).toBe(null);
    expect(api.generate).toHaveBeenCalledOnce();
    expect(api.cancelRequest).toHaveBeenCalledOnce();
  }
);

it.each([
  'cancel_requested',
  'canceled_with_cleanup_pending',
  'wrong-key',
  'wrong-id',
  'stale',
  'actor',
  'team'
])('retains uncertain cancellation for %s observations', async scenario => {
  setPrivateCacheScope('actor-a', 'team');
  api.save.mockResolvedValueOnce({ id: 'cancel-fenced', version: '1' });
  api.generate.mockRejectedValueOnce(new Error('lost acceptance'));
  api.cancelRequest.mockRejectedValueOnce(new Error('lost cancellation'));
  const { result, rerender } = renderHook(({ team }) => useLaunchGeneration(team, vi.fn()), {
    initialProps: { team: 'team' }
  });
  await act(async () => {
    await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toThrow();
  });
  await act(async () => {
    await expect(result.current.cancelPending()).rejects.toThrow();
  });
  const receipt = {
    id: 'cancel-fenced',
    version: '2',
    generation: {
      id: 'generation',
      state: 'cancel_requested',
      stateVersion: '2',
      requestKey: api.generate.mock.calls.at(-1)?.[3]
    }
  } as LaunchDetail;
  act(() => {
    result.current.observe(receipt);
  });
  if (scenario === 'actor') setPrivateCacheScope('actor-b', 'team');
  if (scenario === 'team') rerender({ team: 'other-team' });
  act(() => {
    result.current.observe({
      ...receipt,
      id: scenario === 'wrong-id' ? 'other' : receipt.id,
      version: scenario === 'stale' ? '1' : '3',
      generation: {
        ...receipt.generation!,
        state: ['cancel_requested', 'canceled_with_cleanup_pending'].includes(scenario)
          ? scenario
          : 'canceled',
        requestKey: scenario === 'wrong-key' ? 'other' : receipt.generation!.requestKey
      }
    } as LaunchDetail);
  });
  expect(result.current.hasUnresolvedRequest).toBe(true);
  expect(result.current.busy).toBe(false);
  expect(api.generate).toHaveBeenCalledOnce();
  expect(api.cancelRequest).toHaveBeenCalledOnce();
});

it('applies the authoritative canceled receipt after the same account refreshes its access', async () => {
  setPrivateCacheScope('actor-a', 'team');
  api.save.mockResolvedValueOnce({ id: 'cancel-fenced', version: '1' });
  api.generate.mockRejectedValueOnce(new Error('lost acceptance'));
  api.cancelRequest.mockRejectedValueOnce(new Error('lost cancellation'));
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toThrow();
  });
  await act(async () => {
    await expect(result.current.cancelPending()).rejects.toThrow();
  });
  const requestKey = api.generate.mock.calls.at(-1)?.[3];
  setPrivateCacheScope('actor-a', 'different-access');
  act(() => {
    result.current.observe({
      id: 'cancel-fenced',
      version: '3',
      generation: { id: 'generation', state: 'canceled', stateVersion: '3', requestKey }
    } as LaunchDetail);
  });
  expect(result.current.hasUnresolvedRequest).toBe(false);
  expect(api.generate).toHaveBeenCalledOnce();
});

it('freezes paired-session enrollment with the original Launch request across lost acceptance and cancellation', async () => {
  const config = launchConfig({ method: 'catalog' });
  config.catalog.catalogVideoProtocolVersion = 1;
  config.catalog.restitchEnabled = true;
  const proof = {
    protocolVersion: 1 as const,
    enrollmentId: '47000000-0000-4000-8000-000000000004',
    nativeInstanceId: '47000000-0000-4000-8000-000000000005',
    proofDigest: 'a'.repeat(64)
  };
  foreground.prepare.mockResolvedValueOnce(proof);
  api.save.mockResolvedValueOnce({ id: 'paired-launch', version: '7' });
  api.generate.mockRejectedValueOnce(new Error('lost acceptance'));
  api.cancelRequest.mockResolvedValueOnce({
    state: 'canceled',
    detail: { id: 'paired-launch', generation: null }
  });
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toThrow(
      'lost acceptance'
    );
  });
  const original = api.generate.mock.calls.at(-1)!;
  expect(original).toEqual(['team', 'paired-launch', '7', expect.any(String), undefined, proof]);
  expect(foreground.prepare).toHaveBeenLastCalledWith(
    {
      kind: 'launch',
      teamId: 'team',
      launchId: 'paired-launch',
      sourceMaterialId: config.materialId,
      requestKey: original[3],
      expectedVersion: '7'
    },
    expect.any(AbortSignal)
  );
  await act(async () => {
    await result.current.cancelPending();
  });
  expect(api.generate).toHaveBeenCalledOnce();
  expect(foreground.prepare).toHaveBeenCalledOnce();
  expect(result.current.hasUnresolvedRequest).toBe(false);
});

it('does not replay or cancel a previous actor pending admission after a scope replacement', async () => {
  setPrivateCacheScope('actor-original', 'team');
  api.save.mockResolvedValueOnce({ id: 'scope-launch', version: '1' });
  api.generate.mockRejectedValueOnce(new Error('lost acceptance'));
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, launchConfig(), null, null)).rejects.toThrow(
      'lost acceptance'
    );
  });
  setPrivateCacheScope('actor-replacement', 'team');
  await expect(result.current.retry(null, launchConfig(), null, null)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  await expect(result.current.cancelPending()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(api.generate).toHaveBeenCalledOnce();
  expect(api.detail).not.toHaveBeenCalled();
  expect(api.cancelRequest).not.toHaveBeenCalled();
});

it.each(['prepare', 'generate'] as const)(
  'does not continue browser admission after actor changes during %s',
  async stage => {
    setPrivateCacheScope('actor-original', 'team');
    const config = launchConfig({ method: 'catalog' });
    config.catalog.catalogVideoProtocolVersion = 1;
    config.catalog.restitchEnabled = true;
    api.save.mockResolvedValueOnce({ id: 'pending-owner', version: '1' });
    let finish!: (value: unknown) => void;
    const waiting = new Promise(resolve => {
      finish = resolve;
    });
    if (stage === 'prepare') foreground.prepare.mockImplementationOnce(() => waiting);
    else {
      foreground.prepare.mockResolvedValueOnce(undefined);
      api.generate.mockImplementationOnce(() => waiting);
    }
    const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
    let work!: Promise<void>;
    act(() => {
      work = result.current.generate(null, config, null, null);
    });
    await waitFor(() =>
      expect(stage === 'prepare' ? foreground.prepare : api.generate).toHaveBeenCalled()
    );
    setPrivateCacheScope('actor-new', 'team');
    await act(async () => {
      finish(
        stage === 'prepare'
          ? {
              protocolVersion: 1,
              enrollmentId: 'enroll',
              nativeInstanceId: 'boot',
              proofDigest: 'digest'
            }
          : {}
      );
      await expect(work).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });
    expect(api.generate).toHaveBeenCalledTimes(stage === 'prepare' ? 0 : 1);
    expect(api.detail).not.toHaveBeenCalled();
    expect(result.current.hasUnresolvedRequest).toBe(true);
  }
);

it('unlocks a saved Launch after failed native preparation and a proved canonical refusal', async () => {
  setPrivateCacheScope('actor-original', 'team');
  const config = launchConfig({ method: 'catalog' });
  config.catalog.catalogVideoProtocolVersion = 1;
  config.catalog.restitchEnabled = true;
  api.save.mockResolvedValueOnce({ id: 'local-prepare', version: '3' });
  foreground.prepare.mockRejectedValueOnce(Error('AGENT_UPDATE_REQUIRED'));
  api.generate.mockRejectedValueOnce(new TeamApiError('AGENT_REQUIRED', false));
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toThrow(
      'AGENT_UPDATE_REQUIRED'
    );
  });
  expect(api.generate).toHaveBeenCalledOnce();
  expect(result.current.hasUnresolvedRequest).toBe(false);
  expect(result.current.busy).toBe(false);
  expect(result.current.pendingStage).toBe(null);
  expect(launchAction).toHaveBeenCalledWith(
    expect.objectContaining({ launchId: 'local-prepare' }),
    'generate',
    'failure',
    'AGENT_UPDATE_REQUIRED'
  );
  api.save.mockResolvedValueOnce({ id: 'local-prepare', version: '4' });
  foreground.prepare.mockResolvedValueOnce(undefined);
  api.generate.mockRejectedValueOnce(Error('lost admission POST'));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toThrow(
      'lost admission POST'
    );
  });
  expect(api.save.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'local-prepare', version: '3' });
  expect(result.current.hasUnresolvedRequest).toBe(true);
});

it('retains original local intent when preparation rejects after the actor changes', async () => {
  setPrivateCacheScope('actor-original', 'team');
  const config = launchConfig({ method: 'catalog' });
  config.catalog.catalogVideoProtocolVersion = 1;
  config.catalog.restitchEnabled = true;
  api.save.mockResolvedValueOnce({ id: 'local-owner', version: '1' });
  foreground.prepare.mockImplementationOnce(async () => {
    setPrivateCacheScope('actor-other', 'team');
    throw Error('PERMISSION_DENIED');
  });
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toThrow(
      'PERMISSION_DENIED'
    );
  });
  expect(api.generate).not.toHaveBeenCalled();
  expect(result.current.hasUnresolvedRequest).toBe(true);
});

it('replays an unknown canonical POST with the same omitted proof after optional preparation failed', async () => {
  const config = launchConfig({ method: 'catalog' });
  config.catalog.catalogVideoProtocolVersion = 1;
  config.catalog.restitchEnabled = true;
  api.save.mockResolvedValueOnce({ id: 'optional-proof', version: '1' });
  foreground.prepare.mockRejectedValueOnce(Error('INVALID_RESPONSE'));
  api.generate
    .mockRejectedValueOnce(Error('lost POST'))
    .mockRejectedValueOnce(Error('lost POST again'));
  api.detail.mockResolvedValueOnce({ id: 'optional-proof', generation: null });
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await expect(result.current.generate(null, config, null, null)).rejects.toThrow('lost POST');
  });
  const first = api.generate.mock.calls.at(-1);
  expect(result.current.hasUnresolvedRequest).toBe(true);
  await act(async () => {
    await expect(result.current.retry(null, config, null, null)).rejects.toThrow('lost POST again');
  });
  expect(api.generate.mock.calls.at(-1)).toEqual(first);
  expect(foreground.prepare).toHaveBeenCalledOnce();
  expect(result.current.hasUnresolvedRequest).toBe(true);
});

it('sends a generate Google briefly refused again with the same key, and never shows the refusal', async () => {
  // Production 2026-11-12: one unanswered Drive call during the source check reached the owner
  // as «Помилка — перевірте стан… Операція може ще виконуватися»; nothing had been started.
  const config = launchConfig({ method: 'catalog' });
  api.save.mockResolvedValue({ id: 'launch', version: '1' });
  api.generate
    .mockRejectedValueOnce(new TeamApiError('DRIVE_UNAVAILABLE', true))
    .mockResolvedValue(undefined);
  api.detail.mockResolvedValue({
    id: 'launch',
    version: '1',
    draft: config,
    expectedSourceSnapshot: null,
    assigneeId: null,
    workStatus: 'todo',
    activeRevision: null,
    generation: {
      id: 'generation',
      state: 'accepted',
      stage: 'accepted',
      inputVersion: '1',
      stateVersion: '1',
      progress: null,
      errorCode: null,
      childOperationIds: []
    }
  } satisfies LaunchDetail);
  const { result } = renderHook(() => useLaunchGeneration('team', vi.fn()));
  await act(async () => {
    await result.current.generate(null, config, null, null);
  });
  expect(api.generate).toHaveBeenCalledTimes(2);
  expect(api.generate.mock.calls[1][3]).toBe(api.generate.mock.calls[0][3]);
  expect(api.save).toHaveBeenCalledOnce();
}, 15_000);
