import { beforeEach, expect, it, vi } from 'vitest';
const track = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));
import {
  observeStitchInput,
  recordStitchInputFailure
} from '../apps/web/src/stitcher/input-diagnostics';
beforeEach(() => track.mockReset());
it('correlates stage evidence without copying returned paths into analytics', async () => {
  const result = { paths: ['C:\\private\\video.mp4'] };
  await expect(observeStitchInput('picker', 'flow', async () => result)).resolves.toBe(result);
  expect(track.mock.calls.map(call => call[0])).toEqual([
    'operation_stage_started',
    'operation_stage_completed'
  ]);
  expect(track.mock.calls[1][1]).toMatchObject({ flow_id: 'flow', flow_step: 'picker' });
  expect(JSON.stringify(track.mock.calls)).not.toContain('private');
});
it('exposes a known failure to the existing errors CLI and preserves the exception', async () => {
  const error = new Error('NATIVE_PICKER_TIMEOUT');
  await expect(
    observeStitchInput('picker', 'flow', async () => {
      throw error;
    })
  ).rejects.toBe(error);
  expect(track).toHaveBeenLastCalledWith(
    'error_occurred',
    expect.objectContaining({
      error_code: 'NATIVE_PICKER_TIMEOUT',
      error_stage: 'picker',
      flow_id: 'flow'
    })
  );
});
it('redacts unknown exception text and records probe refusals without file names', () => {
  recordStitchInputFailure('drop_resolve', 'flow', 'C:\\private\\secret.mp4 token=secret');
  expect(track).toHaveBeenLastCalledWith(
    'error_occurred',
    expect.objectContaining({ error_code: 'STITCH_INPUT_FAILED' })
  );
  recordStitchInputFailure('input_probe', 'flow', 'unreadable');
  expect(track).toHaveBeenLastCalledWith(
    'error_occurred',
    expect.objectContaining({ error_code: 'unreadable' })
  );
  expect(JSON.stringify(track.mock.calls)).not.toContain('secret');
});
