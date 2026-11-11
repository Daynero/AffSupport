// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLaunchCopy } from '../apps/web/src/team/launches/useLaunchCopy';
const api = vi.hoisted(() => ({
  copy: vi.fn(),
  detail: vi.fn(),
  correlations: [] as Array<{ launchId?: string }>
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
  launchMutation: (
    correlation: { launchId?: string },
    _a: unknown,
    execute: () => Promise<unknown>
  ) => {
    api.correlations.push(correlation);
    return execute();
  }
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  api.correlations.length = 0;
});
it('replays a lost copy reply with the exact saved version and timezone', async () => {
  api.copy.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ id: 'copy' });
  api.detail.mockResolvedValueOnce({ id: 'copy' });
  const done = vi.fn();
  const { result } = renderHook(() => useLaunchCopy('team', done));
  await act(async () => {
    await expect(result.current.copy({ id: 'original', version: '1' })).rejects.toThrow('network');
  });
  expect(result.current.hasUnresolvedRequest).toBe(true);
  await act(async () => {
    await result.current.copy({ id: 'original', version: '9' });
  });
  expect(api.copy.mock.calls[1]).toEqual(api.copy.mock.calls[0]);
  expect(done).toHaveBeenCalledWith({ id: 'copy' });
  expect(api.correlations.at(-1)?.launchId).toBe('copy');
  expect(result.current.hasUnresolvedRequest).toBe(false);
});
it('only retries reading an already confirmed copy', async () => {
  api.copy.mockResolvedValueOnce({ id: 'copy' });
  api.detail.mockRejectedValueOnce(new Error('read lost')).mockResolvedValueOnce({ id: 'copy' });
  const { result } = renderHook(() => useLaunchCopy('team', vi.fn()));
  await act(async () => {
    await expect(result.current.copy({ id: 'original', version: '1' })).rejects.toThrow(
      'read lost'
    );
  });
  await act(async () => {
    await result.current.copy({ id: 'original', version: '2' });
  });
  expect(api.copy).toHaveBeenCalledOnce();
  expect(api.detail).toHaveBeenCalledTimes(2);
});
it('suppresses double clicks and does not redirect a replacement session', async () => {
  let resolve: (value: { id: string }) => void = () => {};
  api.copy.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  api.detail.mockResolvedValueOnce({ id: 'copy' });
  const original = vi.fn();
  const replacement = vi.fn();
  const hook = renderHook(({ handler }) => useLaunchCopy('team', handler), {
    initialProps: { handler: original }
  });
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = hook.result.current.copy({ id: 'original', version: '1' });
    await hook.result.current.copy({ id: 'original', version: '1' });
  });
  hook.rerender({ handler: replacement });
  await act(async () => {
    resolve({ id: 'copy' });
    await pending;
  });
  expect(api.copy).toHaveBeenCalledOnce();
  expect(original).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
});
it('does not read or notify after its authorization scope unmounts', async () => {
  let resolve: (value: { id: string }) => void = () => {};
  api.copy.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  const done = vi.fn();
  const hook = renderHook(() => useLaunchCopy('team', done));
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = hook.result.current.copy({ id: 'original', version: '1' });
  });
  hook.unmount();
  await act(async () => {
    resolve({ id: 'copy' });
    await pending;
  });
  expect(api.detail).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});

it('keeps a confirmed copy successful if its notification host fails', async () => {
  const { ToastContextOverride } = await import('../apps/web/src/components/toast');
  api.copy.mockResolvedValueOnce({ id: 'copy' });
  api.detail.mockResolvedValueOnce({ id: 'copy', draft: { launchDate: '2026-10-30' } });
  const push = vi.fn(() => {
    throw new Error('notification unavailable');
  });
  const done = vi.fn();
  const hook = renderHook(() => useLaunchCopy('team', done), {
    wrapper: ({ children }) => (
      <ToastContextOverride value={{ toasts: [], push, update: vi.fn(), dismiss: vi.fn() }}>
        {children}
      </ToastContextOverride>
    )
  });
  await act(async () => {
    await expect(
      hook.result.current.copy({ id: 'original', version: '1' })
    ).resolves.toBeUndefined();
  });
  expect(push).toHaveBeenCalledOnce();
  expect(done).toHaveBeenCalledOnce();
  expect(hook.result.current.hasUnresolvedRequest).toBe(false);
  expect(api.copy).toHaveBeenCalledOnce();
});

it('announces a copy with the day the list shows, for the usual toast time (1.4.3)', async () => {
  const { ToastContextOverride } = await import('../apps/web/src/components/toast');
  const { formatDayValue } = await import('../apps/web/src/format');
  api.copy.mockResolvedValueOnce({ id: 'copy' });
  api.detail.mockResolvedValueOnce({ id: 'copy', draft: { launchDate: '2026-11-12' } });
  const push = vi.fn((_input: { text: string; sticky?: boolean; action?: unknown }) => 1);
  const hook = renderHook(() => useLaunchCopy('team', vi.fn()), {
    wrapper: ({ children }) => (
      <ToastContextOverride value={{ toasts: [], push, update: vi.fn(), dismiss: vi.fn() }}>
        {children}
      </ToastContextOverride>
    )
  });
  await act(async () => {
    await hook.result.current.copy({ id: 'original', version: '1' });
  });
  expect(push).toHaveBeenCalledOnce();
  const toast = push.mock.calls[0][0];
  expect(toast.text).not.toContain('2026-11-12');
  expect(toast.text).toContain(formatDayValue('2026-11-12', 'en-US'));
  expect(toast.action).toBeTruthy();
  expect(toast.sticky).toBeFalsy();
});
