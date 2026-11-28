// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import { isCatalogVideoR2PublicUrl } from '../../../packages/shared/dist/team/catalog-video-r2.js';
import { catalogFeedKey, type CatalogFeedStore } from '../_shared/catalog-feed.ts';
import type { DriveFileMetadata } from '../_shared/drive.ts';
import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';
import { isRecord } from '../_shared/validation.ts';
import type { DurableCatalogDrive } from './catalog-durable.ts';
import { catalogFeedIdFor, createCatalogFeedDocumentWriter } from './catalog-feed-document.ts';
import {
  buildUploadConflictPlan,
  catalogConflictSearchPrefix,
  displayDriveName
} from './handler.ts';
import type {
  CatalogDrive,
  CatalogLinkOutcome,
  CatalogVideo,
  CreateProductCatalogRequest,
  ProductCatalogDeps
} from './product-catalog.ts';

/**
 * 057 T041: the storage seam of `/product-catalog/create` for an R2 space (plan «Каталожні
 * маршрути drive-ops»: the catalog stays one implementation, the storage under it changes).
 *
 * What the Drive adapter reads from Drive, this reads from the space (`service_space_catalog_*`);
 * the document is the space's CSV feed (`catalog-feed-document.ts`) committed as an R2 row without
 * an object; the video is linked from its R2 copy, planned under the object's content id and
 * copied by the catalog video worker (`catalog-video-r2`, `CatalogVideoSpaceReader`). Every method
 * that could reach Drive is replaced, and the Drive client handed to the generator refuses any
 * call, so a missed path fails loudly instead of touching a Drive the space does not have.
 */

export type SpaceCatalogRpc = (
  name: string,
  parameters: Record<string, unknown>
) => Promise<unknown>;

export type SpaceCatalogDeps = Pick<
  ProductCatalogDeps,
  | 'loadVideo'
  | 'resolveRestitchedVideo'
  | 'driveFor'
  | 'proveVideo'
  | 'destination'
  | 'planName'
  | 'bindIntent'
  | 'finalize'
  | 'link'
  | 'documentWriter'
  | 'space'
  | 'assertVideoR2Option'
  | 'applyVideoR2Option'
  | 'publishCreativeImages'
  | 'nativeSpreadsheet'
  | 'readCreatedFile'
> & { fullDriveFor: (credentialId: string) => Promise<DurableCatalogDrive> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTENT_ID = /^[0-9a-f]{64}$/u;
const FEED_MIME = 'text/csv';

function refused(): never {
  throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
}

/** A Drive client for a space that has none: every call is refused. */
export function noDriveForSpace(): DurableCatalogDrive & CatalogDrive {
  const refuse = async () => refused();
  return {
    listAnyonePermissions: refuse,
    createAnyoneReaderPermission: refuse,
    createConvertedFile: refuse,
    updateFileMetadata: refuse,
    getFile: refuse,
    findCatalogIntentFiles: refuse,
    createNativeSpreadsheet: refuse,
    getNativeSpreadsheetSheets: refuse,
    writeNativeSpreadsheetRows: refuse,
    writeNativeSpreadsheet: refuse
  } as DurableCatalogDrive & CatalogDrive;
}

interface SpaceMaterial {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  category: string | null;
  mimeType: string | null;
  parentFolderId: string | null;
  sizeBytes: number | null;
  contentId: string | null;
}

function material(value: unknown): SpaceMaterial {
  if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
  const { id, name, kind, category, mimeType, parentFolderId, sizeBytes, contentId } = value;
  const size =
    typeof sizeBytes === 'string' && /^\d{1,15}$/u.test(sizeBytes) ? Number(sizeBytes) : null;
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    typeof name !== 'string' ||
    (kind !== 'file' && kind !== 'folder') ||
    (category !== null && typeof category !== 'string') ||
    (mimeType !== null && typeof mimeType !== 'string') ||
    (parentFolderId !== null &&
      (typeof parentFolderId !== 'string' || !UUID.test(parentFolderId))) ||
    (kind === 'file' &&
      (typeof contentId !== 'string' || !CONTENT_ID.test(contentId) || size === null))
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
  return {
    id,
    name,
    kind,
    category,
    mimeType,
    parentFolderId,
    sizeBytes: size,
    contentId: typeof contentId === 'string' ? contentId : null
  };
}

/**
 * A space material in the shape the generator proves a Drive file with: its parent is its folder,
 * its version is its content id (what a resumed creation compares), nothing is shareable.
 */
function asLiveFile(found: SpaceMaterial): DriveFileMetadata {
  return {
    id: found.id,
    name: found.name,
    mimeType:
      found.kind === 'folder'
        ? 'application/vnd.google-apps.folder'
        : (found.mimeType ?? 'application/octet-stream'),
    parents: found.parentFolderId ? [found.parentFolderId] : [],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: found.kind === 'file',
      canListChildren: found.kind === 'folder',
      canAddChildren: found.kind === 'folder',
      canRename: false,
      canMoveItemWithinDrive: false,
      canMoveItemOutOfDrive: false,
      canModifyContent: false,
      canShare: false,
      canTrash: false,
      canUntrash: false
    },
    size: found.sizeBytes,
    modifiedAt: null,
    version: found.contentId ?? found.id,
    checksum: null,
    appProperties: {}
  };
}

