import { expect, it, vi } from 'vitest';
import { verifyInitialCatalogPublication } from '../supabase/functions/drive-ops/catalog-initial-publication';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME
} from '../supabase/functions/_shared/product-catalog';
import type { GoogleDriveClient, DriveFileMetadata } from '../supabase/functions/_shared/drive';
const scope = {
  teamId: 'team',
  actorId: 'actor',
  intentId: 'intent',
  catalogMaterialId: 'catalog'
};
function fixture() {
  const rows = [
    PRODUCT_CATALOG_TEMPLATE.map(c => ({ t: 'string', v: c.description })),
    PRODUCT_CATALOG_TEMPLATE.map(c => ({ t: 'string', v: c.key })),
    PRODUCT_CATALOG_TEMPLATE.map(c => ({
      t: 'string',
      v: c.source.kind === 'contentId' ? 'product-id' : ''
    }))
  ];
  const cols = ['contentId', 'videoLink'].map(kind => {
    const n = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === kind);
    return rows.map(row => row[n]!.v);
  });
  const rpc = vi.fn(async (name: string): Promise<{ data: unknown; error: null }> => ({
    data:
      name === 'service_begin_initial_catalog_publication'
        ? {
            state: 'reading',
            credentialId: 'credential',
            fileId: 'file',
            rootFolderId: 'root',
            fence: 'fence',
            rows
          }
        : true,
    error: null
  }));
  const metadata = (id: string): DriveFileMetadata =>
    ({
      id,
      name: id,
      mimeType:
        id === 'root'
          ? 'application/vnd.google-apps.folder'
          : 'application/vnd.google-apps.spreadsheet',
      parents: id === 'root' ? [] : ['root'],
      trashed: false,
      shortcutTargetId: null,
      version: '1',
      size: null,
      checksum: null,
      resourceKey: null,
      capabilities: {
        canDownload: true,
        canListChildren: true,
        canAddChildren: true,
        canRename: true,
        canMoveItemWithinDrive: true,
        canMoveItemOutOfDrive: true,
        canModifyContent: true,
        canTrash: true,
        canUntrash: true
      }
    }) as DriveFileMetadata;
  const drive = {
    getFile: vi.fn(async (id: string) => metadata(id)),
    getNativeSpreadsheetSheets: vi.fn(async () => [
      {
        sheetId: 0,
        title: PRODUCT_CATALOG_SHEET_NAME,
        rowCount: 1000,
        columnCount: PRODUCT_CATALOG_TEMPLATE.length
      }
    ]),
    readNativeCatalogColumns: vi.fn(async () => cols)
  };
  return { rpc, drive, cols };
}
it('proves exact blank generated cells before registering initial delivery and runs final target validation', async () => {
  const f = fixture(),
    validate = vi.fn(async () => {});
  await verifyInitialCatalogPublication(
    f,
    scope,
    async () => f.drive as unknown as GoogleDriveClient,
    validate
  );
  expect(validate).toHaveBeenCalledOnce();
  expect(f.rpc).toHaveBeenLastCalledWith(
    'service_finish_initial_catalog_publication',
    expect.objectContaining({
      p_provider_revision: '1',
      p_cells_digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    })
  );
});
it('refuses changed actual cells without fabricating proof', async () => {
  const f = fixture();
  f.drive.readNativeCatalogColumns.mockResolvedValueOnce([
    f.cols[0]!,
    [...f.cols[1]!.slice(0, 2), 'https://foreign.invalid']
  ]);
  await expect(
    verifyInitialCatalogPublication(f, scope, async () => f.drive as unknown as GoogleDriveClient)
  ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(f.rpc).toHaveBeenCalledTimes(1);
});
it('reconciles an already verified initial receipt without provider reads', async () => {
  const f = fixture();
  f.rpc.mockResolvedValueOnce({ data: { state: 'verified' }, error: null });
  await verifyInitialCatalogPublication(
    f,
    scope,
    async () => f.drive as unknown as GoogleDriveClient
  );
  expect(f.drive.getFile).not.toHaveBeenCalled();
});
