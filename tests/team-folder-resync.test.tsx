// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderSyncStatus } from '../apps/web/src/team/syncStatus';
import {
  ACCEPT_TIMEOUT_MS,
  FINAL_REFRESH_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  clearFolderResyncMemory,
  useFolderResync,
  type FolderResyncClient
} from '../apps/web/src/team/explorer/useFolderResync';
import { RequestAbortedError, TeamApiError } from '../apps/web/src/api/team';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

const KEY = 'soty:folder-resync:team-1:doctors';

function status(
  state: FolderSyncStatus['state'],
  overrides: Partial<FolderSyncStatus> = {}
): FolderSyncStatus {
  return {
    jobId: 'job-1',
    requestId: 'req-1',
    scopeFolderId: 'doctors',
    state,
    phase: state === 'succeeded' || state === 'failed' || state === 'canceled' ? 'done' : 'listing',
    blockedReason: state === 'blocked' ? 'canonical_failed' : null,
    errorCode: null,
    errorDetail: null,
    nextAttemptAt: null,
    startedAt: null,
    lastProgressAt: null,
    scanCompletedAt: null,
    completedAt: null,
    filesListed: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesRemoved: 0,
    itemsUnavailable: 0,
    foldersDone: 0,
    pendingFolders: null,
    coverage: 'unknown',
    progressRevision: 0,
    cancelable: !(state === 'succeeded' || state === 'failed' || state === 'canceled'),
    sharedWith: 0,
    ...overrides
  };
}

/** A call that honours its signal the way supabase-js does: abort → AbortError. */
function hanging<T>(): (
  teamId: string,
  id: string,
  options?: { signal?: AbortSignal }
) => Promise<T> {
  return (_team, _id, options) =>
    new Promise<T>((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new RequestAbortedError()), {
        once: true
      });
    });
}

type MockClient = Record<keyof FolderResyncClient, ReturnType<typeof vi.fn>>;

