// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CatalogMaterialItem, LandingRenderPointer } from '../packages/shared/src/team/index';
import { deriveLandingGalleryItems } from '../apps/web/src/team/landings/useTeamLandings';

const material: CatalogMaterialItem = {
  id: 'm1',
  teamId: 'team-1',
  parentFolderId: null,
  name: 'Landing',
  kind: 'file',
  category: 'landing',
  mimeType: 'text/html',
  fileExtension: 'html',
  classificationVersion: 1,
  classificationSource: 'inspected_landing',
  sizeBytes: 12,
  modifiedAt: null,
  geo: null,
  language: null,
  offer: null,
  tags: [],
  transcriptIngestState: 'not_applicable',
  transcriptTruncated: false,
  previewState: 'ready',
  lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
};

const ready: LandingRenderPointer = {
  materialId: 'm1',
  state: 'ready',
  sourceVersion: '7',
  fingerprint: 'a'.repeat(64),
  preset: 'default',
  artifact: {
    materialId: 'm1',
    sourceVersion: '7',
    fingerprint: 'a'.repeat(64),
    preset: 'default',
    segmentCount: 2,
    artifactToken: 'opaque-token'
  }
};

describe('shared team landing render lifecycle', () => {
  it('keeps a ready shared render viewable without a local agent', () => {
    const [item] = deriveLandingGalleryItems([material], [ready], {
      agentPaired: false,
      agentCompatible: false,
      canDownload: false,
      canEdit: false
    });
    expect(item.tile).toBe('ready');
    expect(item.render?.artifact?.artifactToken).toBe('opaque-token');
  });

  it('never reports an absent or stale render as ready', () => {
    expect(
      deriveLandingGalleryItems([material], [], {
        agentPaired: false,
        agentCompatible: false,
        canDownload: false,
        canEdit: false
      })[0].tile
    ).toBe('needs_agent');
    expect(
      deriveLandingGalleryItems([material], [{ ...ready, state: 'stale', artifact: undefined }], {
        agentPaired: false,
        agentCompatible: false,
        canDownload: false,
        canEdit: false
      })[0].tile
    ).toBe('needs_agent');
  });

  it('presents a generic failed render as an explicit retryable error', () => {
    const [item] = deriveLandingGalleryItems(
      [material],
      [{ ...ready, state: 'failed', artifact: undefined, failureReason: 'render_error' }],
      {
        agentPaired: true,
        agentCompatible: true,
        canDownload: false,
        canEdit: false
      }
    );
    expect(item).toMatchObject({ tile: 'error', unavailableReason: 'render_error' });
  });

  it('distinguishes an outdated paired agent from a missing agent', () => {
    const [item] = deriveLandingGalleryItems([material], [], {
      agentPaired: true,
      agentCompatible: false,
      canDownload: true,
      canEdit: true
    });
    expect(item.tile).toBe('agent_outdated');
    expect(item.canDownload).toBe(true);
    expect(item.canEdit).toBe(true);
  });

  it('treats only an unvalidated archive as a candidate, not a direct HTML landing', () => {
    const directHtml = { ...material, classificationSource: 'mime' as const };
    const archive = {
      ...material,
      id: 'm2',
      name: 'Candidate.zip',
      category: 'archive' as const,
      mimeType: 'application/zip',
      fileExtension: 'zip',
      classificationSource: 'extension' as const
    };
    const [htmlItem, archiveItem] = deriveLandingGalleryItems([directHtml, archive], [], {
      agentPaired: false,
      agentCompatible: false,
      canDownload: false,
      canEdit: false
    });
    expect(htmlItem).toMatchObject({ isCandidate: false, tile: 'needs_agent' });
    expect(archiveItem).toMatchObject({ isCandidate: true, tile: 'candidate' });
  });
});
