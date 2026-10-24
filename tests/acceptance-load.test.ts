import { describe, expect, it } from 'vitest';
import { summarizeAttempts } from '../scripts/acceptance/load-accounting.mjs';
const success = (id: number) => ({
  outcome: 'success',
  warmup: false,
  scheduledMs: id * 100,
  completedMs: id * 100 + 50
});
describe('offered load denominator', () => {
  it('counts dropped/missing results and excludes only explicit warmup', () => {
    const result = summarizeAttempts([
      ...Array.from({ length: 90 }, (_, i) => success(i)),
      ...Array.from({ length: 10 }, (_, i) => ({ ...success(i), outcome: 'timeout' })),
      { ...success(0), warmup: true }
    ]);
    expect(result).toMatchObject({
      offered: 101,
      warmup: 1,
      measured: 100,
      success: 90,
      censored: 10,
      p95Ms: 15000,
      uiProof: false
    });
  });
  it('does not award a late correct result as a successful deadline', () => {
    expect(summarizeAttempts([{ ...success(0), completedMs: 15001 }])).toMatchObject({
      success: 0,
      censored: 1
    });
  });
  it('accounts for dropped actions in the failure denominator', () => {
    expect(summarizeAttempts([{ ...success(0), outcome: 'dropped' }])).toMatchObject({
      offered: 1,
      dropped: 1,
      successRate: 0
    });
  });
  it('leaves absent metrics unknown', () =>
    expect(summarizeAttempts([])).toMatchObject({ p95Ms: null, successRate: null }));
});
