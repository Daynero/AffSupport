import { expect, it } from 'vitest';
import { parseLaunchCatalogVideoConfig } from '@video-compressor/shared';
import { creativesPatch } from '../apps/web/src/team/launches/launchCreatives';
import { newLaunchDraft } from '../apps/web/src/team/launches/launchDraftDefaults';

const creative = (id: string) => ({ materialId: id, alias: id, copies: 1, pinned: null });
const restitching = (variations: number) => {
  const draft = { ...newLaunchDraft(), method: 'catalog' as const };
  draft.catalog = {
    ...draft.catalog!,
    restitchEnabled: true,
    catalogVideoProtocolVersion: 1,
    videoVariationCount: variations
  };
  return draft;
};

it('gives a video added while restitch is on a variation of its own', () => {
  const patch = creativesPatch(restitching(2), ['a', 'b', 'c'].map(creative), 'video');
  expect(patch.catalog?.videoVariationCount).toBe(3);
  expect(patch.catalog?.restitchEnabled).toBe(true);
  expect(parseLaunchCatalogVideoConfig(patch.catalog, true)).not.toBeNull();
});

/**
 * The regression this suite first missed (next, 2026-11-21): a draft whose catalog had no
 * video protocol yet got a bare count, and every later read of it failed as «the server
 * answered unexpectedly». The count travels with its protocol and publication.
 */
it('writes the count a stored draft can be read back with, from a catalog without one', () => {
  const draft = { ...newLaunchDraft(), method: 'catalog' as const };
  draft.catalog = { ...draft.catalog!, restitchEnabled: true };
  delete (draft.catalog as { catalogVideoProtocolVersion?: number }).catalogVideoProtocolVersion;
  delete (draft.catalog as { videoVariationCount?: number }).videoVariationCount;
  delete (draft.catalog as { videoPublication?: unknown }).videoPublication;
  const patch = creativesPatch(draft, ['a', 'b'].map(creative), 'video');
  expect(patch.catalog).toMatchObject({
    catalogVideoProtocolVersion: 1,
    videoVariationCount: 2,
    videoPublication: { mode: 'immediate' }
  });
  expect(parseLaunchCatalogVideoConfig(patch.catalog, true)).not.toBeNull();
});

it('leaves a count that already covers every video, and a launch without restitch, alone', () => {
  expect(
    creativesPatch(restitching(12), ['a', 'b', 'c'].map(creative), 'video').catalog
  ).toBeUndefined();
  const plain = { ...newLaunchDraft(), method: 'catalog' as const };
  expect(creativesPatch(plain, ['a', 'b', 'c'].map(creative), 'video').catalog).toBeUndefined();
});

it('never asks for more variations than there are products', () => {
  const patch = creativesPatch(restitching(1), ['a', 'b', 'c', 'd'].map(creative), 'video', 3);
  expect(patch.catalog?.videoVariationCount).toBe(3);
});

it('still turns restitch off for images', () => {
  const patch = creativesPatch(restitching(3), ['a', 'b'].map(creative), 'image');
  expect(patch.catalog?.restitchEnabled).toBe(false);
});
