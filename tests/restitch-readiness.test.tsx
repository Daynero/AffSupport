// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RESTITCH_DETECTOR_VERSION } from '@video-compressor/shared';

/**
 * The card's "N of M ready" (071) counts every usable preparation record for a video's current
 * bytes — whoever wrote it. A manual "download re-stitched" stores what the agent found
 * (`useRestitchDelivery`, `setMaterialRestitchPrep`), so a video re-stitched once counts as
 * ready without anyone pressing the card's button; a record for older bytes or an older
 * detector does not.
 */

const prep = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    listFolderTree: async () => [],
    listFolderPage: async () => ({
      rows: [
        { id: 'restitched', kind: 'video', name: 'a.mp4', driveVersion: '7' },
        { id: 'changed', kind: 'video', name: 'b.mp4', driveVersion: '9' },
        { id: 'old-detector', kind: 'video', name: 'c.mp4', driveVersion: '1' },
        { id: 'never', kind: 'video', name: 'd.mp4', driveVersion: '1' }
      ],
      next: null
    }),
    getMaterialRestitchPrep: async () => prep
  }
}));

const { useRestitchReadiness } =
  await import('../apps/web/src/team/workspace/restitch/useRestitchReadiness');

afterEach(() => {
  cleanup();
  prep.clear();
});

it('counts a video re-stitched by hand as ready, and nothing stale', async () => {
  const record = (materialId: string, driveVersion: string, detectorVersion: number) => ({
    materialId,
    driveVersion,
    detectorVersion,
    detectedStartSeconds: 0,
    detectedEndSeconds: 0,
    profile: null,
    unsupportedReason: null,
    preparedAt: `2026-11-2${detectorVersion}T10:00:00.000Z`
  });
  // What a manual delivery stores for the bytes it read.
  prep.set('restitched', record('restitched', '7', RESTITCH_DETECTOR_VERSION));
  // The file changed since it was read.
  prep.set('changed', record('changed', '8', RESTITCH_DETECTOR_VERSION));
  // Read by a detector this build no longer trusts.
  prep.set('old-detector', record('old-detector', '1', RESTITCH_DETECTOR_VERSION - 1));
  const view = renderHook(() => useRestitchReadiness('team', true, 'r1'));
  await waitFor(() => expect(view.result.current).not.toBeNull());
  expect(view.result.current).toMatchObject({ total: 4, ready: 1 });
  expect(view.result.current?.lastPreparedAt).toBe(
    `2026-11-2${RESTITCH_DETECTOR_VERSION}T10:00:00.000Z`
  );
});

it('reads nothing while the space cannot be prepared', () => {
  const view = renderHook(() => useRestitchReadiness('team', false, 'r1'));
  expect(view.result.current).toBeNull();
});
