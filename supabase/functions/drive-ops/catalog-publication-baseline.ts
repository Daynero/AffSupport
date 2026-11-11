import { catalogPublicationSourceIdentity } from '../../../packages/shared/dist/team/catalog-publication-source.js';
import { proveLiveAncestry, type GoogleDriveClient } from '../_shared/drive.ts';
import {
  PRODUCT_CATALOG_SHEET_NAME,
  PRODUCT_CATALOG_TEMPLATE,
  SPREADSHEET_MIME_TYPE
} from '../_shared/product-catalog.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
export interface CatalogBaselineScope {
  readonly catalogMaterialId: string;
  readonly catalogFileId: string;
  readonly catalogResourceKey: string | null;
  readonly sourceMaterialId: string;
  readonly sourceFileId: string;
  readonly sourceResourceKey: string | null;
  readonly sourceVersion: string;
  readonly catalogRootFolderId: string;
  readonly sourceRootFolderId: string;
  readonly sourceConnectionId: string;
  readonly sourceLink: string;
  readonly productCount: number;
}
export type VerifiedCatalogVideoBaseline = Readonly<{
  catalogMaterialId: string;
  providerRevision: string;
  videoCellsDigest: string;
  outcome: 'blank' | 'source';
  target: Readonly<{ kind: 'source'; materialId: string; sourceVersion: string }> | null;
}>;
const unknown = () => new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
function canonicalSourceLink(link: string, fileId: string): string {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw unknown();
  }
  if (
    u.protocol !== 'https:' ||
    u.hostname !== 'drive.google.com' ||
    u.username ||
    u.password ||
    u.hash
  )
    throw unknown();
  const id = /^\/file\/d\/([^/]+)(?:\/|$)/u.exec(u.pathname)?.[1] ?? u.searchParams.get('id');
  if (id !== fileId) throw unknown();
  u.searchParams.delete('v');
  return u.href;
}
/** Read-only proof of actual template/video cells under a stable provider
 * revision. Metadata/configured videoLink alone is never publication evidence. */
