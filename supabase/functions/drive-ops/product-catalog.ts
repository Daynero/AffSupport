import {
  parseCatalogVideoForegroundExecutor,
  type CatalogVideoForegroundExecutor
} from '../../../packages/shared/dist/team/catalog-video-foreground.js';
import { nativeCatalogCellRows } from '../_shared/catalog-native-sheet.ts';
import {
  catalogImageUrl,
  catalogImageName,
  legacyImage,
  publishedImage,
  type CatalogDrawnImage,
  type CatalogImageDrawOptions
} from '../_shared/catalog-image-rows.ts';
import { classifyMaterial } from '../../../packages/shared/dist/team/material-category.js';
import type { DriveFileMetadata, GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';
import { ensureAnyoneReader } from '../_shared/link-sharing.ts';
import { createCatalogImageSharer } from '../_shared/catalog-image-sharing.ts';
import type { OperationAuthority } from '../_shared/operations.ts';
import {
  PRODUCT_CATALOG_SHEET_NAME,
  SOURCE_LINK_MAX,
  SPREADSHEET_MIME_TYPE,
  buildProductCatalogRows,
  parseProductCount,
  parseWebLink,
  planCatalogRows,
  productCatalogName,
  videoShareLink,
  type ProductCatalogRowValues,
  type ProductCatalogSpaceSettings
} from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';
import { RESTITCH_DURATION_MODES } from '../../../packages/shared/dist/team/restitch.js';
import { buildXlsx, type XlsxCell } from '../_shared/xlsx.ts';

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
  'randomLinkVariation',
  'replacesMaterialId',
  'restitchOperationId',
  'idempotencyKey',
  'catalogImageContractVersion',
  'catalogVideoProtocolVersion',
  'restitchEnabled',
  'videoVariationCount',
  'videoPublication',
  'restitchDuration',
  'expectedExecutorId',
  'foregroundExecutor',
  'copyVideoToR2'
]);

export type CatalogDrive = Pick<
  GoogleDriveClient,
  | 'listAnyonePermissions'
  | 'createAnyoneReaderPermission'
  | 'createConvertedFile'
  | 'updateFileMetadata'
> & {
  createNativeSpreadsheet?: GoogleDriveClient['createNativeSpreadsheet'];
  writeNativeSpreadsheet?: (input: {
    fileId: string;
    sheetName: string;
    rows: XlsxCell[][];
  }) => Promise<DriveFileMetadata>;
};

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
  initialVideoAuthority?: import('./catalog-video-generation.ts').CatalogInitialVideoAuthority;
  /** Supplied only by durable publication authority, never by a raw client flag. */
  videoDelivery?: import('../_shared/product-catalog.ts').CatalogVideoCellDelivery;
  /** Local beta experiment; durable retries freeze the selected writer. */
  nativeSpreadsheet?: boolean;
  buildWorkbook?: (rows: XlsxCell[][]) => Promise<Uint8Array<ArrayBuffer>>;
  beforeImageWrite?(): Promise<void>;
  validateImageUses?(teamId: string, attemptId: string): Promise<void>;
  /** Resolve Launch SUBs only after the durable version and final collision-safe name exist. */
  resolveSourceLink?: (name: string) => Promise<string>;

  /** Durable adapter owns reconciliation; an uncertain output must not be trashed blindly. */
  preserveUncertainOutput?: boolean;
  /** Reconciles an already-created sheet before repeating XLSX conversion. */
  readCreatedFile?: (parentId: string, credentialId: string) => Promise<DriveFileMetadata | null>;
  rememberRowRecipe?: (rows: ProductCatalogRowValues[]) => Promise<ProductCatalogRowValues[]>;
  rememberSheetRows?: (rows: XlsxCell[][]) => Promise<XlsxCell[][]>;
  loadVideo(input: {
    teamId: string;
    videoId: string;
    actorId: string;
    permission: 'view' | 'edit';
  }): Promise<CatalogVideo>;
  assertImageContract?(teamId: string, version: 2 | 3 | undefined): Promise<void>;
  /** 050: refuse `copyVideoToR2` before any side effect unless the feature is available and the actor may manage catalog settings. */
  assertVideoR2Option?(teamId: string, actorId: string): Promise<void>;
  /** 050: record the option on the registered catalog and queue its first copy. */
  applyVideoR2Option?(input: {
    teamId: string;
    actorId: string;
    catalogMaterialId: string;
  }): Promise<void>;
  bindGlobalImageCatalog?(teamId: string, intentId: string, materialId: string): Promise<void>;
  finalizeImageUses?(teamId: string, attemptId: string, delivered: boolean): Promise<void>;
  readSettings(teamId: string): Promise<ProductCatalogSpaceSettings | null>;
  /** Restores already frozen choices before any fresh pool draws. */
  readRowRecipe?(): ProductCatalogRowValues[] | null;
  /** A completed re-stitch of this video by this member, verified before the sheet is made. */
  resolveRestitchedVideo(input: {
    teamId: string;
    videoId: string;
    actorId: string;
    operationId: string;
  }): Promise<CatalogVideo>;
  /** Texts from the space's pool, none repeated until the pool is spent (024). */
  drawTexts(teamId: string, count: number): Promise<Array<{ title: string; description: string }>>;
  /** Pictures from the space's pool, likewise. */
  drawImages(
    teamId: string,
    count: number,
    options?: CatalogImageDrawOptions
  ): Promise<CatalogDrawnImage[]>;
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