/**
 * The create request an R2 space carries out. The dialog's video protocol (1) without re-stitched
 * videos and published at once makes the same catalog as a request without it, which the space
 * carries out as that. With re-stitched variations published at once (T096) it stays protocol 1
 * — the space's own video authority makes the variations (catalog-space-variants.ts) — but loses
 * what names a Drive executor or the copy option: the member's own agent runs them, and the
 * video of a space's catalog is always its R2 copy. Anything else keeps its fields and is refused
 * before anything is made.
 */
export function spaceCatalogRequest(
  request: CreateProductCatalogRequest
): CreateProductCatalogRequest {
  if (
    request.catalogVideoProtocolVersion === 1 &&
    request.restitchEnabled === true &&
    request.videoPublication?.mode === 'immediate'
  ) {
    const {
      expectedExecutorId: _executor,
      foregroundExecutor: _foreground,
      copyVideoToR2: _copy,
      ...variations
    } = request;
    return variations;
  }
  if (
    request.catalogVideoProtocolVersion !== 1 ||
    request.restitchEnabled !== false ||
    request.videoPublication?.mode !== 'immediate' ||
    request.videoVariationCount !== 1
  )
    return request;
  const {
    catalogVideoProtocolVersion: _protocol,
    restitchEnabled: _restitch,
    videoVariationCount: _count,
    videoPublication: _publication,
    restitchDuration: _duration,
    expectedExecutorId: _executor,
    foregroundExecutor: _foreground,
    copyVideoToR2: _copy,
    ...plain
  } = request;
  return plain;
}

/** Whether an R2 request is the one with re-stitched variations its video authority makes. */
export function spaceCatalogVariations(request: CreateProductCatalogRequest): boolean {
  return (
    request.catalogVideoProtocolVersion === 1 &&
    request.restitchEnabled === true &&
    request.videoPublication?.mode === 'immediate' &&
    !request.restitchOperationId &&
    !request.foregroundExecutor &&
    request.expectedExecutorId === undefined &&
    request.copyVideoToR2 !== true
  );
}

/** What an R2 space cannot make yet, refused before a creation intent exists (same as the generator). */
export function assertSpaceCatalogRequest(request: CreateProductCatalogRequest): void {
  if ((request.creativeKind ?? 'video') !== 'video' || (request.creatives?.length ?? 1) > 1)
    throw new TeamFunctionError('MULTI_CREATIVE_UNSUPPORTED', { retryable: false });
  if (
    request.restitchOperationId ||
    (request.catalogVideoProtocolVersion !== undefined && !spaceCatalogVariations(request))
  )
    throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
}