export async function verifyCatalogVideoBaseline(input: {
  scope: CatalogBaselineScope;
  catalogDrive: Pick<
    GoogleDriveClient,
    'getFile' | 'getNativeSpreadsheetSheets' | 'readNativeCatalogColumns'
  >;
  sourceDrive: Pick<GoogleDriveClient, 'getFile' | 'listAnyonePermissions'>;
  authorize: () => Promise<void>;
}): Promise<VerifiedCatalogVideoBaseline> {
  const scope = Object.freeze({ ...input.scope });
  if (
    !Number.isSafeInteger(scope.productCount) ||
    scope.productCount < 1 ||
    scope.productCount > 400
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const idColumn = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'contentId');
  const videoColumn = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'videoLink');
  if (idColumn < 0 || videoColumn < 0) throw unknown();
  await input.authorize();
  const before = await proveLiveAncestry({
    client: input.catalogDrive,
    fileId: scope.catalogFileId,
    rootFolderId: scope.catalogRootFolderId,
    resourceKey: scope.catalogResourceKey,
    maximumDepth: 16
  });
  if (
    before.id !== scope.catalogFileId ||
    before.trashed ||
    before.mimeType !== SPREADSHEET_MIME_TYPE ||
    !before.version
  )
    throw unknown();
  if (!before.capabilities.canModifyContent) throw new TeamFunctionError('PERMISSION_DENIED');
  const source = await proveLiveAncestry({
    client: input.sourceDrive,
    fileId: scope.sourceFileId,
    rootFolderId: scope.sourceRootFolderId,
    resourceKey: scope.sourceResourceKey,
    maximumDepth: 16
  });
  if (source.id !== scope.sourceFileId || source.trashed)
    throw new TeamFunctionError('SOURCE_CHANGED');
  if (!source.capabilities.canDownload) throw new TeamFunctionError('PERMISSION_DENIED');
  const identity = async (metadata: typeof source) => {
    if (
      !scope.sourceVersion.startsWith('content-v1:') &&
      !scope.sourceVersion.startsWith('strict-v1:')
    )
      throw new TeamFunctionError('SOURCE_CHANGED');
    try {
      return await catalogPublicationSourceIdentity(
        {
          materialId: scope.sourceMaterialId,
          connectionId: scope.sourceConnectionId,
          fileId: metadata.id,
          checksum: metadata.checksum ?? null,
          mimeType: metadata.mimeType ?? null,
          sizeBytes: metadata.size ?? null,
          driveVersion: metadata.version
        },
        scope.sourceVersion.startsWith('strict-v1:')
      );
    } catch {
      throw new TeamFunctionError('SOURCE_CHANGED');
    }
  };
  if ((await identity(source)) !== scope.sourceVersion)
    throw new TeamFunctionError('SOURCE_CHANGED');
  const expected = canonicalSourceLink(scope.sourceLink, scope.sourceFileId);
  const sheets = await input.catalogDrive.getNativeSpreadsheetSheets(scope.catalogFileId);
  const sheet = sheets.find(s => s.title === PRODUCT_CATALOG_SHEET_NAME);
  if (
    !sheet ||
    sheets.filter(s => s.title === PRODUCT_CATALOG_SHEET_NAME).length !== 1 ||
    sheet.rowCount < scope.productCount + 2 ||
    sheet.rowCount > 10000 ||
    sheet.columnCount <= Math.max(idColumn, videoColumn)
  )
    throw unknown();
  const columns = await input.catalogDrive.readNativeCatalogColumns({
    fileId: scope.catalogFileId,
    sheetName: PRODUCT_CATALOG_SHEET_NAME,
    columns: [idColumn, videoColumn],
    rowCount: sheet.rowCount,
    expectedRows: scope.productCount + 2
  });
  const [ids, videos] = columns;
  if (
    !ids ||
    !videos ||
    columns.length !== 2 ||
    ids.length !== scope.productCount + 2 ||
    videos.length !== scope.productCount + 2 ||
    ids[1] !== PRODUCT_CATALOG_TEMPLATE[idColumn].key ||
    videos[1] !== PRODUCT_CATALOG_TEMPLATE[videoColumn].key
  )
    throw unknown();
  const productIds = ids.slice(2),
    links = videos.slice(2);
  if (
    productIds.some(id => !id || id.length > 100 || id.startsWith('=')) ||
    new Set(productIds).size !== scope.productCount
  )
    throw unknown();
  const blank = links.every(link => link === '');
  if (
    !blank &&
    links.some(link => !link || canonicalSourceLink(link, scope.sourceFileId) !== expected)
  )
    throw unknown();
  if (
    !blank &&
    !(await input.sourceDrive.listAnyonePermissions(scope.sourceFileId)).some(p =>
      ['reader', 'writer', 'commenter'].includes(p.role)
    )
  )
    throw new TeamFunctionError('PERMISSION_DENIED');
  const after = await proveLiveAncestry({
    client: input.catalogDrive,
    fileId: scope.catalogFileId,
    rootFolderId: scope.catalogRootFolderId,
    resourceKey: scope.catalogResourceKey,
    maximumDepth: 16
  });
  const sourceAfter = await proveLiveAncestry({
    client: input.sourceDrive,
    fileId: scope.sourceFileId,
    rootFolderId: scope.sourceRootFolderId,
    resourceKey: scope.sourceResourceKey,
    maximumDepth: 16
  });
  await input.authorize();
  if (
    after.id !== before.id ||
    after.trashed ||
    after.version !== before.version ||
    sourceAfter.id !== source.id ||
    sourceAfter.trashed
  )
    throw new TeamFunctionError('SOURCE_CHANGED');
  if ((await identity(sourceAfter)) !== scope.sourceVersion)
    throw new TeamFunctionError('SOURCE_CHANGED');
  if (!after.capabilities.canModifyContent || !sourceAfter.capabilities.canDownload)
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    !blank &&
    !(await input.sourceDrive.listAnyonePermissions(scope.sourceFileId)).some(p =>
      ['reader', 'writer', 'commenter'].includes(p.role)
    )
  )
    throw new TeamFunctionError('PERMISSION_DENIED');
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({ ids: productIds, links }))
    )
  );
  return Object.freeze({
    catalogMaterialId: scope.catalogMaterialId,
    providerRevision: after.version!,
    videoCellsDigest: Array.from(digest, b => b.toString(16).padStart(2, '0')).join(''),
    outcome: blank ? 'blank' : 'source',
    target: blank
      ? null
      : Object.freeze({
          kind: 'source',
          materialId: scope.sourceMaterialId,
          sourceVersion: scope.sourceVersion
        })
  });
}

