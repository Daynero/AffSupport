import type { GoogleDriveClient } from '../_shared/drive.ts';
import { proveLiveAncestry } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

export interface FrozenPublicationCells {
  readonly fileId: string;
  readonly rootFolderId: string;
  readonly sheetName: string;
  readonly sheetId: number;
  readonly idColumn: number;
  readonly videoColumn: number;
  /** Header/description rows are verified, never rewritten. */
  readonly idHeaders: readonly [string, string];
  readonly videoHeaders: readonly [string, string];
  readonly products: readonly { readonly id: string; readonly url: string }[];
  readonly markerKey: string;
  readonly markerValue: string;
  readonly previousMarker?: string;
  readonly recipeRowIds?: readonly string[];
}
export type PublicationCellsDrive = Pick<
  GoogleDriveClient,
  | 'getFile'
  | 'getNativeSpreadsheetSheets'
  | 'readNativeCatalogColumns'
  | 'writeNativeSpreadsheetCells'
  | 'readNativeSpreadsheetMarkers'
>;
export function parseFrozenPublicationCells(value: unknown): FrozenPublicationCells | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    ['fileId', 'rootFolderId', 'sheetName', 'markerKey', 'markerValue'].some(
      k => typeof v[k] !== 'string' || !(v[k] as string).length || (v[k] as string).length > 1024
    ) ||
    ['sheetId', 'idColumn', 'videoColumn'].some(
      k => !Number.isSafeInteger(v[k]) || (v[k] as number) < 0
    ) ||
    (v.idColumn as number) >= 64 ||
    (v.videoColumn as number) >= 64 ||
    v.idColumn === v.videoColumn ||
    ['idHeaders', 'videoHeaders'].some(
      k =>
        !Array.isArray(v[k]) ||
        (v[k] as unknown[]).length !== 2 ||
        (v[k] as unknown[]).some(x => typeof x !== 'string' || x.length > 8192)
    ) ||
    !Array.isArray(v.products) ||
    v.products.length < 1 ||
    v.products.length > 400
  )
    return null;
  if (
    v.previousMarker !== undefined &&
    (typeof v.previousMarker !== 'string' || v.previousMarker.length > 1024 || !v.previousMarker)
  )
    return null;
  const ids = new Set<string>();
  for (const p of v.products) {
    if (
      !p ||
      typeof p !== 'object' ||
      typeof p.id !== 'string' ||
      !p.id ||
      p.id.length > 8192 ||
      ids.has(p.id) ||
      typeof p.url !== 'string' ||
      p.url.length > 8192 ||
      !/^https:\/\//u.test(p.url)
    )
      return null;
    ids.add(p.id);
  }
  return value as FrozenPublicationCells;
}
const changed = () => new TeamFunctionError('SOURCE_CHANGED');
/** Identity, headers, complete ID set and write permission are checked freshly.
 * Product reorder is allowed: the stored ID->URL recipe is never resampled. */
