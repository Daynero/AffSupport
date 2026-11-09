import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { proveLiveAncestry, type GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  catalogNonVideoCellUpdates,
  catalogVideoColumnIndices
} from '../_shared/catalog-updater.ts';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME,
  SPREADSHEET_MIME_TYPE
} from '../_shared/product-catalog.ts';
import type { ClaimedCatalog, CatalogNonVideoUpdate } from './worker.ts';
export const CATALOG_NONVIDEO_MARKER = 'soty_catalog_updater';
const uncertain = () => new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
/** Scoped hosted lease + actual bounded stored cells. A missing active pointer
 * is never used as evidence that an old spreadsheet contains blank cells. */
export function createCatalogNonVideoUpdater(
  service: ServiceRpcClient,
  workerId: string,
  driveFor: (credential: string) => Promise<GoogleDriveClient>
) {
  return async (item: ClaimedCatalog): Promise<CatalogNonVideoUpdate> => {
    const result = await service.rpc('service_prepare_catalog_nonvideo_update_context', {
      p_item: item.catalogId,
      p_worker: workerId
    });
    if (result.error || !isRecord(result.data))
      throw new TeamFunctionError('CATALOG_PUBLICATION_PENDING', { retryable: false });
    const c = result.data;
    if (
      typeof c.contextToken !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(c.contextToken) ||
      c.currentProductCount !== item.productCount ||
      typeof c.productCount !== 'number' ||
      !Number.isSafeInteger(c.productCount) ||
      c.productCount < item.productCount ||
      c.productCount > 400 ||
      c.fileId !== item.driveFileId ||
      c.credentialId !== item.credentialId ||
      typeof c.rootFolderId !== 'string'
    )
      throw uncertain();
    const productCount = c.productCount;
    const drive = await driveFor(item.credentialId),
      before = await drive.getFile(item.driveFileId, item.resourceKey);
    const prior = await drive.readNativeSpreadsheetMarkers(
      item.driveFileId,
      CATALOG_NONVIDEO_MARKER
    );
    if (
      prior.length > 1 ||
      (prior.length === 1 && prior[0] !== c.previousMarker) ||
      (typeof c.previousMarker === 'string' && prior[0] !== c.previousMarker)
    )
      throw uncertain();
    await proveLiveAncestry({
      client: drive,
      fileId: item.driveFileId,
      rootFolderId: c.rootFolderId,
      resourceKey: item.resourceKey,
      maximumDepth: 16
    });
    if (
      before.mimeType !== SPREADSHEET_MIME_TYPE ||
      before.trashed ||
      before.capabilities.canModifyContent !== true ||
      !before.version
    )
      throw uncertain();
    const sheets = await drive.getNativeSpreadsheetSheets(item.driveFileId),
      sheet = sheets.find(s => s.title === PRODUCT_CATALOG_SHEET_NAME);
    if (
      !sheet ||
      sheets.filter(s => s.title === PRODUCT_CATALOG_SHEET_NAME).length !== 1 ||
      sheet.columnCount !== PRODUCT_CATALOG_TEMPLATE.length ||
      sheet.rowCount < productCount + 2
    )
      throw new TeamFunctionError('CATALOG_PUBLICATION_PENDING', { retryable: false });
    const id = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'contentId');
    const observed = new Map<number, string[]>();
    for (const column of catalogVideoColumnIndices()) {
      const actual = await drive.readNativeCatalogColumns({
        fileId: item.driveFileId,
        sheetName: PRODUCT_CATALOG_SHEET_NAME,
        columns: [id, column],
        rowCount: sheet.rowCount,
        expectedRows: item.productCount + 2
      });
      if (
        actual.length !== 2 ||
        actual[0]?.length !== item.productCount + 2 ||
        actual[1]?.length !== item.productCount + 2 ||
        actual[0][0] !== PRODUCT_CATALOG_TEMPLATE[id]!.description ||
        actual[0][1] !== PRODUCT_CATALOG_TEMPLATE[id]!.key ||
        actual[1][0] !== PRODUCT_CATALOG_TEMPLATE[column]!.description ||
        actual[1][1] !== PRODUCT_CATALOG_TEMPLATE[column]!.key
      )
        throw uncertain();
      observed.set(column, [
        ...actual[1],
        ...Array.from({ length: productCount - item.productCount }, () => '')
      ]);
    }
    const after = await drive.getFile(item.driveFileId, item.resourceKey);
    if (after.version !== before.version || after.trashed) throw uncertain();
    const cells = observed.values().next().value as string[] | undefined;
    if (!cells) throw uncertain();
    return {
      contextToken: c.contextToken,
      productCount: productCount,
      videoCells: cells.slice(2),
      ...(Array.isArray(c.recipeRowIds) ? { recipeRowIds: c.recipeRowIds as string[] } : {}),
      async write(rows, marker) {
        if (rows.length !== productCount + 2) throw uncertain();
        await drive.writeNativeSpreadsheetCells({
          fileId: item.driveFileId,
          updates: catalogNonVideoCellUpdates(rows, sheet.sheetId),
          marker: {
            key: CATALOG_NONVIDEO_MARKER,
            value: marker,
            ...(typeof c.previousMarker === 'string' ? { replacesValue: c.previousMarker } : {})
          }
        });
      },
      async verify(marker) {
        const delivered = await drive.getFile(item.driveFileId, item.resourceKey);
        if (
          delivered.id !== item.driveFileId ||
          delivered.trashed ||
          delivered.mimeType !== SPREADSHEET_MIME_TYPE
        )
          throw uncertain();
        await proveLiveAncestry({
          client: drive,
          fileId: item.driveFileId,
          resourceKey: item.resourceKey,
          rootFolderId: c.rootFolderId as string,
          maximumDepth: 16
        });
        if (
          !(
            await drive.readNativeSpreadsheetMarkers(item.driveFileId, CATALOG_NONVIDEO_MARKER)
          ).includes(marker)
        )
          throw uncertain();
        for (const [column, expected] of observed) {
          const actual = await drive.readNativeCatalogColumns({
            fileId: item.driveFileId,
            sheetName: PRODUCT_CATALOG_SHEET_NAME,
            columns: [id, column],
            rowCount: sheet.rowCount,
            expectedRows: productCount + 2
          });
          if (JSON.stringify(actual[1]) !== JSON.stringify(expected)) throw uncertain();
        }
      }
    };
  };
}