export function spaceCatalogDeps(input: {
  rpc: SpaceCatalogRpc;
  feeds: CatalogFeedStore;
  signal: AbortSignal;
  log(message: string, detail: string): void;
  /** T096: the variation set the catalog links, once the video authority found it ready. */
  variationSet?: () => string | null;
}): SpaceCatalogDeps {
  const { rpc, feeds, signal, log } = input;
  let actor: string | null = null;
  const read = async (teamId: string, materialId: string, actorId: string, permission: string) =>
    material(
      await rpc('service_space_catalog_material', {
        p_team: teamId,
        p_material: materialId,
        p_actor: actorId,
        p_permission: permission
      })
    );
  const teams = new Map<string, string>();
  const removeFeedQuietly = async (feedId: unknown) => {
    if (typeof feedId !== 'string' || !/^[0-9a-f]{32}$/u.test(feedId)) return;
    try {
      await feeds.removeFeed(catalogFeedKey(feedId), signal);
    } catch (error) {
      log('[catalog-feed] lost the race: feed stayed', mapUnknownError(error).code);
    }
  };
  const drive = noDriveForSpace();
  return {
    nativeSpreadsheet: false,
    fullDriveFor: async () => drive,
    driveFor: async () => drive,
    readCreatedFile: async () => null,
    // No R2 path exists yet for these; the generator refuses them first (CatalogSpaceSource).
    publishCreativeImages: undefined,
    async resolveRestitchedVideo() {
      refused();
    },
    // The copy is not an option in an R2 space: the link records it with the catalog.
    async assertVideoR2Option() {},
    async applyVideoR2Option() {},
    async loadVideo({ teamId, videoId, actorId, permission }) {
      actor = actorId;
      const found = await read(teamId, videoId, actorId, permission);
      if (found.kind !== 'file') throw new TeamFunctionError('NOT_FOUND', { retryable: false });
      teams.set(found.id, teamId);
      return {
        id: found.id,
        name: found.name,
        category: found.category,
        driveFileId: found.id,
        resourceKey: null,
        parentFolderId: found.parentFolderId,
        credentialId: ''
      } satisfies CatalogVideo;
    },
    async proveVideo(video) {
      const teamId = teams.get(video.id);
      if (!teamId || !actor) throw new TeamFunctionError('NOT_FOUND', { retryable: false });
      return asLiveFile(await read(teamId, video.id, actor, 'view'));
    },
    async destination({ teamId, actorId, folderId }) {
      if (!folderId) throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
      const folder = await read(teamId, folderId, actorId, 'upload');
      if (folder.kind !== 'folder')
        throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
      return { materialId: folder.id, live: asLiveFile(folder) };
    },
    async planName({ teamId, destinationMaterialId, name, idempotencyKey }) {
      if (!destinationMaterialId || !actor) throw new TeamFunctionError('WRONG_STATE');
      const names = await rpc('service_space_catalog_names', {
        p_team: teamId,
        p_folder: destinationMaterialId,
        p_actor: actor,
        p_prefix: catalogConflictSearchPrefix(name) ?? ''
      });
      if (!Array.isArray(names)) throw new TeamFunctionError('INVALID_RESPONSE');
      const plan = buildUploadConflictPlan(
        {
          teamId,
          destinationFolderId: destinationMaterialId,
          name: displayDriveName(name),
          mimeType: FEED_MIME,
          sizeBytes: 0,
          conflictMode: 'keep_both',
          replaceMaterialId: null,
          versionOfMaterialId: null,
          idempotencyKey
        },
        names.flatMap(entry =>
          isRecord(entry) && typeof entry.materialId === 'string' && typeof entry.name === 'string'
            ? [{ materialId: entry.materialId, name: entry.name }]
            : []
        )
      );
      return { name: plan.name, reservationKey: plan.reservationKey };
    },
    // The feed's commit is its operation's finalization; nothing is bound to a provider file.
    async bindIntent() {},
    async finalize() {
      throw new TeamFunctionError('INVALID_RESPONSE');
    },
    documentWriter: createCatalogFeedDocumentWriter({
      store: feeds,
      signal,
      newFeedId: catalogFeedIdFor,
      async commit({ operationId, actorId, name, bytes }) {
        const value = await rpc('service_commit_space_catalog_feed', {
          p_operation: operationId,
          p_actor: actorId,
          p_name: name,
          p_bytes: bytes
        });
        if (
          !isRecord(value) ||
          typeof value.materialId !== 'string' ||
          !UUID.test(value.materialId)
        )
          throw new TeamFunctionError('INVALID_RESPONSE');
        return { materialId: value.materialId };
      },
      log
    }),
    async link({ teamId, videoId, companionId, replaces, record }) {
      if (!actor) throw new TeamFunctionError('WRONG_STATE');
      const setId = input.variationSet?.() ?? null;
      const value = await rpc('service_link_space_catalog_feed', {
        p_team: teamId,
        p_video: videoId,
        p_companion: companionId,
        p_replaces: replaces,
        p_record: setId ? { ...record, spaceVariantSetId: setId } : record,
        p_actor: actor
      });
      if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      if (value.linked === true) {
        const variant = Number(value.variant);
        return {
          linked: true,
          ...(Number.isSafeInteger(variant) && variant > 0 ? { variant } : {}),
          // A retired feed is trashed with its row; there is no Drive file to trash.
          retired: []
        } satisfies CatalogLinkOutcome;
      }
      // The feed was written for a catalog that does not exist: it leaves (a Drive sheet that
      // lost is trashed by the generator; an R2 feed has no trash to go to).
      await removeFeedQuietly(record.feedId);
      if (value.reason === 'EXISTS' && isRecord(value.existing)) {
        const existing = value.existing;
        const productCount = Number(existing.productCount);
        const variant = Number(existing.variant);
        if (
          typeof existing.id === 'string' &&
          typeof existing.name === 'string' &&
          typeof existing.sheetUrl === 'string' &&
          typeof existing.sourceLink === 'string' &&
          Number.isSafeInteger(productCount)
        )
          return {
            linked: false,
            reason: 'EXISTS',
            existing: {
              materialId: existing.id,
              name: existing.name,
              sheetUrl: existing.sheetUrl,
              sourceLink: existing.sourceLink,
              productCount,
              ...(Number.isSafeInteger(variant) && variant > 0 ? { variant } : {}),
              createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : null
            }
          } satisfies CatalogLinkOutcome;
        return { linked: false, reason: 'EXISTS', existing: null } satisfies CatalogLinkOutcome;
      }
      return { linked: false, reason: 'NOT_ELIGIBLE' } satisfies CatalogLinkOutcome;
    },
    space: {
      async videoLink({ teamId, actorId, video }) {
        const value = await rpc('service_space_catalog_video_link', {
          p_team: teamId,
          p_actor: actorId,
          p_material: video.id
        });
        if (!isRecord(value) || !isCatalogVideoR2PublicUrl(value.url))
          throw new TeamFunctionError('INVALID_RESPONSE');
        // A planned copy is made by the catalog video worker; nudge it now (best effort).
        if (value.state !== 'ready')
          await rpc('service_catalog_video_r2_kick', { p_route: 'claim' }).catch(() => undefined);
        return value.url;
      }
    }
  };
}