export interface CatalogCreationVideoPreferences {
  catalogVideoProtocolVersion: 1;
  restitchEnabled: boolean;
  expectedExecutorId?: string;
  foregroundExecutor?: CatalogVideoForegroundExecutor;
  videoVariationCount: number;
  restitchDuration?: Pick<
    import('../../../packages/shared/dist/team/restitch.js').TeamRestitchDefaults,
    'finalDurationMode' | 'customFinalDurationSeconds'
  > & { finalDurationRangeSeconds?: readonly [number, number] };
  videoPublication: import('../../../packages/shared/dist/team/catalog-publication.js').CatalogVideoPublicationRequest;
}
export interface CreateProductCatalogRequest extends Partial<CatalogCreationVideoPreferences> {
  catalogImageContractVersion?: 2 | 3;
  /** 050: copy the catalog video to R2 and issue the R2 link from the next update on. */
  copyVideoToR2?: boolean;
  teamId: string;
  videoMaterialId: string;
  sourceLink: string;
  productCount: number;
  randomLinkVariation?: boolean;
  replacesMaterialId: string | null;
  restitchOperationId: string | null;
  idempotencyKey: string;
}

export interface CreateProductCatalogResult {
  videoGeneration?: import('./catalog-video-generation.ts').CatalogVideoGenerationProgress;
  /** Read-only current observation; never rewrites the original created receipt. */
  videoGenerationObservation?: import('./catalog-video-generation.ts').CatalogVideoGenerationProgress;
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
  const { teamId, videoMaterialId, replacesMaterialId, restitchOperationId, idempotencyKey } = body;
  if (typeof teamId !== 'string' || !UUID.test(teamId)) invalid();
  if (typeof videoMaterialId !== 'string' || !UUID.test(videoMaterialId)) invalid();
  if (
    replacesMaterialId !== null &&
    replacesMaterialId !== undefined &&
    (typeof replacesMaterialId !== 'string' || !UUID.test(replacesMaterialId))
  ) {
    invalid();
  }
  if (
    restitchOperationId !== null &&
    restitchOperationId !== undefined &&
    (typeof restitchOperationId !== 'string' || !UUID.test(restitchOperationId))
  )
    invalid();
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) invalid();
  const link = parseWebLink(body.sourceLink, SOURCE_LINK_MAX);
  if (!link.ok) invalid('link');
  // The wire carries a JSON integer; a string that merely looks like one is not accepted here.
  if (typeof body.productCount !== 'number') invalid('count');
  const count = parseProductCount(body.productCount);
  if (!count.ok) invalid('count');
  if (body.randomLinkVariation !== undefined && typeof body.randomLinkVariation !== 'boolean')
    invalid();
  if (body.copyVideoToR2 !== undefined && typeof body.copyVideoToR2 !== 'boolean') invalid();
  if (
    body.catalogImageContractVersion !== undefined &&
    ![2, 3].includes(Number(body.catalogImageContractVersion))
  )
    throw new TeamFunctionError('CATALOG_IMAGE_UPGRADE_REQUIRED');
  const videoPreferences = parseCatalogCreationVideoPreferences(body, count.value);
  return {
    ...videoPreferences,
    ...([2, 3].includes(Number(body.catalogImageContractVersion))
      ? { catalogImageContractVersion: body.catalogImageContractVersion as 2 | 3 }
      : {}),
    ...(body.copyVideoToR2 === true ? { copyVideoToR2: true } : {}),
    teamId,
    videoMaterialId,
    sourceLink: link.value,
    productCount: count.value,
    randomLinkVariation: body.randomLinkVariation !== false,
    replacesMaterialId: typeof replacesMaterialId === 'string' ? replacesMaterialId : null,
    restitchOperationId: typeof restitchOperationId === 'string' ? restitchOperationId : null,
    idempotencyKey
  };
}

