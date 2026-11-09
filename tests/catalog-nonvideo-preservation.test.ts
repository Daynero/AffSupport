import { expect, it, vi } from 'vitest';
import {
  createCatalogNonVideoUpdater,
  CATALOG_NONVIDEO_MARKER
} from '../supabase/functions/catalog-updater/nonvideo-writer';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME
} from '../supabase/functions/_shared/product-catalog';
import {
  rebuildCatalogRows,
  catalogVideoColumnIndices
} from '../supabase/functions/_shared/catalog-updater';
import type { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import type { ClaimedCatalog } from '../supabase/functions/catalog-updater/worker';
function fixture(cells: string[]) {
  const item = {
    catalogId: 'catalog',
    productCount: 2,
    driveFileId: 'sheet',
    credentialId: 'credential',
    resourceKey: null,
    settings: {
      title: 'Refreshed',
      description: 'Updated text',
      price: 20,
      imageLink: 'https://fixture.invalid/image'
    },
    sourceLink: 'https://fixture.invalid/source',
    videoLink: 'https://fixture.invalid/PENDING'
  } as ClaimedCatalog;
  const rows = rebuildCatalogRows({ record: item, preservedVideoCells: cells });
  const markers: string[] = [];
  let version = '1';
  const read = vi.fn(
    async ({ columns, expectedRows }: { columns: number[]; expectedRows: number }) =>
      columns.map(c =>
        Array.from({ length: expectedRows }, (_, r) => String(rows[r]?.[c]?.v ?? ''))
      )
  );
  const drive = {
    getFile: vi.fn(async (id: string) => ({
      id,
      version,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['root'],
      trashed: false,
      shortcutTargetId: null,
      capabilities: { canModifyContent: true }
    })),
    getNativeSpreadsheetSheets: vi.fn(async () => [
      {
        sheetId: 0,
        title: PRODUCT_CATALOG_SHEET_NAME,
        rowCount: 1000,
        columnCount: PRODUCT_CATALOG_TEMPLATE.length
      }
    ]),
    readNativeCatalogColumns: read,
    writeNativeSpreadsheetCells: vi.fn(
      async ({
        updates,
        marker
      }: {
        updates: Array<{ rowIndex: number; columnIndex: number; values: string[] }>;
        marker: { key: string; value: string };
      }) => {
        for (const u of updates)
          u.values.forEach((v, i) => {
            rows[u.rowIndex + i]![u.columnIndex] = { t: 'string', v };
          });
        expect(marker.key).toBe(CATALOG_NONVIDEO_MARKER);
        markers.push(marker.value);
        version = '2';
      }
    ),
    readNativeSpreadsheetMarkers: vi.fn(async () => markers)
  };
  const rpc = vi.fn(async () => ({
    data: {
      attemptId: 'original',
      currentProductCount: 2,
      productCount: 2,
      fileId: 'sheet',
      credentialId: 'credential',
      rootFolderId: 'root',
      contextToken: 'a'.repeat(64)
    },
    error: null
  }));
  return {
    item,
    rows,
    drive,
    rpc,
    prepare: createCatalogNonVideoUpdater(
      { rpc },
      'worker',
      async () => drive as unknown as GoogleDriveClient
    )
  };
}
it.each([
  ['https://fixture.invalid/ACTIVE?old=1', 'https://fixture.invalid/ACTIVE?old=2'],
  ['', '']
])(
  'preserves actual stored video cells during ordinary refresh, independent of null active metadata',
  async (a, b) => {
    const f = fixture([a, b]),
      update = await f.prepare(f.item),
      rows = rebuildCatalogRows({
        record: { ...f.item, settings: { ...f.item.settings, title: 'NEW' } },
        preservedVideoCells: update.videoCells
      });
    await update.write(rows, 'original-marker');
    await update.verify('original-marker');
    for (const c of catalogVideoColumnIndices())
      expect(f.rows.slice(2).map(r => r[c]!.v)).toEqual([a, b]);
    expect(JSON.stringify(f.drive.writeNativeSpreadsheetCells.mock.calls)).not.toContain('PENDING');
    expect(f.rows.some(row => row.some(cell => cell.v === 'NEW'))).toBe(true);
  }
);
it('refuses incomplete provider evidence rather than calling it an empty initial catalog', async () => {
  const f = fixture(['', '']);
  f.drive.readNativeCatalogColumns.mockResolvedValue([[], []]);
  await expect(f.prepare(f.item)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(f.drive.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
});
it('retains an uncertain result when actual video cells change around a nonvideo write', async () => {
  const f = fixture(['https://fixture.invalid/old', 'https://fixture.invalid/old']);
  const update = await f.prepare(f.item);
  await update.write(
    rebuildCatalogRows({ record: f.item, preservedVideoCells: update.videoCells }),
    'marker'
  );
  f.rows[2]![catalogVideoColumnIndices()[0]!] = {
    t: 'string',
    v: 'https://fixture.invalid/external'
  };
  await expect(update.verify('marker')).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});
