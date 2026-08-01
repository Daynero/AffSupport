import { describe, expect, it } from 'vitest';
import {
  decodeCatalogSearchResponse,
  normalizeCatalogSearchRequest,
  normalizeMaterialMetadataPatch
} from '../packages/shared/src/team/catalog-search';

describe('catalog search request normalization', () => {
  it('normalizes Unicode, combined facets, unfilled fields, and paging deterministically', () => {
    expect(
      normalizeCatalogSearchRequest({
        query: '  Cafe\u0301   launch  ',
        filters: {
          geo: ['ua', 'US', 'UA'],
          language: ['PT-br', 'uk'],
          offer: ['  Summer   Sale ', 'summer sale'],
          category: ['video'],
          originalType: [' VIDEO/MP4 ', '.MP4'],
          unfilled: ['geo', 'language', 'geo']
        },
        page: 2,
        pageSize: 25
      })
    ).toEqual({
      query: 'Café launch',
      filters: {
        geo: ['UA', 'US'],
        language: ['pt-BR', 'uk'],
        offer: ['summer sale'],
        category: ['video'],
        originalType: ['video/mp4', 'mp4'],
        kind: [],
        unfilled: ['geo', 'language']
      },
      page: 2,
      pageSize: 25
    });
  });

  it('rejects unknown filters and out-of-contract pagination', () => {
    expect(normalizeCatalogSearchRequest({ filters: { secret: ['value'] } })).toBeNull();
    expect(normalizeCatalogSearchRequest({ page: 0, pageSize: 101 })).toBeNull();
  });
});

describe('metadata-only patch normalization', () => {
  it('normalizes controlled values and case-insensitively deduplicates offer/tags', () => {
    expect(
      normalizeMaterialMetadataPatch({
        geo: 'ua',
        language: 'PT-br',
        offer: '  Summer   Sale ',
        tags: [' UGC ', 'ugc', 'Креатив']
      })
    ).toEqual({
      geo: 'UA',
      language: 'pt-BR',
      offer: 'Summer Sale',
      tags: ['UGC', 'Креатив']
    });
  });

  it('rejects Drive/system/content keys rather than silently applying them', () => {
    expect(normalizeMaterialMetadataPatch({ geo: 'UA', name: 'leak.mp4' })).toBeNull();
    expect(normalizeMaterialMetadataPatch({ transcriptText: 'forbidden' })).toBeNull();
  });
});

describe('closed search response decoding', () => {
  const teamId = '20000000-0000-4000-8000-000000000001';
  const response = {
    items: [
      {
        id: 'material-visible',
        teamId,
        name: 'launch.mp4',
        kind: 'file',
        category: 'video',
        mimeType: 'video/mp4',
        fileExtension: 'mp4',
        classificationVersion: 1,
        classificationSource: 'mime',
        sizeBytes: 1024,
        modifiedAt: '2026-08-01T12:00:00.000Z',
        geo: 'UA',
        language: 'uk',
        offer: 'Summer Sale',
        tags: ['UGC'],
        transcriptIngestState: 'not_applicable',
        transcriptTruncated: false,
        previewState: 'ready',
        lineage: { hasSource: false, hasDerivatives: false, isVersion: false }
      }
    ],
    total: 1,
    activeFilters: {},
    facets: { geo: [{ value: 'UA', count: 1 }] },
    catalogFreshness: { state: 'ready', lastSyncedAt: '2026-08-01T12:00:00.000Z' }
  };

  it('decodes a visible page without exposing transcript content', () => {
    expect(decodeCatalogSearchResponse(response, teamId)).toMatchObject({ total: 1 });
    expect(JSON.stringify(decodeCatalogSearchResponse(response, teamId))).not.toContain(
      'transcriptText'
    );
  });

  it('fails closed if a hidden-team row appears in an otherwise valid payload', () => {
    expect(
      decodeCatalogSearchResponse(
        {
          ...response,
          items: [{ ...response.items[0], teamId: 'hidden-team-id' }]
        },
        teamId
      )
    ).toBeNull();
  });
});