async function observe(drive: PublicationCellsDrive, frozen: FrozenPublicationCells) {
  if (
    frozen.products.length < 1 ||
    frozen.products.length > 400 ||
    new Set(frozen.products.map(p => p.id)).size !== frozen.products.length ||
    frozen.products.some(p => !p.id || !/^https:\/\//u.test(p.url))
  )
    throw changed();
  const file = await drive.getFile(frozen.fileId);
  if (!file.version || file.capabilities.canModifyContent !== true) throw changed();
  await proveLiveAncestry({
    client: drive,
    fileId: frozen.fileId,
    rootFolderId: frozen.rootFolderId,
    maximumDepth: 16
  });
  const sheets = await drive.getNativeSpreadsheetSheets(frozen.fileId);
  const sheet = sheets.find(s => s.sheetId === frozen.sheetId && s.title === frozen.sheetName);
  if (!sheet || sheet.columnCount <= Math.max(frozen.idColumn, frozen.videoColumn)) throw changed();
  const [ids, videos] = await drive.readNativeCatalogColumns({
    fileId: frozen.fileId,
    sheetName: frozen.sheetName,
    columns: [frozen.idColumn, frozen.videoColumn],
    rowCount: sheet.rowCount,
    expectedRows: frozen.products.length + 2
  });
  if (
    !ids ||
    !videos ||
    ids[0] !== frozen.idHeaders[0] ||
    ids[1] !== frozen.idHeaders[1] ||
    videos[0] !== frozen.videoHeaders[0] ||
    videos[1] !== frozen.videoHeaders[1]
  )
    throw changed();
  const recipe = new Map(frozen.products.map(p => [p.id, p.url]));
  const productIds = ids.slice(2);
  if (new Set(productIds).size !== frozen.products.length || productIds.some(id => !recipe.has(id)))
    throw changed();
  const after = await drive.getFile(frozen.fileId);
  if (after.version !== file.version || after.capabilities.canModifyContent !== true)
    throw changed();
  return {
    ids: productIds,
    videos: videos.slice(2),
    links: productIds.map(id => recipe.get(id)!),
    version: after.version
  };
}
/** Exactly one dispatch per durable fence. Callers must persist dispatch BEFORE
 * invoking this function and must only verify after any uncertain response. */
export async function applyPublicationCells(
  drive: PublicationCellsDrive,
  frozen: FrozenPublicationCells
): Promise<void> {
  const markers = await drive.readNativeSpreadsheetMarkers(frozen.fileId, frozen.markerKey);
  // An existing receipt is read-only reconciliation territory, never another write.
  if (markers.length > 1 || (markers.length === 1 && markers[0] !== frozen.previousMarker))
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  const current = await observe(drive, frozen);
  await drive.writeNativeSpreadsheetCells({
    fileId: frozen.fileId,
    updates: [
      {
        sheetId: frozen.sheetId,
        rowIndex: 2,
        columnIndex: frozen.videoColumn,
        values: current.links
      }
    ],
    marker: {
      key: frozen.markerKey,
      value: frozen.markerValue,
      ...(markers.length === 1 ? { replacesValue: markers[0] } : {})
    }
  });
}
/** `absent`: the atomic batch (cells + this fence's marker) is provably not in the
 * sheet — no marker of this fence, the previous receipt (if any) still in place,
 * and the sheet itself still readable. Time since dispatch is judged by the server. */
export async function verifyPublicationCells(
  drive: PublicationCellsDrive,
  frozen: FrozenPublicationCells
): Promise<
  | { outcome: 'verified'; providerRevision: string; verifiedAt: string }
  | { outcome: 'unknown'; reason?: 'SOURCE_CHANGED' }
  | { outcome: 'absent' }
> {
  try {
    const markers = await drive.readNativeSpreadsheetMarkers(frozen.fileId, frozen.markerKey);
    const previous = frozen.previousMarker ? [frozen.previousMarker] : [];
    if (
      markers.length === previous.length &&
      markers.every((marker, index) => marker === previous[index])
    ) {
      await observe(drive, frozen);
      const again = await drive.readNativeSpreadsheetMarkers(frozen.fileId, frozen.markerKey);
      return again.length === previous.length &&
        again.every((marker, index) => marker === previous[index])
        ? { outcome: 'absent' }
        : { outcome: 'unknown' };
    }
    if (markers.length !== 1 || markers[0] !== frozen.markerValue) return { outcome: 'unknown' };
    const current = await observe(drive, frozen);
    if (current.links.some((url, index) => current.videos[index] !== url))
      return { outcome: 'unknown' };
    const markersAfter = await drive.readNativeSpreadsheetMarkers(frozen.fileId, frozen.markerKey);
    if (markersAfter.length !== 1 || markersAfter[0] !== frozen.markerValue)
      return { outcome: 'unknown' };
    return {
      outcome: 'verified',
      providerRevision: current.version!,
      verifiedAt: new Date().toISOString()
    };
  } catch (cause) {
    // Still unknown — a changed sheet is never proof of absence — but say why. Production
    // 2026-11-13 (DreamTeam, TR 82_v2): the id column was refilled by hand a minute after
    // dispatch, every verification since failed on the recipe, and with the reason swallowed
    // the stale-job close (400400) never saw SOURCE_CHANGED: «ще не підтверджено» for good.
    return cause instanceof TeamFunctionError && cause.code === 'SOURCE_CHANGED'
      ? { outcome: 'unknown', reason: 'SOURCE_CHANGED' }
      : { outcome: 'unknown' };
  }
}
