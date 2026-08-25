import { describe, expect, it, vi } from 'vitest';
import { freshnessStub } from './support/catalog-stub.js';
import type {
  CatalogMaterialItem,
  CatalogSearchResponse,
  LandingRenderPointer,
  RenderArtifactRef
} from '../packages/shared/src/team/index.js';
import { buildTeamPreviewCatalogSnapshot } from '../apps/web/src/landing-preview/team-catalog.js';

const teamId = '11111111-1111-1111-1111-111111111111';
const materialId = '22222222-2222-2222-2222-222222222222';

describe('team landing local-previewer interoperability', () => {
  it('enumerates the team catalog and imports every shared WebP segment through opaque grants', async () => {
    const material = landingMaterial();
    const render: LandingRenderPointer = {
      materialId,
      state: 'ready',
      sourceVersion: 'source-7',
      fingerprint: 'a'.repeat(64),
      preset: 'default',
      artifact: artifact(['thumbnail-grant'])
    };
    const searchCatalog = vi.fn().mockResolvedValue(catalogResponse([material]));
    const listLandingRenders = vi.fn().mockResolvedValue([render]);
    const getLandingRenderArtifact = vi
      .fn()
      .mockResolvedValue(artifact(['segment-0-grant', 'segment-1-grant']));
    const landingRenderImageUrl = vi.fn(
      (value: RenderArtifactRef, segment: number) =>
        `https://project.supabase.co/functions/v1/drive-transfer/render-range?grant=${value.segmentTokens?.[segment]}&segment=${segment}`
    );

    const snapshot = await buildTeamPreviewCatalogSnapshot({
      teamId,
      teamName: 'Affiliate Team',
      client: {
        searchCatalog,
        listLandingRenders,
        getLandingRenderArtifact,
        landingRenderImageUrl
      }
    });

    expect(searchCatalog).toHaveBeenCalledWith(teamId, {
      filters: { category: ['landing', 'archive'] },
      page: 1,
      pageSize: 100
    });
    expect(snapshot).toEqual({
      teamId,
      teamName: 'Affiliate Team',
      items: [
        expect.objectContaining({
          materialId,
          name: 'Shared offer',
          state: 'ready',
          sourceVersion: 'source-7',
          fingerprint: 'a'.repeat(64),
          previewUrls: [
            expect.stringContaining('grant=segment-0-grant'),
            expect.stringContaining('grant=segment-1-grant')
          ]
        })
      ]
    });
  });

  it('keeps an unrendered landing truthful instead of fabricating a ready preview', async () => {
    const snapshot = await buildTeamPreviewCatalogSnapshot({
      teamId,
      teamName: 'Affiliate Team',
      client: {
        searchCatalog: vi.fn().mockResolvedValue(catalogResponse([landingMaterial()])),
        listLandingRenders: vi.fn().mockResolvedValue([]),
        getLandingRenderArtifact: vi.fn(),
        landingRenderImageUrl: vi.fn()
      }
    });
    expect(snapshot.items[0]).toMatchObject({ state: 'needs_agent', previewUrls: [] });
  });
});

function landingMaterial(): CatalogMaterialItem {
  return {
    id: materialId,
    teamId,
    parentFolderId: null,
    name: 'Shared offer',
    kind: 'file',
    category: 'landing',
    mimeType: 'text/html',
    fileExtension: 'html',
    classificationVersion: 1,
    classificationSource: 'inspected_landing',
    sizeBytes: 123,
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
}

function catalogResponse(items: CatalogMaterialItem[]): CatalogSearchResponse {
  return {
    items,
    total: items.length,
    activeFilters: { category: ['landing'] },
    facets: {},
    catalogFreshness: freshnessStub({ lastSyncedAt: null })
  };
}

function artifact(segmentTokens: string[]): RenderArtifactRef {
  return {
    materialId,
    sourceVersion: 'source-7',
    fingerprint: 'a'.repeat(64),
    preset: 'default',
    segmentCount: segmentTokens.length,
    artifactToken: segmentTokens[0],
    segmentTokens
  };
}