/** Structural parsing deliberately does not reject a past accepted due time.
 * The durable acceptance authority validates its first admission once. */
export function parseCatalogCreationVideoPreferences(
  body: Record<string, unknown>,
  productCount: number
): Partial<CatalogCreationVideoPreferences> {
  const keys = [
    'restitchEnabled',
    'videoVariationCount',
    'videoPublication',
    'restitchDuration',
    'expectedExecutorId',
    'foregroundExecutor'
  ];
  if (body.catalogVideoProtocolVersion === undefined) {
    if (keys.some(key => body[key] !== undefined)) invalid();
    return {};
  }
  if (
    body.catalogVideoProtocolVersion !== 1 ||
    typeof body.restitchEnabled !== 'boolean' ||
    body.restitchOperationId != null
  )
    invalid();
  if (
    body.expectedExecutorId !== undefined &&
    (typeof body.expectedExecutorId !== 'string' || !UUID.test(body.expectedExecutorId))
  )
    invalid();
  const foregroundExecutor =
    body.foregroundExecutor === undefined
      ? undefined
      : parseCatalogVideoForegroundExecutor(body.foregroundExecutor);
  if (
    body.foregroundExecutor !== undefined &&
    (!foregroundExecutor || body.expectedExecutorId !== undefined || body.restitchEnabled !== true)
  )
    invalid();
  const n = body.videoVariationCount;
  if (
    typeof n !== 'number' ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > productCount ||
    (!body.restitchEnabled && n !== 1)
  )
    invalid('count');
  let restitchDuration: CatalogCreationVideoPreferences['restitchDuration'];
  if (body.restitchDuration !== undefined) {
    const duration = body.restitchDuration;
    if (
      !isRecord(duration) ||
      Object.keys(duration).some(
        key =>
          ![
            'finalDurationMode',
            'customFinalDurationSeconds',
            'finalDurationRangeSeconds'
          ].includes(key)
      ) ||
      !RESTITCH_DURATION_MODES.includes(
        duration.finalDurationMode as (typeof RESTITCH_DURATION_MODES)[number]
      ) ||
      typeof duration.customFinalDurationSeconds !== 'number' ||
      !Number.isInteger(duration.customFinalDurationSeconds) ||
      duration.customFinalDurationSeconds < 60 ||
      duration.customFinalDurationSeconds > 3600
    )
      invalid();
    const range = duration.finalDurationRangeSeconds;
    if (
      range !== undefined &&
      (duration.finalDurationMode !== 'random-centered' ||
        !Array.isArray(range) ||
        range.length !== 2 ||
        range.some(v => !Number.isInteger(v) || v < 60 || v > 3600 || v % 60 !== 0) ||
        range[0] > range[1])
    )
      invalid();
    restitchDuration = {
      finalDurationMode: duration.finalDurationMode as NonNullable<
        typeof restitchDuration
      >['finalDurationMode'],
      customFinalDurationSeconds: duration.customFinalDurationSeconds,
      ...(Array.isArray(range) ? { finalDurationRangeSeconds: [range[0], range[1]] as const } : {})
    };
  }
  const publication = body.videoPublication;
  if (!isRecord(publication)) invalid();
  if (publication.mode === 'immediate') {
    if (Object.keys(publication).some(key => key !== 'mode')) invalid();
    return {
      catalogVideoProtocolVersion: 1,
      ...(foregroundExecutor ? { foregroundExecutor } : {}),
      ...(restitchDuration ? { restitchDuration } : {}),
      ...(typeof body.expectedExecutorId === 'string'
        ? { expectedExecutorId: body.expectedExecutorId }
        : {}),
      restitchEnabled: body.restitchEnabled,
      videoVariationCount: n,
      videoPublication: { mode: 'immediate' }
    };
  }
  if (
    publication.mode !== 'scheduled' ||
    Object.keys(publication).some(
      key => !['mode', 'localDateTime', 'timeZone', 'resolvedOffset', 'dueAt'].includes(key)
    ) ||
    ['localDateTime', 'timeZone', 'resolvedOffset', 'dueAt'].some(
      key => typeof publication[key] !== 'string'
    )
  )
    invalid();
  if (!Number.isFinite(Date.parse(publication.dueAt as string))) invalid();
  return {
    catalogVideoProtocolVersion: 1,
    ...(foregroundExecutor ? { foregroundExecutor } : {}),
    ...(restitchDuration ? { restitchDuration } : {}),
    ...(typeof body.expectedExecutorId === 'string'
      ? { expectedExecutorId: body.expectedExecutorId }
      : {}),
    restitchEnabled: body.restitchEnabled,
    videoVariationCount: n,
    videoPublication: structuredClone(
      publication
    ) as CatalogCreationVideoPreferences['videoPublication']
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
    deps.log(`[product-catalog] ${why}: sheet stayed in Drive`, mapUnknownError(error).code);
  }
}

