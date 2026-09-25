// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFolderResync } from '../apps/web/src/team/explorer/useFolderResync';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

function setup(status: 'running' | 'succeeded' | 'failed' = 'running') {
  vi.useFakeTimers();
  const client = {
    resyncFolder: vi.fn().mockResolvedValue({ syncJobId: 'job-1', initialSyncState: 'scanning' }),
    getFolderResyncStatus: vi.fn().mockResolvedValue(status)
  };
  const onComplete = vi.fn().mockResolvedValue(undefined);
  const onOutcome = vi.fn();
  const hook = renderHook(
    ({ folderId }) =>
      useFolderResync({
        teamId: 'team-1',
        folderId,
        client,
        onComplete,
        onOutcome
      }),
    { initialProps: { folderId: 'doctors' } }
  );
  return { ...hook, client, onComplete, onOutcome };
}

describe('manual folder sync without Realtime', () => {
  it('waits for its own job, then refreshes the screen before reporting success', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.result.current.running).toBe(true);
    expect(test.client.resyncFolder).toHaveBeenCalledWith('team-1', 'doctors');
    expect(test.onComplete).not.toHaveBeenCalled();
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    test.client.getFolderResyncStatus.mockResolvedValue('succeeded');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(test.client.getFolderResyncStatus).toHaveBeenLastCalledWith('team-1', 'job-1');
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenCalledWith('succeeded');
    expect(test.onComplete.mock.invocationCallOrder[0]).toBeLessThan(
      test.onOutcome.mock.invocationCallOrder[0]!
    );
    expect(test.result.current.running).toBe(false);
    const reads = test.client.getFolderResyncStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(test.client.getFolderResyncStatus).toHaveBeenCalledTimes(reads);
  });

  it('reports a failed job without claiming success', async () => {
    const test = setup('failed');
    await act(async () => {
      await test.result.current.start();
    });
    expect(test.onOutcome).toHaveBeenCalledWith('failed');
    expect(test.onComplete).not.toHaveBeenCalled();
    expect(test.result.current.running).toBe(false);
  });

  it('reports a refresh failure instead of a successful sync toast', async () => {
    const test = setup('succeeded');
    test.onComplete.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await test.result.current.start();
    });
    expect(test.onOutcome).toHaveBeenCalledWith('failed');
  });

  it('stops polling when the user leaves the folder', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    test.rerender({ folderId: 'elsewhere' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(test.client.getFolderResyncStatus).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers an accepted job after navigation without requesting another sync', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    expect(window.sessionStorage.getItem('soty:folder-resync:team-1:doctors')).toBe('job-1');
    test.rerender({ folderId: 'elsewhere' });
    test.client.getFolderResyncStatus.mockResolvedValue('succeeded');
    test.rerender({ folderId: 'doctors' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenCalledWith('succeeded');
    expect(window.sessionStorage.getItem('soty:folder-resync:team-1:doctors')).toBeNull();
  });

  it('recovers the accepted job after remount', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    test.unmount();
    test.client.getFolderResyncStatus.mockResolvedValue('succeeded');
    renderHook(() =>
      useFolderResync({
        teamId: 'team-1',
        folderId: 'doctors',
        client: test.client,
        onComplete: test.onComplete,
        onOutcome: test.onOutcome
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenCalledWith('succeeded');
  });

  it('bounds waiting even when a status request hangs', async () => {
    const test = setup();
    test.client.getFolderResyncStatus.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      void test.result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(test.onOutcome).toHaveBeenCalledWith('timeout');
    expect(test.result.current.running).toBe(false);
    expect(test.onComplete).not.toHaveBeenCalled();
  });
});
