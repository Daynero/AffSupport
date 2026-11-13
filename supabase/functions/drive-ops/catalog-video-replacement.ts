import {
  parseCatalogVideoReplacementRequest,
  parseCatalogVideoReplacementReceipt,
  type CatalogVideoReplacementReceipt
} from '../../../packages/shared/dist/team/catalog-video-replacement.js';
import { isLaunchUuid } from '../../../packages/shared/dist/team/launches.js';
import { catalogPublicationSourceIdentity } from '../../../packages/shared/dist/team/catalog-publication-source.js';
import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { proveLiveAncestry, type GoogleDriveClient } from '../_shared/drive.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import {
  parseFrozenPublicationCells,
  verifyPublicationCells,
  type PublicationCellsDrive
} from '../catalog-updater/publication-cells.ts';

type ReplacementDrive = PublicationCellsDrive &
  Pick<GoogleDriveClient, 'getCatalogRenameFile' | 'moveCatalogConditionally'>;
export interface CatalogVideoReplacementDeps {
  service: ServiceRpcClient;
  driveFor: (credentialId: string) => Promise<ReplacementDrive>;
}
async function rpc(service: ServiceRpcClient, name: string, args: Record<string, unknown>) {
  const result = await service.rpc(name, args);
  if (result.error) {
    const code = TEAM_ERROR_CODES.find(code => code === result.error?.message);
    throw new TeamFunctionError(code ?? 'DRIVE_UNAVAILABLE');
  }
  return result.data;
}
function field(value: Record<string, unknown>, key: string): string {
  const v = value[key];
  if (typeof v !== 'string' || !v || v.length > 2000)
    throw new TeamFunctionError('INVALID_RESPONSE');
  return v;
}
/** The existing publication lane is the only video-cell writer. This worker only places
 * a verified document and commits its binding, with an exact conditional move receipt. */
