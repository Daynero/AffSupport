import { describe, expect, it, vi } from 'vitest';
import { startProcessTakingOverOwnRun } from '../supabase/functions/drive-ops/process-reservation-takeover';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

const manualKey = '0f3b2c1a-8d4e-4f5a-9b6c-7d8e9f0a1b2c';
const conflict = () => new TeamFunctionError('NAME_CONFLICT');

describe('a retry and the same person’s stalled run (production 2026-11-26)', () => {
  it('cancels the stalled run and starts again once', async () => {
    const start = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce('started');
    const release = vi.fn().mockResolvedValue('stalled-operation-id');
    await expect(
      startProcessTakingOverOwnRun({
        start,
        release,
        idempotencyKey: manualKey,
        reservedNameKey: 'ma 19.txt',
        trusted: false
      })
    ).resolves.toBe('started');
    expect(release).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('keeps the conflict when nothing of the person’s own could be released', async () => {
    const error = conflict();
    const start = vi.fn().mockRejectedValue(error);
    const release = vi.fn().mockResolvedValue(null);
    await expect(
      startProcessTakingOverOwnRun({
        start,
        release,
        idempotencyKey: manualKey,
        reservedNameKey: 'ma 19.txt',
        trusted: false
      })
    ).rejects.toBe(error);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a catalog variant', { trusted: true, idempotencyKey: manualKey }],
    ['a library job', { trusted: false, idempotencyKey: 'library.process.abc' }],
    ['a keyed flow', { trusted: false, idempotencyKey: `catalog-variant:${manualKey}` }]
  ])('never takes over for %s', async (_name, variant) => {
    const start = vi.fn().mockRejectedValue(conflict());
    const release = vi.fn();
    await expect(
      startProcessTakingOverOwnRun({ start, release, reservedNameKey: 'x.txt', ...variant })
    ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
    expect(release).not.toHaveBeenCalled();
  });

  it('passes every other failure through untouched', async () => {
    const start = vi.fn().mockRejectedValue(new TeamFunctionError('SOURCE_CHANGED'));
    const release = vi.fn();
    await expect(
      startProcessTakingOverOwnRun({
        start,
        release,
        idempotencyKey: manualKey,
        reservedNameKey: 'x.txt',
        trusted: false
      })
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(release).not.toHaveBeenCalled();
  });
});
