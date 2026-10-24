import { afterEach, describe, expect, it, vi } from 'vitest';
import { runArrivals } from '../scripts/acceptance/arrival.mjs';
const config = {
  count: 5,
  intervalMs: 10,
  concurrency: 1,
  warmup: 0,
  timeoutMs: 100,
  now: () => Date.now()
};
afterEach(() => vi.useRealTimers());
describe('open-loop arrival accounting', () => {
  it('keeps busy arrivals in the denominator and cancels stalled work at its deadline', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const pending = runArrivals({
      ...config,
      execute: (_index: number, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<boolean>(() => {});
      }
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.summary).toMatchObject({
      offered: 5,
      measured: 5,
      success: 0,
      dropped: 4,
      censored: 5
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not count future arrivals as offered after cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = runArrivals({
      ...config,
      signal: controller.signal,
      execute: () => new Promise<boolean>(() => {})
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    expect(result.stopped).toBe(true);
    expect(result.summary.offered).toBe(1);
    expect(result.notOffered).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('separates explicit warmup and wrong results from successful measured responses', async () => {
    vi.useFakeTimers();
    const pending = runArrivals({
      ...config,
      warmup: 1,
      execute: (index: number) => Promise.resolve(index !== 2)
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.summary).toMatchObject({
      offered: 5,
      warmup: 1,
      measured: 4,
      success: 3,
      failed: 1,
      uiProof: false
    });
  });
  it('refuses unbounded configurations before execution', async () => {
    const execute = vi.fn();
    await expect(runArrivals({ ...config, intervalMs: 100000, execute })).rejects.toThrow(
      'ACCEPTANCE_LOAD_CONFIG_INVALID'
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
