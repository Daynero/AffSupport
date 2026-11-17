import type { ServiceRpcClient } from '../_shared/credentials.ts';
import type { GoogleDriveClient } from '../_shared/drive.ts';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME
} from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { proveLiveAncestry } from '../_shared/drive.ts';

/** Pauses before reading a sheet again whose version moved during the read. */
const STABLE_READ_WAITS_MS = [1_500, 3_000, 5_000] as const;

type InitialPublicationDrive = Pick<
  GoogleDriveClient,
  'getFile' | 'getNativeSpreadsheetSheets' | 'readNativeCatalogColumns'
>;
/** Verifies the new catalog's exact frozen generated cells. This does not write
 * provider data, reconstruct legacy delivery or use metadata URLs as evidence. */
export async function verifyInitialCatalogPublication(
  service: ServiceRpcClient,
  scope: {
    teamId: string;
    actorId: string;
    intentId: string;
    catalogMaterialId: string;
  },
  driveFor: (credentialId: string) => Promise<InitialPublicationDrive>,
  validateTarget?: () => Promise<void>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<void> {
  const args = {
    p_team: scope.teamId,
    p_actor: scope.actorId,
    p_intent: scope.intentId,
    p_catalog: scope.catalogMaterialId
  };
  const result = await service.rpc('service_begin_initial_catalog_publication', args);
  if (result.error || !isRecord(result.data))
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  const context = result.data;
  if (context.state === 'verified') return;
  if (
    typeof context.credentialId !== 'string' ||
    typeof context.fileId !== 'string' ||
    typeof context.rootFolderId !== 'string' ||
    typeof context.fence !== 'string' ||
    !Array.isArray(context.rows) ||
    context.rows.length < 3 ||
    context.rows.length > 402
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  const rows = context.rows;
  const idIndex = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'contentId');
  const videoIndex = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'videoLink');
  const expected = [idIndex, videoIndex].map(index =>
    rows.map(row => {
      if (
        !Array.isArray(row) ||
        !isRecord(row[index]) ||
        row[index].t !== 'string' ||
        typeof row[index].v !== 'string'
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return row[index].v as string;
    })
  );
  const drive = await driveFor(context.credentialId);
  // A native sheet's Drive version moves without its cells changing: sharing it, and
  // Sheets settling a freshly converted upload, each advance it. A read that straddled
  // such a move is read again; only different cells mean the catalog changed. next QA
  // 2026-11-17: a launch stopped at «Реєструємо каталог» with «Файл змінився» while
  // every cell was exactly what was written — the version moved during a slow read.
  let actual: unknown;
  let after: Awaited<ReturnType<InitialPublicationDrive['getFile']>> | undefined;
  for (let round = 0; ; round += 1) {
    const before = await drive.getFile(context.fileId);
    await proveLiveAncestry({
      client: drive,
      fileId: context.fileId,
      rootFolderId: context.rootFolderId,
      maximumDepth: 16
    });
    const sheets = await drive.getNativeSpreadsheetSheets(context.fileId);
    const sheet = sheets.find(s => s.title === PRODUCT_CATALOG_SHEET_NAME);
    if (!sheet || sheet.columnCount !== PRODUCT_CATALOG_TEMPLATE.length)
      throw new TeamFunctionError('SOURCE_CHANGED');
    actual = await drive.readNativeCatalogColumns({
      fileId: context.fileId,
      sheetName: PRODUCT_CATALOG_SHEET_NAME,
      columns: [idIndex, videoIndex],
      rowCount: sheet.rowCount,
      expectedRows: expected[0]!.length
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new TeamFunctionError('SOURCE_CHANGED');
    after = await drive.getFile(context.fileId);
    await proveLiveAncestry({
      client: drive,
      fileId: context.fileId,
      rootFolderId: context.rootFolderId,
      maximumDepth: 16
    });
    if (after.capabilities.canModifyContent !== true) throw new TeamFunctionError('SOURCE_CHANGED');
    if (before.version && before.version === after.version) break;
    if (round >= STABLE_READ_WAITS_MS.length)
      // Still moving: not a change, an unproven read. Recovery lists this code for
      // catalog video protocol 1 and comes back after the pause.
      throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', {
        retryable: true,
        details: { retryAfterMs: 60_000 }
      });
    await sleep(STABLE_READ_WAITS_MS[round]!);
  }
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(actual)))
    )
  )
    .map(v => v.toString(16).padStart(2, '0'))
    .join('');
  await validateTarget?.();
  const finished = await service.rpc('service_finish_initial_catalog_publication', {
    ...args,
    p_fence: context.fence,
    p_provider_revision: after!.version,
    p_cells_digest: digest
  });
  if (finished.error || finished.data !== true)
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
}
