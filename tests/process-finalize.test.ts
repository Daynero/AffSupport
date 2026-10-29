import { expect, it, vi } from 'vitest';
import { finalizeProcessOutput } from '../supabase/functions/drive-ops/process-finalize';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
it('persists a proved source rejection before replying so Launch can settle and retry', async () => {
  const failure = new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  const rejectSource = vi.fn().mockResolvedValue(undefined);
  await expect(
    finalizeProcessOutput(async () => {
      throw failure;
    }, rejectSource)
  ).rejects.toBe(failure);
  expect(rejectSource).toHaveBeenCalledOnce();
});
it.each(['DRIVE_UNAVAILABLE', 'INVALID_RESPONSE'] as const)(
  'retains an uncertain commit on %s',
  async code => {
    const rejectSource = vi.fn();
    await expect(
      finalizeProcessOutput(async () => {
        throw new TeamFunctionError(code);
      }, rejectSource)
    ).rejects.toThrow(code);
    expect(rejectSource).not.toHaveBeenCalled();
  }
);
it('preserves authoritative success', async () => {
  const rejectSource = vi.fn();
  expect(await finalizeProcessOutput(async () => ({ state: 'succeeded' }), rejectSource)).toEqual({
    state: 'succeeded'
  });
  expect(rejectSource).not.toHaveBeenCalled();
});
