import { expect, it, vi } from 'vitest';
import { TeamApiError } from '../apps/web/src/api/team';
import {
  LAUNCH_TRANSIENT_RETRY_DELAYS_MS,
  withLaunchTransientRetry
} from '../apps/web/src/team/launches/reply';

const options = (stillWanted = vi.fn()) => {
  const waits: number[] = [];
  return {
    waits,
    stillWanted,
    signal: new AbortController().signal,
    sleep: async (ms: number) => {
      waits.push(ms);
    }
  };
};

it('repeats only a transient Google refusal, three attempts in all', async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new TeamApiError('DRIVE_UNAVAILABLE', true))
    .mockRejectedValueOnce(new TeamApiError('RATE_LIMITED', true))
    .mockResolvedValue('accepted');
  const o = options();
  await expect(withLaunchTransientRetry(send, o)).resolves.toBe('accepted');
  expect(send).toHaveBeenCalledTimes(3);
  expect(o.waits).toEqual([...LAUNCH_TRANSIENT_RETRY_DELAYS_MS]);
  expect(o.stillWanted).toHaveBeenCalledTimes(2);
});

it('shows a refusal that persists, and anything that is not transient, at once', async () => {
  const persistent = vi.fn().mockRejectedValue(new TeamApiError('DRIVE_UNAVAILABLE', true));
  await expect(withLaunchTransientRetry(persistent, options())).rejects.toMatchObject({
    code: 'DRIVE_UNAVAILABLE'
  });
  expect(persistent).toHaveBeenCalledTimes(3);
  for (const code of ['LAUNCH_RESULT_UNCERTAIN', 'PERMISSION_DENIED', 'AGENT_REQUIRED'] as const) {
    const send = vi.fn().mockRejectedValue(new TeamApiError(code, false));
    await expect(withLaunchTransientRetry(send, options())).rejects.toMatchObject({ code });
    expect(send).toHaveBeenCalledOnce();
  }
});

it('stops repeating when the person cancels during the pause', async () => {
  const send = vi.fn().mockRejectedValue(new TeamApiError('DRIVE_UNAVAILABLE', true));
  const stillWanted = vi.fn(() => {
    throw new TeamApiError('PROCESS_CANCELED', false);
  });
  await expect(withLaunchTransientRetry(send, options(stillWanted))).rejects.toMatchObject({
    code: 'PROCESS_CANCELED'
  });
  expect(send).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'clears the real retry pause on abort (already aborted: %s)',
  async aborted => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      if (aborted) controller.abort();
      const send = vi.fn().mockRejectedValue(new TeamApiError('DRIVE_UNAVAILABLE', true));
      const pending = withLaunchTransientRetry(send, {
        signal: controller.signal,
        stillWanted: vi.fn()
      });
      const rejected = expect(pending).rejects.toThrow('superseded-launch-wait');
      if (!aborted) {
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        controller.abort();
      }
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  }
);

it('releases the abort listener after a retry pause completes', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TeamApiError('DRIVE_UNAVAILABLE', true))
      .mockResolvedValue('accepted');
    const pending = withLaunchTransientRetry(send, {
      signal: controller.signal,
      stillWanted: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(LAUNCH_TRANSIENT_RETRY_DELAYS_MS[0]!);
    await expect(pending).resolves.toBe('accepted');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
