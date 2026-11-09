import type { DriveFileMetadata } from '../supabase/functions/_shared/drive';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';
import { expect, it, vi } from 'vitest';
import {
  verifyCatalogVideoBaseline,
  handleCatalogPublicationVerifyRead
} from '../supabase/functions/drive-ops/catalog-publication-baseline';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME
} from '../supabase/functions/_shared/product-catalog';
const SOURCE_MATERIAL = '77000000-0000-4000-8000-000000000111';
const SOURCE_CONNECTION = '77000000-0000-4000-8000-000000000112';
const SOURCE_VERSION = await catalogPublicationSourceIdentity({
  materialId: SOURCE_MATERIAL,
  connectionId: SOURCE_CONNECTION,
  fileId: 'source-file',
  checksum: null,
  mimeType: 'video/mp4',
  sizeBytes: null,
  driveVersion: '1'
});
const capabilities = {
  canDownload: true,
  canListChildren: true,
  canAddChildren: true,
  canRename: true,
  canMoveItemWithinDrive: true,
  canMoveItemOutOfDrive: true,
  canModifyContent: true,
  canTrash: true,
  canUntrash: true
};
const sourceLink = 'https://drive.google.com/file/d/source-file/view';
function setup() {
  const ids = PRODUCT_CATALOG_TEMPLATE.find(c => c.source.kind === 'contentId')!,
    video = PRODUCT_CATALOG_TEMPLATE.find(c => c.source.kind === 'videoLink')!;
  const columns = [
    [ids.description, ids.key, 'opaque1', 'opaque2'],
    [video.description, video.key, sourceLink + '?v=a', sourceLink + '?v=b']
  ];
  const catalogDrive = {
    getFile: vi.fn(async (): Promise<Partial<DriveFileMetadata>> => ({
      id: 'catalog-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      version: '2',
      capabilities
    })),
    getNativeSpreadsheetSheets: vi.fn(async () => [
      {
        sheetId: 0,
        title: PRODUCT_CATALOG_SHEET_NAME,
        rowCount: 1000,
        columnCount: PRODUCT_CATALOG_TEMPLATE.length
      }
    ]),
    readNativeCatalogColumns: vi.fn(async () => columns)
  };
  const sourceDrive = {
    listAnyonePermissions: vi.fn(async () => [{ id: 'anyone', role: 'reader' }]),
    getFile: vi.fn(async (): Promise<Partial<DriveFileMetadata>> => ({
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '1',
      capabilities
    }))
  };
  const scope = {
    catalogMaterialId: 'catalog-material',
    catalogFileId: 'catalog-file',
    catalogResourceKey: null,
    sourceMaterialId: SOURCE_MATERIAL,
    sourceFileId: 'source-file',
    sourceResourceKey: null,
    sourceVersion: SOURCE_VERSION,
    sourceConnectionId: SOURCE_CONNECTION,
    sourceLink,
    catalogRootFolderId: 'root',
    sourceRootFolderId: 'root',
    productCount: 2
  };
  const authorize = vi.fn(async () => {});
  return {
    columns,
    catalogDrive,
    sourceDrive,
    scope,
    authorize,
    input: {
      catalogDrive: catalogDrive as never,
      sourceDrive: sourceDrive as never,
      scope,
      authorize
    }
  };
}
it('derives a verified original source from actual cells without exposing their contents', async () => {
  const h = setup(),
    r = await verifyCatalogVideoBaseline(h.input);
  expect(r.outcome).toBe('source');
  expect(r.videoCellsDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(r)).not.toContain(sourceLink);
  expect(JSON.stringify(r)).not.toContain('opaque1');
  expect(h.authorize).toHaveBeenCalledTimes(2);
  expect(h.catalogDrive.readNativeCatalogColumns).toHaveBeenCalledWith(
    expect.objectContaining({ rowCount: 1000, expectedRows: 4 })
  );
});
it('recognizes a verified initial blank without fabricating active delivery', async () => {
  const h = setup();
  h.columns[1]![2] = '';
  h.columns[1]![3] = '';
  expect(await verifyCatalogVideoBaseline(h.input)).toMatchObject({
    outcome: 'blank',
    target: null
  });
});
it('rejects missing rows, mixed links, formulas and a different source binding', async () => {
  for (const change of [
    (h: ReturnType<typeof setup>) => {
      h.columns[0]![3] = '';
    },
    (h: ReturnType<typeof setup>) => {
      h.columns[1]![2] = '';
    },
    (h: ReturnType<typeof setup>) => {
      h.columns[1]![2] = '=HYPERLINK("' + sourceLink + '")';
    },
    (h: ReturnType<typeof setup>) => {
      h.columns[1]![2] = 'https://drive.google.com/file/d/other/view';
    }
  ]) {
    const h = setup();
    change(h);
    await expect(verifyCatalogVideoBaseline(h.input)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  }
});
it('refuses source/catalog changes and revoked access during readback', async () => {
  const h = setup();
  h.sourceDrive.getFile
    .mockResolvedValueOnce({
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '1',
      capabilities
    })
    .mockResolvedValueOnce({
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '2',
      capabilities
    });
  await expect(verifyCatalogVideoBaseline(h.input)).rejects.toThrow('SOURCE_CHANGED');
  const revoked = setup();
  revoked.authorize.mockResolvedValueOnce().mockRejectedValueOnce(Error('PERMISSION_DENIED'));
  await expect(verifyCatalogVideoBaseline(revoked.input)).rejects.toThrow('PERMISSION_DENIED');
});
it('keeps baseline recovery an exact readonly lookup without provider activity', async () => {
  const id = '77000000-0000-4000-8000-000000000001',
    rpc = vi.fn(async () => ({ data: null, error: null }));
  expect(
    await handleCatalogPublicationVerifyRead({ rpc }, id, {
      teamId: id,
      catalogId: id,
      requestId: id,
      expectedActorId: id
    })
  ).toBeNull();
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith(
    'service_read_catalog_baseline_check',
    expect.objectContaining({ p_check: id, p_actor: id })
  );
});

it('exposes a proven aborted baseline as a definite retryable new observation boundary', async () => {
  const id = '77000000-0000-4000-8000-000000000001',
    rpc = vi.fn(async () => ({ data: null, error: { message: 'WRONG_STATE' } }));
  await expect(
    handleCatalogPublicationVerifyRead({ rpc }, id, {
      teamId: id,
      catalogId: id,
      requestId: id,
      expectedActorId: id
    })
  ).rejects.toThrow('WRONG_STATE');
  expect(rpc).toHaveBeenCalledOnce();
});

it('does not mistake owner OAuth access for public accessibility of an existing video link', async () => {
  const h = setup();
  h.sourceDrive.listAnyonePermissions.mockResolvedValueOnce([]);
  await expect(verifyCatalogVideoBaseline(h.input)).rejects.toThrow('PERMISSION_DENIED');
});

it('accepts a publication-only sharing bump when immutable content identity remains proven', async () => {
  const h = setup(),
    metadata = {
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '1',
      checksum: 'a'.repeat(32),
      mimeType: 'video/mp4',
      size: 31,
      capabilities
    };
  h.scope.sourceVersion = await catalogPublicationSourceIdentity({
    materialId: SOURCE_MATERIAL,
    connectionId: SOURCE_CONNECTION,
    fileId: 'source-file',
    checksum: metadata.checksum,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.size,
    driveVersion: '1'
  });
  h.sourceDrive.getFile
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce({ ...metadata, version: '2' });
  expect((await verifyCatalogVideoBaseline(h.input)).outcome).toBe('source');
  const changed = setup();
  changed.scope.sourceVersion = h.scope.sourceVersion;
  changed.sourceDrive.getFile
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce({ ...metadata, checksum: 'b'.repeat(32) });
  await expect(verifyCatalogVideoBaseline(changed.input)).rejects.toThrow('SOURCE_CHANGED');
});
