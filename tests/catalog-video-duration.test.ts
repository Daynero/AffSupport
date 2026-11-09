import { expect, it } from 'vitest';
import { sampleCatalogVideoDuration } from '../supabase/functions/drive-ops/catalog-video-duration';
import type { TeamRestitchDefaults } from '@video-compressor/shared';
it('freezes an explicit centered range from original child identity across grant retries', async () => {
  const defaults = {
    finalDurationMode: 'random-centered',
    customFinalDurationSeconds: 1800,
    finalDurationRangeSeconds: [120, 180]
  } as TeamRestitchDefaults & { finalDurationRangeSeconds: [number, number] };
  const identity = { setId: 'set', requestId: 'child', settingsDigest: 'frozen' };
  const first = await sampleCatalogVideoDuration(defaults, identity);
  expect(await sampleCatalogVideoDuration(defaults, identity)).toEqual(first);
  expect(first.finalDurationMode).toBe('custom');
  expect(first.customFinalDurationSeconds).toBeGreaterThanOrEqual(120);
  expect(first.customFinalDurationSeconds).toBeLessThanOrEqual(180);
  expect(first).not.toHaveProperty('finalDurationRangeSeconds');
});
it('refuses inverted duration ranges instead of falling back to current defaults', async () => {
  await expect(
    sampleCatalogVideoDuration(
      {
        finalDurationMode: 'random-centered',
        customFinalDurationSeconds: 1800,
        finalDurationRangeSeconds: [180, 120]
      } as TeamRestitchDefaults & { finalDurationRangeSeconds: [number, number] },
      { setId: 'set', requestId: 'child', settingsDigest: 'frozen' }
    )
  ).rejects.toThrow('RESTITCH_INVALID');
});
