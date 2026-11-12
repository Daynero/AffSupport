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
});
describe('native update client synchronization', () => {
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