/** Drain both tasks on failure: no provider mutation may outlive this attempt's cleanup. */
async function alongside<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const [a, b] = await Promise.allSettled([first, second]);
  if (a.status === 'rejected') throw a.reason;
  if (b.status === 'rejected') throw b.reason;
  return [a.value, b.value];
}

/** Use the same MIME/extension rules as indexing, against the proven live file. */
function assertLiveVideo(file: DriveFileMetadata) {
  const dot = file.name.lastIndexOf('.');
  const classification = classifyMaterial({
    kind: file.shortcutTargetId
      ? 'shortcut'
      : file.mimeType === 'application/vnd.google-apps.folder'
        ? 'folder'
        : 'file',
    mimeType: file.mimeType,
    fileExtension: dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1) : null,
    sourceVersion: file.version
  });
  if (classification.category !== 'video')
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
}

export async function createProductCatalog(
  deps: ProductCatalogDeps,
  body: unknown,
  actorId: string
): Promise<CreateProductCatalogResult> {
  const request = parseCreateProductCatalogRequest(body);
  const { teamId, videoMaterialId: videoId } = request;

  await deps.assertImageContract?.(teamId, request.catalogImageContractVersion);
  // Refusals first: nothing below this block may leave anything behind.
  const video = await deps.loadVideo({ teamId, videoId, actorId, permission: 'view' });
  if (video.category !== 'video') wrongState('not_a_video');
  if (request.copyVideoToR2) await deps.assertVideoR2Option?.(teamId, actorId);
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

  const restitched = request.restitchOperationId
    ? await deps.resolveRestitchedVideo({
        teamId,
        videoId,
        actorId,
        operationId: request.restitchOperationId
      })
    : null;

  const drive = await deps.driveFor(video.credentialId);
  const liveVideo = await deps.proveVideo(video, drive);
  assertLiveVideo(liveVideo);
  // The selected file can move before the index catches up. Do not publish
  // beside its stale parent or redirect a durable operation's frozen target.
  if (!video.parentFolderId || !liveVideo.parents.includes(video.parentFolderId))
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  // Both reads are authorized by the proven source. Keep destination refusals first,
  // and do not change video permissions until both reads have completed.
  const [destination, videoPermissions] = await alongside(
    deps.destination({ teamId, actorId, folderId: video.parentFolderId }),
    drive.listAnyonePermissions(liveVideo.id)
  );
  const copyDrive = restitched ? await deps.driveFor(restitched.credentialId) : null;
  const liveCopy = restitched && copyDrive ? await deps.proveVideo(restitched, copyDrive) : null;
  if (liveCopy) assertLiveVideo(liveCopy);

  let videoShared = false;
  if (
    videoPermissions.length === 0 &&
    !(request.catalogVideoProtocolVersion === 1 && request.restitchEnabled)
  ) {
    // Opening a video to anyone with the link changes the video, so it needs `edit` on it.
    await deps.loadVideo({ teamId, videoId, actorId, permission: 'edit' });
    if (liveVideo.capabilities.canShare !== true) {
      throw new TeamFunctionError('SHARE_NOT_ALLOWED', { retryable: false });
    }
    videoShared = (await ensureAnyoneReader(drive, liveVideo.id, videoPermissions)).added;
  }
  const originalVideoLink = videoShareLink(
    liveVideo.id,
    liveVideo.resourceKey ?? video.resourceKey
  );
  let videoLink = originalVideoLink;
  if (restitched && copyDrive && liveCopy) {
    const copyPermissions = await copyDrive.listAnyonePermissions(liveCopy.id);
    if (copyPermissions.length === 0) {
      await deps.loadVideo({ teamId, videoId: restitched.id, actorId, permission: 'edit' });
      if (liveCopy.capabilities.canShare !== true) {
        throw new TeamFunctionError('SHARE_NOT_ALLOWED', { retryable: false });
      }
      await ensureAnyoneReader(copyDrive, liveCopy.id, copyPermissions);
    }
    videoLink = videoShareLink(liveCopy.id, liveCopy.resourceKey ?? restitched.resourceKey);
  }

  /*
   * Each row its own name, text, price and picture (024): drawn from the space's pools without
   * repeats, the settings' single values where a pool is empty. The pictures are shared by link,
   * as the video is, or Meta cannot fetch them.
   */
  const variant = live ? (live.variant ?? 1) : await deps.nextVariant(teamId, videoId);
  const namePlan = deps.planName({
    teamId,
    destinationMaterialId: destination.materialId,
    live: destination.live,
    name: productCatalogName(video.name, variant),
    idempotencyKey: request.idempotencyKey,
    replacingDriveFileId: live?.driveFileId ?? null
  });
  const [planned, plan] = await alongside(
    (async () => {
      const frozen = deps.readRowRecipe?.();
      if (frozen) {
        if (frozen.length !== request.productCount) throw new TeamFunctionError('INVALID_RESPONSE');
        return frozen;
      }
      const [texts, images] = await alongside(
        settings.contentPolicyVersion === 1
          ? Promise.resolve([])
          : deps.drawTexts(teamId, request.productCount),
        deps.drawImages(teamId, request.productCount, {
          contractVersion: request.catalogImageContractVersion
        })
      );
      await createCatalogImageSharer(drive)(images.filter(legacyImage));
      let planned = planCatalogRows({
        count: request.productCount,
        settings,
        texts,
        images: images.map(image => ({
          link: catalogImageUrl(image),
          name: catalogImageName(image),
          ...(publishedImage(image) ? { image } : {})
        }))
      });
      if (!planned) wrongState('settings_missing');
      if (deps.rememberRowRecipe) planned = await deps.rememberRowRecipe(planned);
      return planned;
    })(),
    namePlan
  );
  const first = planned[0]!;
  /* Kept for sheets and workers that read one value: the first row's. */
  const snapshot = {
    title: first.title,
    description: first.description,
    price: first.price,
    imageLink: first.imageLink,
    randomLinkVariation: request.randomLinkVariation !== false,
    rows: planned,
    ...(settings.contentPolicyVersion === 1 ? { contentPolicyVersion: 1 } : {})
  };
  if (deps.resolveSourceLink) {
    const link = parseWebLink(await deps.resolveSourceLink(plan.name), SOURCE_LINK_MAX);
    if (!link.ok) throw new TeamFunctionError('LAUNCH_SUB_INVALID');
    request.sourceLink = link.value;
  }
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
    let sheetRows: XlsxCell[][] = buildProductCatalogRows({
      settings: first,
      sourceLink: request.sourceLink,
      videoLink,
      videoDelivery: deps.videoDelivery,
      count: request.productCount,
      randomLinkVariation: request.randomLinkVariation,
      rows: planned
    });
    if (deps.rememberSheetRows) sheetRows = await deps.rememberSheetRows(sheetRows);
    if (deps.nativeSpreadsheet) nativeCatalogCellRows(sheetRows);
    await deps.beforeImageWrite?.();
    const recoveredFile = await deps.readCreatedFile?.(destination.live.id, video.credentialId);
    const file =
      recoveredFile ??
      (deps.nativeSpreadsheet
        ? await (() => {
            if (!drive.createNativeSpreadsheet || !drive.writeNativeSpreadsheet)
              throw new TeamFunctionError('INVALID_RESPONSE');
            return drive.createNativeSpreadsheet({
              name: plan.name,
              parentId: destination.live.id
            });
          })()
        : await drive.createConvertedFile({
            name: plan.name,
            parentId: destination.live.id,
            sourceMimeType: XLSX_MIME_TYPE,
            targetMimeType: SPREADSHEET_MIME_TYPE,
            bytes: deps.buildWorkbook
              ? await deps.buildWorkbook(sheetRows)
              : await buildXlsx({ sheetName: PRODUCT_CATALOG_SHEET_NAME, rows: sheetRows })
          }));
    let committedFile = file;
    const created = { driveFileId: file.id, resourceKey: file.resourceKey ?? null };
    try {
      // Both depend on the durable provider-file receipt, not on one another.
      // Drain sharing even when binding fails before entering recovery/cleanup.
      if (deps.nativeSpreadsheet) {
        if (!drive.writeNativeSpreadsheet) throw new TeamFunctionError('INVALID_RESPONSE');
        [committedFile] = await alongside(
          drive.writeNativeSpreadsheet({
            fileId: file.id,
            sheetName: PRODUCT_CATALOG_SHEET_NAME,
            rows: sheetRows
          }),
          ensureAnyoneReader(drive, file.id)
        );
        await deps.bindIntent({
          authority,
          actorId,
          name: committedFile.name,
          sizeBytes: committedFile.size
        });
      } else {
        await alongside(
          deps.bindIntent({ authority, actorId, name: file.name, sizeBytes: file.size }),
          ensureAnyoneReader(drive, file.id)
        );
      }
      const sheetUrl = committedFile.webViewLink ?? '';
      if (!/^https:\/\/[^\s]+$/u.test(sheetUrl)) {
        throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
      }
      const committed = await deps.finalize({
        operationId: authority.operationId,
        actorId,
        metadata: committedFile
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
          videoLink: originalVideoLink,
          ...(restitched && request.restitchOperationId
            ? {
                currentVideoLink: videoLink,
                restitchMaterialId: restitched.id,
                restitchOperationId: request.restitchOperationId
              }
            : {}),
          settingsSnapshot: snapshot,
          createdBy: actorId,
          variant
        }
      });
      if (!linked.linked) {
        if (!deps.preserveUncertainOutput)
          await trashQuietly(deps, drive, created, 'lost the race');
        if (linked.reason === 'EXISTS' && linked.existing) {
          return { outcome: 'existing', catalog: linked.existing, videoShared };
        }
        throw new TeamFunctionError('WRONG_STATE', { retryable: true });
      }
      for (const retired of linked.retired) {
        await trashQuietly(deps, drive, retired, 'retired catalog');
      }
      if (request.copyVideoToR2)
        await deps.applyVideoR2Option?.({
          teamId,
          actorId,
          catalogMaterialId: committed.materialId
        });
      return {
        outcome: replaces ? 'recreated' : 'created',
        catalog: {
          materialId: committed.materialId,
          name: committedFile.name,
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
      if (!deps.preserveUncertainOutput) await trashQuietly(deps, drive, created, 'rolled back');
      throw error;
    }
  } catch (error) {
    await deps.failOperation(authority.operationId, error);
    throw error;
  }
}
