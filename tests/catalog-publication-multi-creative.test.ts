/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import {
  createTargetedCatalogPublicationIo,
  publicationCellKind,
  publicationRowLinks
} from '../supabase/functions/catalog-updater/publication-io.js';
import { parseFrozenPublicationCells } from '../supabase/functions/catalog-updater/publication-cells.js';
import { PRODUCT_CATALOG_TEMPLATE } from '../supabase/functions/_shared/product-catalog.js';
import { CATALOG_IMAGE_COLUMN } from '../supabase/functions/_shared/catalog-updater.js';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';

/**
 * 062 (R26, R33, T064): the publication lane of a `creatives` target writes each block's own
 * link — Z for a video block, H for an image catalog — and an image link reaches H only after
 * a signed-out reader got it, again, right before the write.
 */
const uuid = (n: number) => '62000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ID = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'contentId');
const Z = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'videoLink');

describe('row links of a creatives target', () => {
  it('repeats each block’s link over its rows', () => {
    const links = publicationRowLinks(
      {
        sources: [{ materialId: 'A' }, { materialId: 'B' }],
        productCount: 5,
        segments: [
          { materialId: 'A', rowStart: 0, rowCount: 3 },
          { materialId: 'B', rowStart: 3, rowCount: 2 }
        ]
      },
      id => `https://x.test/${id}`
    );
    expect(links).toEqual([
      'https://x.test/A',
      'https://x.test/A',
      'https://x.test/A',
      'https://x.test/B',
      'https://x.test/B'
    ]);
  });
  it('keeps one receipt per row and the single source as before', () => {
    expect(
      publicationRowLinks(
        { sources: [{ materialId: 'A' }, { materialId: 'B' }], productCount: 2 },
        id => id
      )
    ).toEqual(['A', 'B']);
    expect(
      publicationRowLinks(
        { sources: [{ materialId: 'A' }], productCount: 3, sourceOnly: true },
        id => id
      )
    ).toEqual(['A', 'A', 'A']);
  });
  it('refuses blocks that leave a gap', () => {
    expect(() =>
      publicationRowLinks(
        {
          sources: [{ materialId: 'A' }, { materialId: 'B' }],
          productCount: 4,
          segments: [
            { materialId: 'A', rowStart: 0, rowCount: 1 },
            { materialId: 'B', rowStart: 2, rowCount: 2 }
          ]
        },
        id => id
      )
    ).toThrow();
  });
  it('knows an image catalog by its kind', () => {
    expect(publicationCellKind({ creativeKind: 'image' })).toBe('image');
    expect(publicationCellKind({})).toBe('video');
  });
});

describe('frozen payloads', () => {
  const frozen = {
    fileId: 'sheet',
    rootFolderId: 'root',
    sheetName: 'catalog_products',
    sheetId: 0,
    idColumn: ID,
    videoColumn: Z,
    idHeaders: ['a', 'b'],
    videoHeaders: ['c', 'd'],
    products: [{ id: 'p1', url: 'https://x.test/1' }],
    markerKey: 'soty_video_publication',
    markerValue: 'job'
  };
  it('still reads a payload frozen before 062', () => {
    expect(parseFrozenPublicationCells(frozen)).not.toBeNull();
  });
  it('reads the image cell kind and refuses others', () => {
    expect(
      parseFrozenPublicationCells({
        ...frozen,
        videoColumn: CATALOG_IMAGE_COLUMN,
        cellKind: 'image'
      })
    ).not.toBeNull();
    expect(parseFrozenPublicationCells({ ...frozen, cellKind: 'audio' })).toBeNull();
  });
});

