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
    // Shape is enforced by catalogNonVideoContextMismatch below before any use.
    const c = result.data as Record<string, unknown> & {
      contextToken: string;
      productCount: number;
      rootFolderId: string;
    };
    // The context returns credentialId/rootFolderId only for a 'connected' Drive
    // connection, while the claim also admits 'unavailable'. That is a transient
    // provider state, not an inconsistency: retry it instead of failing the round.
    if (c.credentialId === null && c.rootFolderId === null)
      throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
    const mismatch = catalogNonVideoContextMismatch(c, item);
    if (mismatch) {
      // Field name only, never values: the next failure names its cause.
      console.error('[catalog-updater] non-video context mismatch', item.catalogId, mismatch);
      throw uncertain();
    }
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

/** The first field of the prepared non-video context that disagrees with the
 * claimed catalog, or null when the context may be used. */
export function catalogNonVideoContextMismatch(
  c: Record<string, unknown>,
  item: Pick<ClaimedCatalog, 'productCount' | 'driveFileId' | 'credentialId'>
): string | null {
  if (typeof c.contextToken !== 'string' || !/^[a-f0-9]{64}$/u.test(c.contextToken))
    return 'contextToken';
  if (c.currentProductCount !== item.productCount) return 'currentProductCount';
  if (
    typeof c.productCount !== 'number' ||
    !Number.isSafeInteger(c.productCount) ||
    c.productCount < item.productCount ||
    c.productCount > 400
  )
    return 'productCount';
  if (c.fileId !== item.driveFileId) return 'fileId';
  if (c.credentialId !== item.credentialId) return 'credentialId';
  if (typeof c.rootFolderId !== 'string') return 'rootFolderId';
  return null;
}
