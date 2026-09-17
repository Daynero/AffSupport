import type { DriveFileMetadata, GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { ensureAnyoneReader } from '../_shared/link-sharing.ts';
import type { OperationAuthority } from '../_shared/operations.ts';
import {
  PRODUCT_CATALOG_SHEET_NAME,
  SOURCE_LINK_MAX,
  SPREADSHEET_MIME_TYPE,
  buildProductCatalogRows,
  parseProductCount,
  parseWebLink,
  driveImageLink,
  planCatalogRows,
  productCatalogName,
  videoShareLink,
  type ProductCatalogSpaceSettings
} from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';
import { buildXlsx } from '../_shared/xlsx.ts';

/**
 * `POST /drive-ops/product-catalog/create` (feature 022).
 *
 * A video's catalog sheet: the owner's Meta template filled from the space's settings, the
 * pasted link and the video's own shareable link, created next to the video, shared by link and
 * tied to the video as its `product_catalog` companion. The contract, including the order below,
 * is `specs/022-video-catalog-sheet/contracts/product-catalog-api.md`.
 *
 * Everything this needs from `index.ts` — contexts, Drive, operations, RPCs — arrives as `deps`,
 * so the order of refusals and the rollback are testable without Drive or a database.
 */

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{7,199}$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BODY_KEYS = new Set([
  'teamId',
  'videoMaterialId',
  'sourceLink',
  'productCount',
  'replacesMaterialId',
  'idempotencyKey'
]);

export type CatalogDrive = Pick<
  GoogleDriveClient,
  | 'listAnyonePermissions'
  | 'createAnyoneReaderPermission'
  | 'createConvertedFile'
  | 'updateFileMetadata'
>;

export interface CatalogVideo {
  id: string;
  name: string;
  category: string | null;
  driveFileId: string;
  resourceKey: string | null;
  /** The provider's id of the folder the video sits in; null for the space root. */
  parentFolderId: string | null;
  credentialId: string;
}

export interface ExistingCatalog {
  materialId: string;
  /** The sheet's Drive id, when the reader knows it; a re-create names its successor the same. */
  driveFileId?: string | null;
  name: string;
  sheetUrl: string;
  sourceLink: string;
  productCount: number;
  /** The variation's number (024, US15); a catalog from before variations is 1. */
  variant?: number;
  createdAt: string | null;
}

export type CatalogLinkOutcome =
  | {
      linked: true;
      retired: Array<{ driveFileId: string; resourceKey: string | null }>;
      variant?: number;
    }
  | { linked: false; reason: 'EXISTS'; existing: ExistingCatalog | null }
  | { linked: false; reason: 'NOT_ELIGIBLE' };

export interface ProductCatalogDeps {
  loadVideo(input: {
    teamId: string;
    videoId: string;
    actorId: string;
    permission: 'view' | 'edit';
  }): Promise<CatalogVideo>;
  readSettings(teamId: string): Promise<ProductCatalogSpaceSettings | null>;
  /** Texts from the space's pool, none repeated until the pool is spent (024). */
  drawTexts(teamId: string, count: number): Promise<Array<{ title: string; description: string }>>;
  /** Pictures from the space's pool, likewise. */
  drawImages(
    teamId: string,
    count: number
  ): Promise<Array<{ driveFileId: string; resourceKey: string | null; name?: string | null }>>;
  /** Every live catalog of the video — its variations — oldest number first. */
  readLiveCatalogs(teamId: string, videoId: string): Promise<ExistingCatalog[]>;
  /** The number a new variation of this video takes: one past the highest it ever had. */
  nextVariant(teamId: string, videoId: string): Promise<number>;
  driveFor(credentialId: string): Promise<CatalogDrive>;
  proveVideo(video: CatalogVideo, drive: CatalogDrive): Promise<DriveFileMetadata>;
  /** Proves the folder live, inside the root, writable by the actor (`upload`). */
  destination(input: {
    teamId: string;
    actorId: string;
    folderId: string | null;
  }): Promise<{ materialId: string | null; live: DriveFileMetadata }>;
  planName(input: {
    teamId: string;
    destinationMaterialId: string | null;
    live: DriveFileMetadata;
    name: string;
    idempotencyKey: string;
    /** The sheet being replaced: its name is about to be free, so it is no conflict. */
    replacingDriveFileId: string | null;
  }): Promise<{ name: string; reservationKey: string }>;
  startOperation(input: {
    teamId: string;
    actorId: string;
    idempotencyKey: string;
    videoId: string;
    destinationMaterialId: string | null;
    reservationKey: string;
  }): Promise<OperationAuthority>;
  /**
   * Bound after the upload, not before: Drive reports a size for a native spreadsheet only once
   * it exists, and finalize compares the committed file with the intent field by field.
   */
  bindIntent(input: {
    authority: OperationAuthority;
    actorId: string;
    name: string;
    sizeBytes: number | null;
  }): Promise<void>;
  markRunning(operationId: string): Promise<void>;
  failOperation(operationId: string, cause: unknown): Promise<void>;
  finalize(input: {
    operationId: string;
    actorId: string;
    metadata: DriveFileMetadata;
  }): Promise<{ materialId: string }>;
  link(input: {
    teamId: string;
    videoId: string;
    companionId: string;
    replaces: string | null;
    record: Record<string, unknown>;
  }): Promise<CatalogLinkOutcome>;
  log(message: string, detail: string): void;
}

export interface CreateProductCatalogRequest {
  teamId: string;
  videoMaterialId: string;
  sourceLink: string;
  productCount: number;
  replacesMaterialId: string | null;
  idempotencyKey: string;
}

export interface CreateProductCatalogResult {
  outcome: 'created' | 'recreated' | 'existing';
  catalog: ExistingCatalog;
  videoShared: boolean;
}

function invalid(field?: 'link' | 'count'): never {
  throw new TeamFunctionError('INVALID_INPUT', {
    retryable: false,
    ...(field ? { details: { field } } : {})
  });
}

function wrongState(reason: 'not_a_video' | 'settings_missing'): never {
  throw new TeamFunctionError('WRONG_STATE', { retryable: false, details: { reason } });
}

export function parseCreateProductCatalogRequest(body: unknown): CreateProductCatalogRequest {
  if (!isRecord(body) || Object.keys(body).some(key => !BODY_KEYS.has(key))) invalid();
  const { teamId, videoMaterialId, replacesMaterialId, idempotencyKey } = body;
  if (typeof teamId !== 'string' || !UUID.test(teamId)) invalid();
  if (typeof videoMaterialId !== 'string' || !UUID.test(videoMaterialId)) invalid();
  if (
    replacesMaterialId !== null &&
    replacesMaterialId !== undefined &&
    (typeof replacesMaterialId !== 'string' || !UUID.test(replacesMaterialId))
  ) {
    invalid();
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) invalid();
  const link = parseWebLink(body.sourceLink, SOURCE_LINK_MAX);
  if (!link.ok) invalid('link');
  // The wire carries a JSON integer; a string that merely looks like one is not accepted here.
  if (typeof body.productCount !== 'number') invalid('count');
  const count = parseProductCount(body.productCount);
  if (!count.ok) invalid('count');
  return {
    teamId,
    videoMaterialId,
    sourceLink: link.value,
    productCount: count.value,
    replacesMaterialId: typeof replacesMaterialId === 'string' ? replacesMaterialId : null,
    idempotencyKey
  };
}

function newestOf(catalogs: ExistingCatalog[]): ExistingCatalog {
  return catalogs.reduce((newest, catalog) =>
    (catalog.createdAt ?? '') > (newest.createdAt ?? '') ? catalog : newest
  );
}

async function trashQuietly(
  deps: ProductCatalogDeps,
  drive: CatalogDrive,
  file: { driveFileId: string; resourceKey: string | null },
  why: string
) {
  try {
    await drive.updateFileMetadata({
      fileId: file.driveFileId,
      resourceKey: file.resourceKey,
      trashed: true
    });
  } catch (error) {
    deps.log(
      `[product-catalog] ${why}: sheet stayed in Drive`,
      `${file.driveFileId} ${String(error)}`
    );
  }
}

export async function createProductCatalog(
  deps: ProductCatalogDeps,
  body: unknown,
  actorId: string
): Promise<CreateProductCatalogResult> {
  const request = parseCreateProductCatalogRequest(body);
  const { teamId, videoMaterialId: videoId } = request;

  // Refusals first: nothing below this block may leave anything behind.
  const video = await deps.loadVideo({ teamId, videoId, actorId, permission: 'view' });
  if (video.category !== 'video') wrongState('not_a_video');
  const settings = await deps.readSettings(teamId);
  if (!settings) wrongState('settings_missing');

  /*
   * A create makes a new variation beside whatever the video already has (024, US15). Only a
   * re-create can find nothing to do: the variation it names was replaced or removed by somebody
   * first, and it shows the newest catalog there is rather than bring a removed one back.
   */
  const catalogs = await deps.readLiveCatalogs(teamId, videoId);
  const live = request.replacesMaterialId
    ? (catalogs.find(catalog => catalog.materialId === request.replacesMaterialId) ?? null)
    : null;
  if (request.replacesMaterialId && !live && catalogs.length > 0) {
    return { outcome: 'existing', catalog: newestOf(catalogs), videoShared: false };
  }
  const replaces = live ? live.materialId : null;

  const drive = await deps.driveFor(video.credentialId);
  const liveVideo = await deps.proveVideo(video, drive);
  const destination = await deps.destination({
    teamId,
    actorId,
    folderId: video.parentFolderId
  });

  let videoShared = false;
  if ((await drive.listAnyonePermissions(liveVideo.id)).length === 0) {
    // Opening a video to anyone with the link changes the video, so it needs `edit` on it.
    await deps.loadVideo({ teamId, videoId, actorId, permission: 'edit' });
    if (liveVideo.capabilities.canShare !== true) {
      throw new TeamFunctionError('SHARE_NOT_ALLOWED', { retryable: false });
    }
    videoShared = (await ensureAnyoneReader(drive, liveVideo.id)).added;
  }
  const videoLink = videoShareLink(liveVideo.id, liveVideo.resourceKey ?? video.resourceKey);

  /*
   * Each row its own name, text, price and picture (024): drawn from the space's pools without
   * repeats, the settings' single values where a pool is empty. The pictures are shared by link,
   * as the video is, or Meta cannot fetch them.
   */
  const [texts, images] = await Promise.all([
    deps.drawTexts(teamId, request.productCount),
    deps.drawImages(teamId, request.productCount)
  ]);
  const sharedImages = new Set<string>();
  for (const image of images) {
    if (sharedImages.has(image.driveFileId)) continue;
    await ensureAnyoneReader(drive, image.driveFileId);
    sharedImages.add(image.driveFileId);
  }
  const planned = planCatalogRows({
    count: request.productCount,
    settings,
    texts,
    images: images.map(image => ({
      link: driveImageLink(image.driveFileId, image.resourceKey),
      name: image.name ?? null
    }))
  });
  if (!planned) wrongState('settings_missing');
  const first = planned[0]!;
  /* Kept for sheets and workers that read one value: the first row's. */
  const snapshot = {
    title: first.title,
    description: first.description,
    price: first.price,
    imageLink: first.imageLink,
    rows: planned
  };

  const variant = live ? (live.variant ?? 1) : await deps.nextVariant(teamId, videoId);
  const plan = await deps.planName({
    teamId,
    destinationMaterialId: destination.materialId,
    live: destination.live,
    name: productCatalogName(video.name, variant),
    idempotencyKey: request.idempotencyKey,
    replacingDriveFileId: live?.driveFileId ?? null
  });
  const authority = await deps.startOperation({
    teamId,
    actorId,
    idempotencyKey: request.idempotencyKey,
    videoId,
    destinationMaterialId: destination.materialId,
    reservationKey: plan.reservationKey
  });
  if (authority.reused) {
    // The same confirmation arriving twice. Only a finished one has something to show.
    const finished =
      authority.state === 'succeeded'
        ? (await deps.readLiveCatalogs(teamId, videoId)).find(
            catalog => (catalog.variant ?? 1) === variant
          )
        : null;
    if (finished) {
      return { outcome: replaces ? 'recreated' : 'created', catalog: finished, videoShared };
    }
    throw new TeamFunctionError('WRONG_STATE', { retryable: true });
  }
  try {
    await deps.markRunning(authority.operationId);
    const bytes = await buildXlsx({
      sheetName: PRODUCT_CATALOG_SHEET_NAME,
      rows: buildProductCatalogRows({
        settings: first,
        sourceLink: request.sourceLink,
        videoLink,
        count: request.productCount,
        rows: planned
      })
    });
    const file = await drive.createConvertedFile({
      name: plan.name,
      parentId: destination.live.id,
      sourceMimeType: XLSX_MIME_TYPE,
      targetMimeType: SPREADSHEET_MIME_TYPE,
      bytes
    });
    const created = { driveFileId: file.id, resourceKey: file.resourceKey ?? null };
    try {
      await deps.bindIntent({ authority, actorId, name: file.name, sizeBytes: file.size });
      await ensureAnyoneReader(drive, file.id);
      const sheetUrl = file.webViewLink ?? '';
      if (!/^https:\/\/[^\s]+$/u.test(sheetUrl)) {
        throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
      }
      const committed = await deps.finalize({
        operationId: authority.operationId,
        actorId,
        metadata: file
      });
      const linked = await deps.link({
        teamId,
        videoId,
        companionId: committed.materialId,
        replaces,
        record: {
          sourceLink: request.sourceLink,
          productCount: request.productCount,
          sheetUrl,
          videoLink,
          settingsSnapshot: snapshot,
          createdBy: actorId,
          variant
        }
      });
      if (!linked.linked) {
        await trashQuietly(deps, drive, created, 'lost the race');
        if (linked.reason === 'EXISTS' && linked.existing) {
          return { outcome: 'existing', catalog: linked.existing, videoShared };
        }
        throw new TeamFunctionError('WRONG_STATE', { retryable: true });
      }
      for (const retired of linked.retired) {
        await trashQuietly(deps, drive, retired, 'retired catalog');
      }
      return {
        outcome: replaces ? 'recreated' : 'created',
        catalog: {
          materialId: committed.materialId,
          name: file.name,
          sheetUrl,
          sourceLink: request.sourceLink,
          productCount: request.productCount,
          variant: linked.variant ?? variant,
          createdAt: null
        },
        videoShared
      };
    } catch (error) {
      // A sheet that is not shared, not committed or not linked is not a catalog. It leaves.
      await trashQuietly(deps, drive, created, 'rolled back');
      throw error;
    }
  } catch (error) {
    await deps.failOperation(authority.operationId, error);
    throw error;
  }
}