function setup(
  initial: FolderSyncStatus['state'] = 'running',
  overrides: Partial<MockClient> = {}
) {
  vi.useFakeTimers();
  const client: MockClient = {
    resyncFolder: vi
      .fn()
      .mockResolvedValue({ syncJobId: 'job-1', initialSyncState: 'scanning', requestId: 'req-1' }),
    getFolderSyncStatus: vi.fn().mockResolvedValue(status(initial)),
    findFolderSyncRequest: vi.fn().mockResolvedValue(null),
    findFolderSyncRequestByKey: vi.fn().mockResolvedValue(null),
    cancelFolderSync: vi
      .fn()
      .mockResolvedValue({ jobState: 'canceled', requestOutcome: 'canceled' }),
    ...overrides
  };
  const onComplete = vi.fn().mockResolvedValue(undefined);
  const onOutcome = vi.fn();
  const hook = renderHook(
    ({ folderId, scopeFolderIds }) =>
      useFolderResync({
        teamId: 'team-1',
        folderId,
        scopeFolderIds,
        client,
        onComplete,
        onOutcome
      }),
    { initialProps: { folderId: 'doctors', scopeFolderIds: undefined as string[] | undefined } }
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
    expect(test.client.resyncFolder).toHaveBeenCalledWith(
      'team-1',
      'doctors',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(test.onComplete).not.toHaveBeenCalled();
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    test.client.getFolderSyncStatus.mockResolvedValue(status('succeeded'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(test.client.getFolderSyncStatus).toHaveBeenLastCalledWith(
      'team-1',
      'job-1',
      expect.anything()
    );
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenCalledWith('succeeded');
    expect(test.onComplete.mock.invocationCallOrder[0]).toBeLessThan(
      test.onOutcome.mock.invocationCallOrder[0]!
    );
    expect(test.result.current.running).toBe(false);
    const reads = test.client.getFolderSyncStatus.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(test.client.getFolderSyncStatus).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failed job without claiming success', async () => {
    const test = setup('failed');
    await act(async () => {
      await test.result.current.start();
    });
    expect(test.onOutcome).toHaveBeenCalledWith('failed');
    expect(test.onComplete).not.toHaveBeenCalled();
    expect(test.result.current.running).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('forgets a retained job that no longer exists so the next click starts a new scan', async () => {
    const test = setup();
    window.localStorage.setItem(KEY, 'expired-job');
    test.client.getFolderSyncStatus
      .mockRejectedValueOnce(new TeamApiError('NOT_FOUND', false))
      .mockResolvedValue(status('succeeded'));
    await act(async () => {
      await test.result.current.start();
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    await act(async () => {
      await test.result.current.start();
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenCalledWith('succeeded');
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
    test.rerender({ folderId: 'elsewhere', scopeFolderIds: undefined });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(test.client.getFolderSyncStatus).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers an accepted job after navigation without requesting another sync', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    expect(window.localStorage.getItem(KEY)).toBe('job-1');
    test.rerender({ folderId: 'elsewhere', scopeFolderIds: undefined });
    test.client.getFolderSyncStatus.mockResolvedValue(status('succeeded'));
    test.rerender({ folderId: 'doctors', scopeFolderIds: undefined });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenCalledWith('succeeded');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('recovers the accepted job after remount', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    test.unmount();
    test.client.getFolderSyncStatus.mockResolvedValue(status('succeeded'));
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

  it('forgets a remembered job that failed long ago, without a panel or a toast', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(KEY, 'job-1');
    const client = {
      resyncFolder: vi.fn(),
      getFolderSyncStatus: vi
        .fn()
        .mockResolvedValue(
          status('failed', { completedAt: new Date(Date.now() - 24 * 3_600_000).toISOString() })
        ),
      findFolderSyncRequest: vi.fn(),
      findFolderSyncRequestByKey: vi.fn(),
      cancelFolderSync: vi.fn()
    };
    const onOutcome = vi.fn();
    const hook = renderHook(() =>
      useFolderResync({
        teamId: 'team-1',
        folderId: 'doctors',
        client,
        onComplete: vi.fn(),
        onOutcome
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onOutcome).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('still reports a remembered job that failed a moment ago', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(KEY, 'job-1');
    const client = {
      resyncFolder: vi.fn(),
      getFolderSyncStatus: vi
        .fn()
        .mockResolvedValue(status('failed', { completedAt: new Date().toISOString() })),
      findFolderSyncRequest: vi.fn(),
      findFolderSyncRequestByKey: vi.fn(),
      cancelFolderSync: vi.fn()
    };
    const onOutcome = vi.fn();
    renderHook(() =>
      useFolderResync({
        teamId: 'team-1',
        folderId: 'doctors',
        client,
        onComplete: vi.fn(),
        onOutcome
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onOutcome).toHaveBeenCalledWith('failed');
  });

  it('keeps an ancestor sync active after entering its child and blocks a duplicate request', async () => {
    const test = setup('running', {
      resyncFolder: vi.fn().mockResolvedValue({ syncJobId: 'job-parent' })
    });
    test.rerender({ folderId: 'parent', scopeFolderIds: ['parent'] });
    await act(async () => {
      void test.result.current.start();
    });
    test.rerender({ folderId: 'child', scopeFolderIds: ['parent', 'child'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(test.result.current.running).toBe(true);
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    test.client.getFolderSyncStatus.mockResolvedValue(status('succeeded', { jobId: 'job-parent' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(test.onComplete).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenCalledWith('succeeded');
    expect(test.result.current.running).toBe(false);
  });

  it('keeps the pending label when navigation beats the server accepting the scan', async () => {
    let accept!: (value: { syncJobId: string }) => void;
    const test = setup('running', {
      resyncFolder: vi.fn().mockImplementation(
        () =>
          new Promise<{ syncJobId: string }>(resolve => {
            accept = resolve;
          })
      )
    });
    test.rerender({ folderId: 'parent', scopeFolderIds: ['parent'] });
    await act(async () => {
      void test.result.current.start();
    });
    test.rerender({ folderId: 'child', scopeFolderIds: ['parent', 'child'] });
    expect(test.result.current.running).toBe(true);
    await act(async () => accept({ syncJobId: 'job-parent' }));
    expect(test.result.current.running).toBe(true);
    expect(test.client.getFolderSyncStatus).toHaveBeenCalledWith(
      'team-1',
      'job-parent',
      expect.anything()
    );
  });
});

describe('bounded waits (028)', () => {
  it('an accept that never answers releases the button after 15 s with outcome unreachable and remembers the scope as unknown', async () => {
    const test = setup('running', { resyncFolder: vi.fn(hanging()) });
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.result.current.running).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCEPT_TIMEOUT_MS);
    });
    expect(test.onOutcome).toHaveBeenCalledWith('unreachable');
    expect(test.result.current.running).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('unknown');
    // Nothing keeps polling: no status read, no poll timer survives the abort.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(test.client.getFolderSyncStatus).not.toHaveBeenCalled();
  });

  it('the next click after unknown looks the request up before creating a new one', async () => {
    const test = setup('running', {
      findFolderSyncRequest: vi
        .fn()
        .mockResolvedValue({ syncJobId: 'job-found', state: 'leased', createdAt: 'now' })
    });
    window.localStorage.setItem(KEY, 'unknown');
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.client.findFolderSyncRequest).toHaveBeenCalledWith(
      'team-1',
      'doctors',
      expect.anything()
    );
    expect(test.client.resyncFolder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(KEY)).toBe('job-found');
    expect(test.client.getFolderSyncStatus).toHaveBeenCalledWith(
      'team-1',
      'job-found',
      expect.anything()
    );
  });

  it('after unknown with nothing found, the click requests a scan', async () => {
    const test = setup();
    window.localStorage.setItem(KEY, 'unknown');
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.client.findFolderSyncRequest).toHaveBeenCalledTimes(1);
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(KEY)).toBe('job-1');
  });

  it('a hung status read is aborted after 15 s, releases the local lock and reports disconnected without forgetting the job', async () => {
    const test = setup('running', { getFolderSyncStatus: vi.fn(hanging()) });
    await act(async () => {
      void test.result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
    });
    expect(test.onOutcome).toHaveBeenCalledWith('disconnected');
    expect(test.result.current.running).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('job-1');
    expect(vi.getTimerCount()).toBe(0);
    // The button works again and resumes the same job: no second request.
    test.client.getFolderSyncStatus.mockResolvedValue(status('succeeded'));
    await act(async () => {
      await test.result.current.start();
    });
    expect(test.client.resyncFolder).toHaveBeenCalledTimes(1);
    expect(test.onOutcome).toHaveBeenLastCalledWith('succeeded');
  });

  it('a transient status error reports disconnected, a missing job (NOT_FOUND from the detailed status) still clears the retained id', async () => {
    const test = setup();
    test.client.getFolderSyncStatus.mockRejectedValueOnce(
      new TeamApiError('DRIVE_UNAVAILABLE', true)
    );
    await act(async () => {
      await test.result.current.start();
    });
    expect(test.onOutcome).toHaveBeenLastCalledWith('disconnected');
    expect(window.localStorage.getItem(KEY)).toBe('job-1');
    test.client.getFolderSyncStatus.mockRejectedValueOnce(new TeamApiError('NOT_FOUND', false));
    await act(async () => {
      await test.result.current.start();
    });
    expect(test.onOutcome).toHaveBeenLastCalledWith('failed');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('ten minutes without lastProgressAt advancing reports stalled', async () => {
    const test = setup('running', {
      getFolderSyncStatus: vi.fn().mockResolvedValue(status('running', { lastProgressAt: 't0' }))
    });
    await act(async () => {
      void test.result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5_000);
    });
    expect(test.onOutcome).toHaveBeenCalledWith('stalled');
    expect(test.result.current.running).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('job-1');
  });

  it('a slow scan whose lastProgressAt keeps advancing is not cut off at five or ten minutes', async () => {
    let tick = 0;
    const test = setup('running', {
      getFolderSyncStatus: vi.fn(async () => {
        tick += 1;
        return status('running', { lastProgressAt: `t${tick}`, filesListed: tick });
      })
    });
    await act(async () => {
      void test.result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 60_000);
    });
    expect(test.onOutcome).not.toHaveBeenCalled();
    expect(test.result.current.running).toBe(true);
    test.unmount();
  });

  it('a final refresh that never finishes reports disconnected and keeps the job for a retry', async () => {
    const test = setup('succeeded');
    test.onComplete.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      void test.result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FINAL_REFRESH_TIMEOUT_MS);
    });
    expect(test.onOutcome).toHaveBeenCalledWith('disconnected');
    expect(window.localStorage.getItem(KEY)).toBe('job-1');
  });
});

describe('scope fencing and shared memory (028)', () => {
  it('a late acceptance after the scope changed does not start a monitor or toast on the new scope', async () => {
    let accept!: (value: { syncJobId: string }) => void;
    const test = setup('running', {
      resyncFolder: vi.fn().mockImplementation(
        () =>
          new Promise<{ syncJobId: string }>(resolve => {
            accept = resolve;
          })
      )
    });
    await act(async () => {
      void test.result.current.start();
    });
    test.rerender({ folderId: 'elsewhere', scopeFolderIds: undefined });
    await act(async () => accept({ syncJobId: 'job-late' }));
    expect(test.client.getFolderSyncStatus).not.toHaveBeenCalled();
    expect(test.onOutcome).not.toHaveBeenCalled();
    expect(test.result.current.running).toBe(false);
    // The job stays bound to the folder it was asked for.
    expect(window.localStorage.getItem(KEY)).toBe('job-late');
  });

  it('a second tab discovers the job through localStorage and polls it without a second request', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    const other = {
      resyncFolder: vi.fn(),
      getFolderSyncStatus: vi.fn().mockResolvedValue(status('running')),
      findFolderSyncRequest: vi.fn()
    };
    const second = renderHook(() =>
      useFolderResync({
        teamId: 'team-1',
        folderId: 'doctors',
        client: other,
        onComplete: vi.fn().mockResolvedValue(undefined),
        onOutcome: vi.fn()
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(second.result.current.running).toBe(true);
    expect(other.getFolderSyncStatus).toHaveBeenCalledWith('team-1', 'job-1', expect.anything());
    expect(other.resyncFolder).not.toHaveBeenCalled();
    second.unmount();
  });

  it('a root sync stays visible inside a child folder', async () => {
    const test = setup('running', {
      getFolderSyncStatus: vi
        .fn()
        .mockResolvedValue(status('running', { scopeFolderId: '__root__' }))
    });
    window.localStorage.setItem('soty:folder-resync:team-1:__root__', 'job-root');
    test.rerender({ folderId: 'child', scopeFolderIds: ['__root__', 'child'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(test.result.current.running).toBe(true);
    expect(test.client.getFolderSyncStatus).toHaveBeenCalledWith(
      'team-1',
      'job-root',
      expect.anything()
    );
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.client.resyncFolder).not.toHaveBeenCalled();
  });

  it('signing out forgets every remembered job', () => {
    window.localStorage.setItem(KEY, 'job-1');
    window.localStorage.setItem('soty:folder-resync:team-2:__root__', 'job-2');
    window.localStorage.setItem('unrelated', 'keep');
    clearFolderResyncMemory();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.getItem('soty:folder-resync:team-2:__root__')).toBeNull();
    expect(window.localStorage.getItem('unrelated')).toBe('keep');
  });
});

describe('requests, stop and progress (028, release B)', () => {
  it('every click carries a key the server keeps, and a lost answer is found by that key first', async () => {
    const test = setup('running', {
      findFolderSyncRequestByKey: vi
        .fn()
        .mockResolvedValue({ syncJobId: 'job-by-key', requestId: 'req-by-key', state: 'leased' }),
      getFolderSyncStatus: vi
        .fn()
        .mockResolvedValue(status('running', { jobId: 'job-by-key', requestId: 'req-by-key' }))
    });
    window.localStorage.setItem(KEY, 'unknown');
    window.localStorage.setItem(`${KEY}:key`, 'web-earlier');
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.client.findFolderSyncRequestByKey).toHaveBeenCalledWith(
      'team-1',
      'web-earlier',
      expect.anything()
    );
    expect(test.client.findFolderSyncRequest).not.toHaveBeenCalled();
    expect(test.client.resyncFolder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(KEY)).toBe('job-by-key');
    expect(window.localStorage.getItem(`${KEY}:request`)).toBe('req-by-key');
  });

  it('a fresh click sends a generated key and remembers the request id', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    const options = test.client.resyncFolder.mock.calls[0]![2] as { requestKey?: string };
    expect(options.requestKey).toMatch(/^web-/);
    expect(window.localStorage.getItem(`${KEY}:key`)).toBe(options.requestKey);
    expect(window.localStorage.getItem(`${KEY}:request`)).toBe('req-1');
  });

  it('stop cancels this request: a canceled job clears the memory, a shared job only detaches', async () => {
    const test = setup();
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.result.current.status?.requestId).toBe('req-1');
    await act(async () => {
      await test.result.current.cancel();
    });
    expect(test.client.cancelFolderSync).toHaveBeenCalledWith('team-1', 'req-1');
    expect(test.onOutcome).toHaveBeenLastCalledWith('canceled');
    expect(test.result.current.running).toBe(false);
    expect(test.result.current.status?.state).toBe('canceled');
    expect(window.localStorage.getItem(KEY)).toBeNull();

    const shared = setup('running', {
      cancelFolderSync: vi
        .fn()
        .mockResolvedValue({ jobState: 'pending', requestOutcome: 'detached' })
    });
    await act(async () => {
      void shared.result.current.start();
    });
    await act(async () => {
      await shared.result.current.cancel();
    });
    expect(shared.onOutcome).toHaveBeenLastCalledWith('detached');
    expect(shared.result.current.running).toBe(false);
    expect(shared.result.current.status).toBeNull();
  });

  it('a leased job keeps being watched while canceling, then reports canceled', async () => {
    const test = setup('running', {
      cancelFolderSync: vi
        .fn()
        .mockResolvedValue({ jobState: 'canceling', requestOutcome: 'canceled' })
    });
    await act(async () => {
      void test.result.current.start();
    });
    await act(async () => {
      await test.result.current.cancel();
    });
    expect(test.result.current.running).toBe(true);
    expect(test.result.current.status?.state).toBe('canceling');
    test.client.getFolderSyncStatus.mockResolvedValue(status('canceled'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(test.onOutcome).toHaveBeenLastCalledWith('canceled');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('a blocked job is reported once with its reason kept in status, and the job is remembered', async () => {
    const test = setup('blocked');
    await act(async () => {
      void test.result.current.start();
    });
    expect(test.onOutcome).toHaveBeenCalledWith('blocked');
    expect(test.result.current.status?.blockedReason).toBe('canonical_failed');
    expect(test.result.current.running).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('job-1');
  });

  it('a changed progressRevision calls onProgress; an unchanged one does not', async () => {
    const onProgress = vi.fn();
    let revision = 0;
    const client = {
      resyncFolder: vi.fn().mockResolvedValue({ syncJobId: 'job-1' }),
      getFolderSyncStatus: vi.fn(async () => status('running', { progressRevision: revision })),
      findFolderSyncRequest: vi.fn(),
      findFolderSyncRequestByKey: vi.fn(),
      cancelFolderSync: vi.fn()
    };
    vi.useFakeTimers();
    const hook = renderHook(() =>
      useFolderResync({
        teamId: 'team-1',
        folderId: 'doctors',
        client,
        onComplete: vi.fn().mockResolvedValue(undefined),
        onOutcome: vi.fn(),
        onProgress
      })
    );
    await act(async () => {
      void hook.result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onProgress).not.toHaveBeenCalled();
    revision = 4;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0]![0]).toMatchObject({ progressRevision: 4 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