describe('an image catalog’s lane', () => {
  async function harness(options: { r2?: boolean; anonymousFails?: boolean } = {}) {
    const materials = [uuid(10), uuid(11)];
    const sources = await Promise.all(
      materials.map(async (materialId, index) => ({
        kind: 'image',
        materialId,
        connectionId: uuid(2),
        fileId: `file-${index}`,
        credentialId: uuid(3),
        rootFolderId: 'root',
        ...(options.r2 ? { r2: true, imageUrl: `https://images.test/c1/${materialId}` } : {}),
        sourceVersion: await catalogPublicationSourceIdentity({
          materialId,
          connectionId: uuid(2),
          fileId: `file-${index}`,
          checksum: 'a'.repeat(32),
          mimeType: 'image/jpeg',
          sizeBytes: 17,
          driveVersion: '1'
        })
      }))
    );
    const links: unknown[] = [];
    let prepared: unknown = null;
    const context = () => ({
      state: 'ready',
      phase: 'eager',
      creativeKind: 'image',
      sources,
      segments: [
        { ordinal: 0, kind: 'image', materialId: materials[0], rowStart: 0, rowCount: 2 },
        { ordinal: 1, kind: 'image', materialId: materials[1], rowStart: 2, rowCount: 1 }
      ],
      links,
      productCount: 3,
      prepared,
      credentialId: uuid(3),
      fileId: 'sheet',
      rootFolderId: 'root'
    });
    const calls: string[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'service_catalog_publication_cells_context')
        return { error: null, data: context() };
      if (name === 'service_record_catalog_publication_link') {
        links.push({
          materialId: args.p_material,
          sourceVersion: args.p_source_version,
          url: args.p_url,
          kind: args.p_link_kind,
          dueVerified: true
        });
        return { error: null, data: true };
      }
      if (name === 'service_prepare_catalog_publication_cells') {
        prepared = args.p_payload;
        return { error: null, data: args.p_payload };
      }
      return { error: null, data: true };
    });
    const shared = new Set<string>();
    const columns = (indices: number[]) =>
      indices.map(index => [
        PRODUCT_CATALOG_TEMPLATE[index].description,
        PRODUCT_CATALOG_TEMPLATE[index].key,
        ...(index === ID ? ['p1', 'p2', 'p3'] : ['w', 'w', 'w'])
      ]);
    const drive = {
      getFile: vi.fn(async (id: string) => ({
        id,
        version: '1',
        parents: ['root'],
        trashed: false,
        shortcutTargetId: null,
        resourceKey: null,
        checksum: 'a'.repeat(32),
        mimeType: id === 'sheet' ? 'application/vnd.google-apps.spreadsheet' : 'image/jpeg',
        size: 17,
        capabilities: { canDownload: true, canShare: true, canModifyContent: true }
      })),
      listAnyonePermissions: vi.fn(async (id: string) =>
        shared.has(id) ? [{ id: 'p', role: 'reader' }] : []
      ),
      createAnyoneReaderPermission: vi.fn(async (id: string) => {
        shared.add(id);
        return { id: 'p', role: 'reader' };
      }),
      getNativeSpreadsheetSheets: vi.fn(async () => [
        {
          title: 'catalog_products',
          sheetId: 0,
          rowCount: 5,
          columnCount: PRODUCT_CATALOG_TEMPLATE.length
        }
      ]),
      readNativeCatalogColumns: vi.fn(async ({ columns: wanted }) => columns(wanted)),
      writeNativeSpreadsheetCells: vi.fn(),
      readNativeSpreadsheetMarkers: vi.fn(async () => [])
    };
    const verifyAnonymous = vi.fn(async () => {
      if (options.anonymousFails)
        throw Object.assign(new Error('PUBLIC_READ_UNVERIFIED'), {
          code: 'PUBLIC_READ_UNVERIFIED'
        });
      return { mime: 'image/jpeg', size: 10 };
    });
    const io = createTargetedCatalogPublicationIo(
      { rpc } as never,
      uuid(7),
      async () => drive as never,
      {
        verifyAnonymous
      }
    );
    return { io, rpc, calls, drive, verifyAnonymous, links, prepared: () => prepared, materials };
  }
  const scope = { teamId: uuid(1), actorId: uuid(2), jobId: uuid(4) };

  it('freezes H with each block’s Drive picture link after an anonymous read', async () => {
    const h = await harness();
    await expect(h.io.availability({}, scope)).resolves.toBe('ready');
    const frozen = h.prepared();
    expect(frozen.videoColumn).toBe(CATALOG_IMAGE_COLUMN);
    expect(frozen.cellKind).toBe('image');
    expect(frozen.markerKey).toBe('soty_image_publication');
    expect(frozen.videoHeaders).toEqual([
      PRODUCT_CATALOG_TEMPLATE[CATALOG_IMAGE_COLUMN].description,
      PRODUCT_CATALOG_TEMPLATE[CATALOG_IMAGE_COLUMN].key
    ]);
    expect(frozen.products.map(p => p.url)).toEqual([
      'https://drive.google.com/uc?export=view&id=file-0',
      'https://drive.google.com/uc?export=view&id=file-0',
      'https://drive.google.com/uc?export=view&id=file-1'
    ]);
    expect(h.drive.createAnyoneReaderPermission).toHaveBeenCalledTimes(2);
    expect(h.verifyAnonymous).toHaveBeenCalledTimes(2);
    expect(h.links.map(l => l.kind)).toEqual(['drive', 'drive']);
  });

  it('uses the R2 copy when the catalog’s option is on, never sharing the file', async () => {
    const h = await harness({ r2: true });
    await h.io.availability({}, scope);
    expect(h.prepared().products.map(p => p.url)).toEqual([
      `https://images.test/c1/${h.materials[0]}`,
      `https://images.test/c1/${h.materials[0]}`,
      `https://images.test/c1/${h.materials[1]}`
    ]);
    expect(h.drive.createAnyoneReaderPermission).not.toHaveBeenCalled();
    expect(h.links.map(l => l.kind)).toEqual(['r2', 'r2']);
  });

  it('writes nothing while a signed-out reader cannot get the picture', async () => {
    const h = await harness({ anonymousFails: true });
    await expect(h.io.availability({}, scope)).rejects.toBeTruthy();
    expect(h.calls).not.toContain('service_record_catalog_publication_link');
    expect(h.calls).not.toContain('service_prepare_catalog_publication_cells');
  });
});
