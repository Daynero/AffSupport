import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keepLease,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_RENEW_RETRY_MS,
  LEASE_STALL_MS
} from '../supabase/functions/_shared/lease-keeper.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

function keeper(answers: Array<'ok' | 'refused' | 'fail' | 'hang'>) {
  const onLost = vi.fn();
  const renew = vi.fn(() => {
    const answer = answers.shift() ?? 'ok';
    if (answer === 'ok') return Promise.resolve(true);
    if (answer === 'refused') return Promise.resolve(false);
    if (answer === 'fail') return Promise.reject(new Error('gateway 499'));
    return new Promise<unknown>(() => undefined);
  });
  const lease = keepLease({ renew, onLost, since: Date.now() });
  return { onLost, renew, lease };
}

describe('lease keeper', () => {
  it('renews on its interval while the server agrees', async () => {
    const { onLost, renew, lease } = keeper([]);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 5);
    expect(renew).toHaveBeenCalledTimes(5);
    expect(onLost).not.toHaveBeenCalled();
    await lease.stop();
  });

  it('survives a failed renewal and retries it soon instead of aborting', async () => {
    const { onLost, renew, lease } = keeper(['fail', 'fail', 'ok']);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_RETRY_MS * 2);
    expect(renew).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(LEASE_STALL_MS * 2);
    expect(onLost).not.toHaveBeenCalled();
    await lease.stop();
  });

  it('gives the lease up at once when the server refuses the renewal', async () => {
    const { onLost, renew, lease } = keeper(['refused']);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(onLost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LEASE_STALL_MS * 2);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledTimes(1);
    await lease.stop();
  });

  it('gives the lease up when nothing succeeded for the stall window, well inside the 90 s lease', async () => {
    const { onLost, lease } = keeper(Array(20).fill('fail'));
    await vi.advanceTimersByTimeAsync(LEASE_STALL_MS - 1);
    expect(onLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(LEASE_STALL_MS).toBeLessThan(90_000);
    await lease.stop();
  });

  it('times the stall from when the last good renewal was sent, however long a later one hangs', async () => {
    const { onLost, renew, lease } = keeper(['ok', 'hang']);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    // first renewal sent at 20 s succeeded; the second (40 s) never answers
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LEASE_STALL_MS - LEASE_RENEW_INTERVAL_MS - 1);
    expect(onLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onLost).toHaveBeenCalledTimes(1);
    void lease.stop();
  });

  it('stops renewing once stopped and never reports a loss afterwards', async () => {
    const { onLost, renew, lease } = keeper(Array(20).fill('fail'));
    await lease.stop();
    await vi.advanceTimersByTimeAsync(LEASE_STALL_MS * 2);
    expect(renew).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });
});
