// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeUpdateSnapshot } from '../packages/shared/src/native-app-updates';
import { nativeSnapshot } from './support/native-app-updates';
import { useNativeAppUpdate } from '../apps/web/src/updates/useNativeAppUpdate';
const mocks = vi.hoisted(() => ({ read: vi.fn(), command: vi.fn(), stream: vi.fn() }));
vi.mock('../apps/web/src/api/native-app-updates', () => ({
  readNativeAppUpdate: mocks.read,
  commandNativeAppUpdate: mocks.command
}));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: mocks.stream }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('native update client synchronization', () => {
  it('clears a failed read on valid push recovery and cancels the pending retry', async () => {
    vi.useFakeTimers();
    mocks.read.mockRejectedValue(new Error('network'));
    const hook = renderHook(() => useNativeAppUpdate(true, true, 'old-build'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.error).toBe(true);
    act(() =>
      mocks.stream.mock.calls
        .at(-1)![0]
        .onMessage({ type: 'app-update:state', state: nativeSnapshot() })
    );
    expect(hook.result.current.error).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it('recovers one transient read failure automatically without replaying a command or polling after success', async () => {
    vi.useFakeTimers();
    mocks.read.mockRejectedValueOnce(new Error('network')).mockResolvedValue(nativeSnapshot());
    const hook = renderHook(() => useNativeAppUpdate(true, true, 'old-build'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.error).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook.result.current.state?.stage).toBe('prepared');
    expect(hook.result.current.error).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it('bounds repeated read failures to two retries and never resubmits install intent', async () => {
    vi.useFakeTimers();
    mocks.read.mockRejectedValue(new Error('offline'));
    const hook = renderHook(() => useNativeAppUpdate(true, true, 'old-build'));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(hook.result.current.error).toBe(true);
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it('cancels a scheduled retry when its owner unmounts', async () => {
    vi.useFakeTimers();
    mocks.read.mockRejectedValue(new Error('offline'));
    const hook = renderHook(() => useNativeAppUpdate(true, true, 'old-build'));
    await act(async () => {
      await Promise.resolve();
    });
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it('waits for visibility instead of retrying reads in a hidden tab', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    mocks.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(nativeSnapshot());
    renderHook(() => useNativeAppUpdate(true, true, 'old-build'));
    await act(async () => {
      await Promise.resolve();
    });
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.read).toHaveBeenCalledOnce();
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it('retains an event newer than an in-flight snapshot and coalesces one follow-up', async () => {
    let resolve!: (state: NativeUpdateSnapshot) => void;
    const old = nativeSnapshot();
    const newer = { ...old, revision: 3, stage: 'consented' as const };
    mocks.read
      .mockImplementationOnce(
        () =>
          new Promise<NativeUpdateSnapshot>(done => {
            resolve = done;
          })
      )
      .mockResolvedValue(newer);
    const hook = renderHook(() => useNativeAppUpdate(true, true, 'old-build'));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    const stream = mocks.stream.mock.calls.at(-1)![0];
    act(() => {
      stream.onMessage({ type: 'app-update:state', state: newer });
      resolve(old);
    });
    await waitFor(() => expect(hook.result.current.state?.revision).toBe(3));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(stream.multiplexed).toBe(true);
    expect(stream.channel).toBe('app-update');
  });
  it('acknowledges visible native readiness once without recurring reads', async () => {
    const state = { ...nativeSnapshot(), stage: 'native_ready' as const, nativeSuccess: true };
    mocks.read.mockResolvedValue(state);
    mocks.command.mockResolvedValue({
      ...state,
      stage: 'ui_visible',
      uiSuccess: true,
      revision: 2
    });
    renderHook(() => useNativeAppUpdate(true, true, state.candidate!.buildId));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledOnce());
    expect(mocks.command.mock.calls[0]![0]).toBe('ack-visible');
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
