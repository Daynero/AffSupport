import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { proveLiveAncestry, type GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  CATALOG_IMAGE_COLUMN,
  catalogNonVideoCellUpdates,
  catalogPreservedColumnIndices,
  catalogPreservedHeaderUpdates,
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
    const previousMarker = expectedPreviousMarker(c, prior);
    if (
      prior.length > 1 ||
      (prior.length === 1 && prior[0] !== previousMarker) ||
      (typeof previousMarker === 'string' && prior[0] !== previousMarker)
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
    // The sheet is Soty's output, and people edit it: paste a column from another catalog,
    // retype a heading, delete rows, add a column, rename the tab. None of that is a reason
    // not to update — the update is what puts the sheet back. So nothing below asks what the
    // cells hold. It finds the tab, keeps the product cells of the columns that belong to the
    // publication lane as they are, and the write restores everything else: headings, ids and
    // every product row from the records, an empty sheet around them, a grid large enough.
    // Production 2026-11-20 (DreamTeam, TR 84_v1): 62 video links pasted under the last
    // product stopped every update of that catalog for good.
    const sheets = await drive.getNativeSpreadsheetSheets(item.driveFileId);
    let sheet = sheets.find(s => s.title === PRODUCT_CATALOG_SHEET_NAME),
      stable = before;
    if (!sheet && sheets.length === 1) {
      // A renamed tab is still the catalog when it is the only one. It gets its name back
      // first, on its own, so every read and write below addresses it as usual.
      await drive.renameNativeSpreadsheetSheet({
        fileId: item.driveFileId,
        sheetId: sheets[0]!.sheetId,
        title: PRODUCT_CATALOG_SHEET_NAME
      });
      sheet = { ...sheets[0]!, title: PRODUCT_CATALOG_SHEET_NAME };
      stable = await drive.getFile(item.driveFileId, item.resourceKey);
    }
    // Several tabs and none of them the catalog: which one to rewrite is not ours to guess.
    if (!sheet) throw new TeamFunctionError('SOURCE_CHANGED');
    const id = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'contentId');
    const observed = new Map<number, string[]>();
    // 062: an image catalog's H is the publication lane's, read and kept like the video cells.
    const kind = item.creatives?.kind ?? 'video';
    for (const column of catalogPreservedColumnIndices(kind)) {
      // A column someone deleted off the end of the grid holds nothing to keep.
      const actual =
        column < sheet.columnCount
          ? await drive.readNativeCatalogColumns({
              fileId: item.driveFileId,
              sheetName: PRODUCT_CATALOG_SHEET_NAME,
              columns: [id, column],
              rowCount: sheet.rowCount,
              expectedRows: item.productCount + 2,
              tolerant: true
            })
          : [[], Array.from({ length: item.productCount + 2 }, () => '')];
      // The reader's own contract, not the sheet's content: an answer of another shape is
      // incomplete evidence, and incomplete evidence is never read as empty cells.
      if (actual.length !== 2 || actual[1]?.length !== item.productCount + 2) throw uncertain();
      observed.set(column, [
        PRODUCT_CATALOG_TEMPLATE[column]!.description,
        PRODUCT_CATALOG_TEMPLATE[column]!.key,
        ...actual[1].slice(2),
        ...Array.from({ length: productCount - item.productCount }, () => '')
      ]);
    }
    const after = await drive.getFile(item.driveFileId, item.resourceKey);
    if (after.version !== stable.version || after.trashed) throw uncertain();
    const cells = observed.get(catalogVideoColumnIndices()[0]!);
    if (!cells) throw uncertain();
    const imageCells = kind === 'image' ? observed.get(CATALOG_IMAGE_COLUMN) : undefined;
    if (kind === 'image' && !imageCells) throw uncertain();
    return {
      contextToken: c.contextToken,
      productCount: productCount,
      videoCells: cells.slice(2),
      ...(imageCells ? { imageCells: imageCells.slice(2) } : {}),
      ...(Array.isArray(c.recipeRowIds) ? { recipeRowIds: c.recipeRowIds as string[] } : {}),
      async write(rows, marker) {
        if (rows.length !== productCount + 2) throw uncertain();
        await drive.writeNativeSpreadsheetCells({
          fileId: item.driveFileId,
          updates: [
            ...catalogNonVideoCellUpdates(rows, sheet.sheetId, kind),
            ...catalogPreservedHeaderUpdates(sheet.sheetId, kind),
            // Rows this update adds have no published link yet. Whatever sits in their
            // cells now was left under the old last product, and is not a link of theirs.
            ...(productCount > item.productCount
              ? catalogPreservedColumnIndices(kind).map(columnIndex => ({
                  sheetId: sheet.sheetId,
                  rowIndex: item.productCount + 2,
                  columnIndex,
                  values: Array.from({ length: productCount - item.productCount }, () => '')
                }))
              : [])
          ],
          // Everything in the tab outside the headings and the products is emptied, and a
          // grid someone shortened is grown back, in the same batch as the cells.
          frame: {
            sheetId: sheet.sheetId,
            rows: productCount + 2,
            columns: PRODUCT_CATALOG_TEMPLATE.length,
            gridRows: sheet.rowCount,
            gridColumns: sheet.columnCount
          },
          marker: {
            key: CATALOG_NONVIDEO_MARKER,
            value: marker,
            ...(typeof previousMarker === 'string' ? { replacesValue: previousMarker } : {})
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
            rowCount: Math.max(sheet.rowCount, productCount + 2),
            expectedRows: productCount + 2,
            // What someone types under the products after the write is not this write's.
            tolerant: true
          });
          if (JSON.stringify(actual[1]) !== JSON.stringify(expected)) throw uncertain();
        }
      }
    };
  };
}

/** The marker this round may replace. Normally the one the last verified round
 * recorded. Before 20261207210000 recording the change summary erased that
 * record while the sheet kept the marker, so a catalog whose latest verified
 * round lost it (markerRecordLost) adopts the single marker its sheet carries;
 * more than one marker, or a marker without that evidence, stays a refusal. */
export function expectedPreviousMarker(
  c: Record<string, unknown>,
  prior: readonly string[]
): string | null {
  if (typeof c.previousMarker === 'string') return c.previousMarker;
  if (c.markerRecordLost === true && prior.length === 1) return prior[0]!;
  return null;
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