interface BaselineRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
const baselineUuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(x);
const baselineRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
/** Private backend entry. The public body contains identities only. Outcome and
 * digest are produced by provider readback inside this function, never supplied
 * by a client checkbox or an arbitrary "verified" boolean. */
export async function handleCatalogPublicationVerify(
  service: BaselineRpcClient,
  actorId: string,
  body: Record<string, unknown>,
  driveFor: (credentialId: string) => Promise<GoogleDriveClient>
) {
  if (!baselineUuid(actorId) || body.expectedActorId !== actorId)
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (
    !baselineUuid(body.teamId) ||
    !baselineUuid(body.catalogId) ||
    !baselineUuid(body.requestId) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 1
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const ids = { p_check: body.requestId, p_team: body.teamId, p_actor: actorId };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const r = await service.rpc(name, args);
    if (r.error) throw unknown();
    return r.data;
  };
  const raw = await rpc('service_begin_catalog_baseline_check', {
    ...ids,
    p_catalog: body.catalogId,
    p_expected_revision: body.expectedRevision
  });
  if (!baselineRecord(raw)) throw unknown();
  // The catalog's creation-time verification is still open: the server re-runs
  // that one (against the catalog's real target) and was just made due now.
  if (raw.state === 'initial_reverify')
    throw new TeamFunctionError('CATALOG_UPDATE_RECONCILIATION_REQUIRED', { retryable: true });
  // Imported lazily only for the replay branch below; no provider work repeats.
  const { parseCatalogPublicationSnapshot } =
    await import('../../../packages/shared/dist/team/catalog-publication-api.js');
  if (raw.receipt !== undefined) {
    const prior = parseCatalogPublicationSnapshot(raw.receipt);
    if (!prior || prior.catalogId !== body.catalogId || prior.revision !== body.expectedRevision)
      throw unknown();
    return prior;
  }
  if (
    raw.checkId !== body.requestId ||
    raw.catalogMaterialId !== body.catalogId ||
    !baselineUuid(raw.fence) ||
    !baselineUuid(raw.catalogCredentialId) ||
    !baselineUuid(raw.sourceCredentialId) ||
    !baselineUuid(raw.sourceMaterialId) ||
    !baselineUuid(raw.sourceConnectionId) ||
    typeof raw.catalogFileId !== 'string' ||
    typeof raw.sourceFileId !== 'string' ||
    typeof raw.sourceVersion !== 'string' ||
    typeof raw.sourceLink !== 'string' ||
    typeof raw.catalogRootFolderId !== 'string' ||
    typeof raw.sourceRootFolderId !== 'string' ||
    !Number.isSafeInteger(raw.productCount) ||
    (raw.catalogResourceKey !== null && typeof raw.catalogResourceKey !== 'string') ||
    (raw.sourceResourceKey !== null && typeof raw.sourceResourceKey !== 'string')
  )
    throw unknown();
  const fence = raw.fence;
  const scope: CatalogBaselineScope = Object.freeze({
    catalogMaterialId: raw.catalogMaterialId as string,
    catalogFileId: raw.catalogFileId,
    catalogResourceKey: raw.catalogResourceKey,
    sourceMaterialId: raw.sourceMaterialId,
    sourceFileId: raw.sourceFileId,
    sourceResourceKey: raw.sourceResourceKey,
    sourceVersion: raw.sourceVersion,
    sourceLink: raw.sourceLink,
    catalogRootFolderId: raw.catalogRootFolderId,
    sourceRootFolderId: raw.sourceRootFolderId,
    sourceConnectionId: raw.sourceConnectionId,
    productCount: raw.productCount as number
  });
  let finishDispatched = false;
  try {
    const catalogDrive = await driveFor(raw.catalogCredentialId);
    const sourceDrive =
      raw.sourceCredentialId === raw.catalogCredentialId
        ? catalogDrive
        : await driveFor(raw.sourceCredentialId);
    const proof = await verifyCatalogVideoBaseline({
      scope,
      catalogDrive,
      sourceDrive,
      authorize: async () => {
        const ctx = await rpc('service_authorize_catalog_baseline_check', {
          ...ids,
          p_fence: fence
        });
        if (
          !baselineRecord(ctx) ||
          ctx.checkId !== body.requestId ||
          ctx.fence !== fence ||
          ctx.catalogMaterialId !== scope.catalogMaterialId ||
          ctx.catalogFileId !== scope.catalogFileId ||
          ctx.sourceMaterialId !== scope.sourceMaterialId ||
          ctx.sourceConnectionId !== scope.sourceConnectionId ||
          ctx.sourceFileId !== scope.sourceFileId ||
          ctx.sourceVersion !== scope.sourceVersion ||
          ctx.productCount !== scope.productCount ||
          ctx.catalogRootFolderId !== scope.catalogRootFolderId ||
          ctx.sourceRootFolderId !== scope.sourceRootFolderId
        )
          throw unknown();
      }
    });
    finishDispatched = true;
    const receipt = await rpc('service_finish_catalog_baseline_check', {
      ...ids,
      p_fence: fence,
      p_outcome: proof.outcome,
      p_provider_revision: proof.providerRevision,
      p_video_cells_digest: proof.videoCellsDigest
    });
    const parsed = parseCatalogPublicationSnapshot(receipt);
    if (!parsed || parsed.catalogId !== body.catalogId || parsed.revision !== body.expectedRevision)
      throw unknown();
    return parsed;
  } catch (error) {
    // A lost finish reply must be resolved using the original check receipt; do
    // not remove its fence or admit another baseline check on uncertain commit.
    if (!finishDispatched)
      await rpc('service_abort_catalog_baseline_check', { ...ids, p_fence: fence }).catch(
        () => undefined
      );
    throw error;
  }
}

