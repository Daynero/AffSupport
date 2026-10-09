import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stat: vi.fn(), runTool: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('../apps/agent/src/stitcher/run.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/stitcher/run.js')>();
  return { ...actual, runTool: mocks.runTool };
});
import { probeSource } from '../apps/agent/src/stitcher/probe.js';
beforeEach(() => {
  mocks.stat.mockReset().mockResolvedValue({ size: 100, mtimeMs: 123 });
  mocks.runTool.mockReset().mockResolvedValue({
    code: 0,
    stdout: '{}',
    stderr: '',
    spawnErrorCode: null,
    cancelled: false
  });
});
it('distinguishes inaccessible source from media inspection failure', async () => {
  mocks.stat.mockRejectedValue(new Error('private file path'));
  expect(await probeSource('/private/video.mp4')).toEqual({
    ok: false,
    error: 'unreadable',
    diagnosticCode: 'SOURCE_STAT_FAILED'
  });
  expect(mocks.runTool).not.toHaveBeenCalled();
});
it.each([
  [{ spawnErrorCode: 'ENOENT' }, 'PROBE_SPAWN_FAILED', 'tool-unavailable'],
  [{ code: 1, stderr: '/private/video.mp4: permission denied' }, 'PROBE_EXIT_FAILED', 'unreadable'],
  [{ stdout: 'invalid JSON' }, 'PROBE_JSON_INVALID', 'unreadable'],
  [{ stdout: '{}' }, 'PROBE_METADATA_INVALID', 'unreadable']
])(
  'reports the failing boundary without exposing process output (%s)',
  async (patch, diagnosticCode, error) => {
    mocks.runTool.mockResolvedValue({
      code: 0,
      stdout: '{}',
      stderr: '',
      spawnErrorCode: null,
      cancelled: false,
      ...patch
    });
    expect(await probeSource('/private/video.mp4', { keyframes: false })).toEqual({
      ok: false,
      error,
      diagnosticCode
    });
  }
);
