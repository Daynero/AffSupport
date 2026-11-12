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
  for (const code of ['LAUNCH_RESULT_UNCERTAIN', 'PERMISSION_DENIED', 'AGENT_REQUIRED']) {
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
