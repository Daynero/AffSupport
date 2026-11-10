import { expect, it } from 'vitest';
import { parseCatalogPublicationSnapshot } from '../packages/shared/src/team/catalog-publication-api';
import { withCatalogPublicationWriter } from '../supabase/functions/drive-ops/catalog-publication';
import { withCatalogVideoWriter } from '../supabase/functions/drive-ops/catalog-video-generation';

const snapshot = {
  catalogId: '47000000-0000-4000-8000-000000000001',
  revision: 0,
  mode: 'immediate',
  dueAt: null,
  timeZone: null,
  target: {
    kind: 'source',
    materialId: '47000000-0000-4000-8000-000000000002',
    sourceVersion: '1'
  },
  job: null,
  active: null,
  serverNow: Date.now(),
  providerCas: 'unsupported'
};

it('keeps cell-writing capability separate from provider CAS and command receipts', () => {
  const parsed = parseCatalogPublicationSnapshot(snapshot)!;
  expect(parsed).toBeTruthy();
  expect(withCatalogPublicationWriter(parsed, false)).toBe(parsed);
  const enabled = withCatalogPublicationWriter(parsed, true);
  expect(enabled).toMatchObject({ writerMode: 'video_columns', providerCas: 'unsupported' });
  expect(parsed).not.toHaveProperty('writerMode');
  expect(withCatalogPublicationWriter(null, true)).toBeNull();
  expect(parseCatalogPublicationSnapshot(enabled)).toMatchObject({ writerMode: 'video_columns' });
  expect(parseCatalogPublicationSnapshot({ ...snapshot, writerMode: 'whole_file' })).toBeNull();
});
it('removes the stored unsupported stamp from creation progress only where the writer answers', () => {
  const progress = { videoSetId: 'set', state: 'ready', providerCas: 'unsupported' };
  const result = {
    outcome: 'created',
    videoGeneration: progress,
    videoGenerationObservation: { ...progress, publicationHeld: false }
  };
  expect(withCatalogVideoWriter(result, false)).toBe(result);
  const enabled = withCatalogVideoWriter(result, true);
  expect(enabled.videoGeneration).toEqual({ videoSetId: 'set', state: 'ready' });
  expect(enabled.videoGenerationObservation).toEqual({
    videoSetId: 'set',
    state: 'ready',
    publicationHeld: false
  });
  expect(result.videoGeneration).toHaveProperty('providerCas');
  expect(withCatalogVideoWriter(null, true)).toBeNull();
  const pending = { outcome: 'preparing_video', state: 'preparing' };
  expect(withCatalogVideoWriter(pending, true)).toEqual(pending);
});