/** Exact original observation only: no begin/claim/provider/finish operation. */
export async function handleCatalogPublicationVerifyRead(
  service: BaselineRpcClient,
  actorId: string,
  body: Record<string, unknown>
) {
  if (!baselineUuid(actorId) || body.expectedActorId !== actorId)
    throw new TeamFunctionError('PERMISSION_DENIED');
  if (!baselineUuid(body.teamId) || !baselineUuid(body.catalogId) || !baselineUuid(body.requestId))
    throw new TeamFunctionError('INVALID_INPUT');
  const result = await service.rpc('service_read_catalog_baseline_check', {
    p_check: body.requestId,
    p_team: body.teamId,
    p_actor: actorId,
    p_catalog: body.catalogId
  });
  if (result.error) {
    if (baselineRecord(result.error) && result.error.message === 'WRONG_STATE')
      throw new TeamFunctionError('WRONG_STATE', { retryable: false });
    throw unknown();
  }
  if (result.data === null) return null;
  const { parseCatalogPublicationSnapshot } =
    await import('../../../packages/shared/dist/team/catalog-publication-api.js');
  const snapshot = parseCatalogPublicationSnapshot(result.data);
  if (!snapshot || snapshot.catalogId !== body.catalogId) throw unknown();
  return snapshot;
}
