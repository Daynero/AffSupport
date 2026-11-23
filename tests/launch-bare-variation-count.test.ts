import { expect, it } from 'vitest';
import { parseLaunchDetail } from '../packages/shared/src/team/launches';
import { withoutBareVariationCount } from '../apps/web/src/api/launches';
import { launchConfig } from './fixtures/launches';

/**
 * next, 2026-11-21 (8d862c8c): turning restitch on wrote a bare variation count into a draft
 * whose catalog had no video protocol. The stored draft then failed its strict parse on every
 * open — «Сервер відповів несподівано», the Launch could not be opened again.
 */
const stored = (catalog: Record<string, unknown>) => ({
  id: '7a000000-0000-4000-8000-000000000001',
  version: '3',
  draft: { ...launchConfig(), method: 'catalog', catalog },
  expectedSourceSnapshot: null,
  assigneeId: null,
  workStatus: 'todo',
  activeRevision: null,
  generation: null
});
const catalog = {
  productCount: 100,
  restitchEnabled: true,
  finalDurationMode: 'random-30-40',
  customFinalDurationSeconds: null
};

it('opens a draft saved with a bare variation count, without the count', () => {
  const broken = stored({ ...catalog, videoVariationCount: 2 });
  expect(parseLaunchDetail(broken)).toBeNull();
  const opened = parseLaunchDetail(withoutBareVariationCount(broken));
  expect(opened).not.toBeNull();
  expect(opened!.draft.catalog).not.toHaveProperty('videoVariationCount');
  expect(opened!.draft.catalog?.restitchEnabled).toBe(true);
});

it('leaves a count that comes with its protocol, and every other read, exactly as it was', () => {
  const whole = stored({
    ...catalog,
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 4,
    videoPublication: { mode: 'immediate' }
  });
  expect(withoutBareVariationCount(whole)).toBe(whole);
  expect(
    parseLaunchDetail(withoutBareVariationCount(whole))!.draft.catalog?.videoVariationCount
  ).toBe(4);
  const plain = stored(catalog);
  expect(withoutBareVariationCount(plain)).toBe(plain);
  expect(withoutBareVariationCount(null)).toBeNull();
});