export async function recoverCatalogVideoReplacement(
  deps: CatalogVideoReplacementDeps,
  requestId: string
): Promise<void> {
  const workerId = crypto.randomUUID();
  const raw = await rpc(deps.service, 'service_claim_catalog_video_replacement', {
    p_request: requestId,
    p_worker: workerId
  });
  if (raw === null) return;
  try {
    if (
      !isRecord(raw) ||
      raw.request_id !== requestId ||
      !isLaunchUuid(raw.source_material_id) ||
      !isLaunchUuid(raw.connection_id)
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const frozen = parseFrozenPublicationCells(raw.frozen);
    if (
      !frozen ||
      frozen.fileId !== raw.catalog_file_id ||
      frozen.rootFolderId !== raw.rootFolderId
    )
      throw new TeamFunctionError('INVALID_RESPONSE');
    const drive = await deps.driveFor(field(raw, 'credentialId'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const sourceMaterialId = raw.source_material_id,
        sourceConnectionId = raw.connection_id;
      const verifySource = async () => {
        const source = await proveLiveAncestry({
          client: drive,
          fileId: field(raw, 'sourceFileId'),
          rootFolderId: field(raw, 'rootFolderId'),
          resourceKey: typeof raw.sourceResourceKey === 'string' ? raw.sourceResourceKey : null
        });
        const identity = await catalogPublicationSourceIdentity(
          {
            materialId: sourceMaterialId,
            connectionId: sourceConnectionId,
            fileId: source.id,
            checksum: source.checksum,
            mimeType: source.mimeType,
            sizeBytes: source.size,
            driveVersion: source.version
          },
          field(raw, 'source_version').startsWith('strict-v1:')
        );
        if (
          identity !== raw.source_version ||
          source.trashed ||
          source.capabilities.canDownload !== true ||
          (raw.move_to_video_folder === true &&
            !source.parents.includes(field(raw, 'destination_parent_id')))
        )
          throw new TeamFunctionError('SOURCE_CHANGED');
      };
      await verifySource();
      let catalog = await proveLiveAncestry({
        client: drive,
        fileId: frozen.fileId,
        rootFolderId: frozen.rootFolderId
      });
      const destination = field(raw, 'destination_parent_id');
      const original = field(raw, 'original_parent_id');
      if (
        catalog.name !== raw.catalog_name ||
        catalog.parents.length !== 1 ||
        ![original, destination].includes(catalog.parents[0]!)
      )
        throw new TeamFunctionError('SOURCE_CHANGED');
      await verifyReplacementCells(drive, frozen);
      if (catalog.parents[0] !== destination) {
        const folder = await proveLiveAncestry({
          client: drive,
          fileId: destination,
          rootFolderId: frozen.rootFolderId
        });
        if (
          folder.mimeType !== 'application/vnd.google-apps.folder' ||
          folder.capabilities.canAddChildren !== true ||
          catalog.capabilities.canMoveItemWithinDrive !== true
        )
          throw new TeamFunctionError('PERMISSION_DENIED');
        const current = await drive.getCatalogRenameFile(catalog.id, controller.signal);
        if (
          current.name !== raw.catalog_name ||
          current.parents.length !== 1 ||
          current.parents[0] !== original ||
          current.trashed ||
          (raw.move_dispatched_at !== null && current.etag !== raw.move_etag)
        )
          throw new TeamFunctionError('SOURCE_CHANGED');
        await rpc(deps.service, 'service_prepare_catalog_video_move', {
          p_request: requestId,
          p_worker: workerId,
          p_etag: current.etag
        });
        await drive.moveCatalogConditionally(
          catalog.id,
          current.etag,
          original,
          destination,
          controller.signal
        );
        catalog = await drive.getFile(catalog.id);
      }
      controller.signal.throwIfAborted();
      if (
        catalog.trashed ||
        catalog.name !== raw.catalog_name ||
        catalog.parents.length !== 1 ||
        catalog.parents[0] !== destination ||
        !catalog.version
      )
        throw new TeamFunctionError('SOURCE_CHANGED');
      await verifyReplacementCells(drive, frozen);
      await verifySource();
      catalog = await drive.getFile(catalog.id);
      if (
        catalog.trashed ||
        catalog.name !== raw.catalog_name ||
        catalog.parents.length !== 1 ||
        catalog.parents[0] !== destination ||
        !catalog.version
      )
        throw new TeamFunctionError('SOURCE_CHANGED');
      await rpc(deps.service, 'service_finish_catalog_video_replacement', {
        p_request: requestId,
        p_worker: workerId,
        p_observed: {
          id: catalog.id,
          name: catalog.name,
          parentId: destination,
          version: catalog.version
        }
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (cause) {
    const code = cause instanceof TeamFunctionError ? cause.code : 'PROCESS_RESULT_UNCERTAIN';
    await rpc(deps.service, 'service_defer_catalog_video_replacement', {
      p_request: requestId,
      p_worker: workerId,
      p_code: code
    });
  }
}
async function verifyReplacementCells(
  drive: PublicationCellsDrive,
  frozen: NonNullable<ReturnType<typeof parseFrozenPublicationCells>>
): Promise<void> {
  const result = await verifyPublicationCells(drive, frozen);
  if (result.outcome !== 'verified')
    throw new TeamFunctionError(
      result.outcome === 'unknown' && result.reason === 'SOURCE_CHANGED'
        ? 'SOURCE_CHANGED'
        : 'PROCESS_RESULT_UNCERTAIN'
    );
}
export async function recoverCatalogVideoReplacements(
  deps: CatalogVideoReplacementDeps,
  limit = 1
) {
  const due = await rpc(deps.service, 'service_due_catalog_video_replacements', { p_limit: limit });
  if (!Array.isArray(due) || !due.every(isLaunchUuid))
    throw new TeamFunctionError('INVALID_RESPONSE');
  for (const id of due) await recoverCatalogVideoReplacement(deps, id);
}
export async function handleCatalogVideoReplacement(
  service: ServiceRpcClient,
  actorId: string,
  path: 'context' | 'submit' | 'status',
  raw: unknown
): Promise<unknown> {
  if (
    !isRecord(raw) ||
    !isLaunchUuid(raw.teamId) ||
    !isLaunchUuid(raw.catalogId) ||
    raw.expectedActorId !== actorId
  )
    throw new TeamFunctionError('PERMISSION_DENIED');
  const scope = { p_team: raw.teamId, p_catalog: raw.catalogId, p_actor: actorId };
  if (path === 'context') return rpc(service, 'service_catalog_video_replacement_context', scope);
  if (path === 'submit') {
    const request = parseCatalogVideoReplacementRequest(raw);
    if (!request) throw new TeamFunctionError('INVALID_INPUT');
    const result = await rpc(service, 'service_accept_catalog_video_replacement', {
      ...scope,
      p_request: request
    });
    return checkedReceipt(
      result,
      request.teamId,
      request.catalogId,
      request.requestId,
      request.newVideoId
    );
  }
  if (!isLaunchUuid(raw.requestId)) throw new TeamFunctionError('INVALID_INPUT');
  const result = await rpc(service, 'service_catalog_video_replacement_status', {
    ...scope,
    p_request: raw.requestId
  });
  return result === null ? null : checkedReceipt(result, raw.teamId, raw.catalogId, raw.requestId);
}
function checkedReceipt(
  raw: unknown,
  team: string,
  catalog: string,
  request: string,
  newVideo?: string
): CatalogVideoReplacementReceipt {
  const r = parseCatalogVideoReplacementReceipt(raw);
  if (
    !r ||
    r.teamId !== team ||
    r.catalogId !== catalog ||
    r.requestId !== request ||
    (newVideo !== undefined && r.newVideoId !== newVideo)
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return r;
}
