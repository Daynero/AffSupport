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
  catalogCreativeSnapshot,
  catalogRowCreatives,
  parseProductCount,
  parseWebLink,
  planCatalogRows,
  productCatalogName,
  videoShareLink,
  type CatalogCreativeCells,
  type CatalogCreativeKind,
  type CatalogSnapshotCreative,
  type ProductCatalogRowValues,
  type ProductCatalogSpaceSettings
} from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';
import { RESTITCH_DURATION_MODES } from '../../../packages/shared/dist/team/restitch.js';
import { buildXlsx, type XlsxCell } from '../_shared/xlsx.ts';
import { catalogIdPrefix } from '../_shared/product-details.ts';

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
  'copyVideoToR2',
  'creativeKind',
  'creatives'
]);
/** Same alphabet as a Launch alias (`validation.ts`). */
const CREATIVE_ALIAS = /^[A-Za-z0-9_-]{1,160}$/u;

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
  /**
   * 062: one product link per creative, in creative order, when SUB «Креатив» tells the blocks
   * apart; null keeps the catalog's single link for every row. Resolved with the final name.
   */
  resolveCreativeSourceLinks?: (name: string) => Promise<readonly string[] | null>;

  /**
   * 057: where the catalog document goes. Absent — every Drive space — it is the Google sheet,
   * exactly as before; an R2 space hands in its feed writer.
   */
  documentWriter?: CatalogDocumentWriter;
  /**
   * 057: the storage seam of an R2 space (`catalog-space-source.ts`). Absent for every Drive
   * space, which runs every line below as before. Present, the video is read from the space,
   * never shared by link, and linked from its R2 copy.
   */
  space?: CatalogSpaceSource;
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
  /**
   * 050: record the option on the registered catalog and, when `queueCopy`, queue the first
   * copy of its current video. A catalog whose videos a publication writes (protocol 1) does
   * not queue one: the publication resolves each video it writes, and the catalog's current
   * video before then is the uploaded original, which a re-stitched catalog never links
   * (next QA 2026-11-17: 78 MB copied for nothing).
   */
  applyVideoR2Option?(input: {
    teamId: string;
    actorId: string;
    catalogMaterialId: string;
    queueCopy: boolean;
  }): Promise<void>;
  bindGlobalImageCatalog?(teamId: string, intentId: string, materialId: string): Promise<void>;
  /**
   * 062: publishes every image creative (R2 `c1/` or Drive by the catalog's R2 option) and
   * returns each one's verified public link, in creative order. Required for an image catalog.
   */
  publishCreativeImages?(input: {
    teamId: string;
    actorId: string;
    copyToR2: boolean;
    images: ReadonlyArray<{
      ordinal: number;
      material: CatalogVideo;
      live: DriveFileMetadata;
      drive: CatalogDrive;
    }>;
    /** 062: each publication stage as it is proven (diagnostics only; no name or link). */
    observe?: (event: {
      ordinal: number;
      stage: import('../../../packages/shared/dist/team/launches.js').CreativeImageStage;
      attemptId: string | null;
    }) => Promise<void>;
  }): Promise<CatalogCreativeImageLink[]>;
  /** 062: records which R2 creative images a registered catalog uses (R33). */
  confirmCreativeImageUses?(catalogMaterialId: string, imageIds: readonly string[]): Promise<void>;
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

/**
 * 057: what a catalog of an R2 space takes from the space instead of Drive. Only a single video
 * creative published at once is offered there: re-stitched videos, scheduled publication and
 * image or multi-creative catalogs have no R2 path yet and are refused before anything is made.
 */
export interface CatalogSpaceSource {
  /** The public address of the video's R2 copy (050), planned or verified; never a Drive link. */
  videoLink(input: { teamId: string; actorId: string; video: CatalogVideo }): Promise<string>;
}

/** 062: an image creative's published link. */
export interface CatalogCreativeImageLink {
  ordinal: number;
  link: string;
  linkKind: 'r2' | 'drive';
  /** The `launch_creative_images` record behind an R2 link. */
  imageId?: string;
}

/** 062: one creative of a catalog request, in row order. */
export interface CatalogRequestCreative {
  materialId: string;
  alias: string;
  copies: number;
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
  /** 062: absent on requests from before (one video, prefix from its name). */
  creativeKind?: CatalogCreativeKind;
  creatives?: CatalogRequestCreative[];
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
  const creatives = parseCatalogRequestCreatives(body, count.value, videoMaterialId);
  if (
    creatives &&
    (creatives.creatives.length > 1 || creatives.creativeKind === 'image') &&
    (videoPreferences.catalogVideoProtocolVersion !== 1 ||
      restitchOperationId != null ||
      replacesMaterialId != null)
  )
    throw new TeamFunctionError('MULTI_CREATIVE_UNSUPPORTED', { retryable: false });
  if (creatives?.creativeKind === 'image' && videoPreferences.restitchEnabled) invalid();
  return {
    ...videoPreferences,
    ...(creatives ?? {}),
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

/** 062: the creative list of a request: distinct materials, the first is the request's video, shares add up. */
function parseCatalogRequestCreatives(
  body: Record<string, unknown>,
  productCount: number,
  videoMaterialId: string
): { creativeKind: CatalogCreativeKind; creatives: CatalogRequestCreative[] } | null {
  if (body.creatives === undefined && body.creativeKind === undefined) return null;
  const kind = body.creativeKind;
  const list = body.creatives;
  if ((kind !== 'video' && kind !== 'image') || !Array.isArray(list) || list.length < 1) invalid();
  if (list.length > productCount) invalid('count');
  const seen = new Set<string>();
  const creatives: CatalogRequestCreative[] = [];
  let total = 0;
  for (const item of list) {
    if (
      !isRecord(item) ||
      Object.keys(item).some(key => !['materialId', 'alias', 'copies'].includes(key)) ||
      typeof item.materialId !== 'string' ||
      !UUID.test(item.materialId) ||
      typeof item.alias !== 'string' ||
      !CREATIVE_ALIAS.test(item.alias) ||
      typeof item.copies !== 'number' ||
      !Number.isSafeInteger(item.copies) ||
      item.copies < 1
    )
      invalid();
    const id = item.materialId.toLowerCase();
    if (seen.has(id)) throw new TeamFunctionError('CREATIVE_DUPLICATE', { retryable: false });
    seen.add(id);
    total += item.copies;
    creatives.push({ materialId: item.materialId, alias: item.alias, copies: item.copies });
  }
  if (total !== productCount)
    throw new TeamFunctionError('DISTRIBUTION_INVALID', { retryable: false });
  if (creatives[0]!.materialId.toLowerCase() !== videoMaterialId.toLowerCase()) invalid();
  return { creativeKind: kind, creatives };
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

/**
 * Maps a few at a time and answers in input order; a refusal is the one of the earliest item,
 * as the one-by-one loop it replaces would have thrown. Only for reads: every item runs.
 * Twenty image creatives were read and proven one by one in ~8 s of every pass (prod 2026-11-25).
 */
async function inOrderBounded<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
  concurrency = 4
): Promise<R[]> {
  const settled: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        settled[index] = { status: 'fulfilled', value: await map(items[index]!) };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return settled.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

/** Use the same MIME/extension rules as indexing, against the proven live file. */
function assertLiveVideo(file: DriveFileMetadata, kind: CatalogCreativeKind = 'video') {
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
  if (classification.category !== kind)
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
}

/** A creative other than the first: loaded, of the catalog's kind, proven live. */
interface ProvenCreative {
  ordinal: number;
  request: CatalogRequestCreative;
  material: CatalogVideo;
  drive: CatalogDrive;
  live: DriveFileMetadata;
}

/** Opens a proven creative to anyone with the link, as the first video always was. */
async function shareCreativeVideo(
  deps: ProductCatalogDeps,
  teamId: string,
  actorId: string,
  creative: Pick<ProvenCreative, 'material' | 'drive' | 'live'>
): Promise<boolean> {
  const permissions = await creative.drive.listAnyonePermissions(creative.live.id);
  if (permissions.length > 0) return false;
  // Opening a video to anyone with the link changes the video, so it needs `edit` on it.
  await deps.loadVideo({ teamId, videoId: creative.material.id, actorId, permission: 'edit' });
  if (creative.live.capabilities.canShare !== true)
    throw new TeamFunctionError('SHARE_NOT_ALLOWED', { retryable: false });
  return (await ensureAnyoneReader(creative.drive, creative.live.id, permissions)).added;
}

/**
 * 057: where a new catalog's rows are written and committed as the catalog's material.
 *
 * The Google sheet (`googleCatalogDocumentWriter`) is the default and the only writer a Drive
 * space ever gets. An R2 space writes its feed instead (`catalog-feed-document.ts`), whose
 * address is what `sheet_url` holds. A writer cleans up after its own failures; once it has
 * returned, `discard` removes what it made (lost race, rollback) and never throws.
 */
export interface CatalogDocument {
  name: string;
  sheetUrl: string;
  materialId: string;
  /** Extra fields of the catalog record (an R2 feed: its id and bytes). */
  record?: Record<string, unknown>;
  discard(why: 'lost the race' | 'rolled back'): Promise<void>;
  /** An older document the link retired. */
  retire(retired: { driveFileId: string; resourceKey: string | null }): Promise<void>;
}

export interface CatalogDocumentWriter {
  write(input: {
    name: string;
    parentId: string;
    credentialId: string;
    rows: XlsxCell[][];
    authority: OperationAuthority;
    actorId: string;
  }): Promise<CatalogDocument>;
}

/** The Google sheet: converted from XLSX (or native on the local beta), shared, committed. */
export function googleCatalogDocumentWriter(
  deps: ProductCatalogDeps,
  drive: CatalogDrive
): CatalogDocumentWriter {
  return {
    async write({ name, parentId, credentialId, rows: sheetRows, authority, actorId }) {
      const recoveredFile = await deps.readCreatedFile?.(parentId, credentialId);
      const file =
        recoveredFile ??
        (deps.nativeSpreadsheet
          ? await (() => {
              if (!drive.createNativeSpreadsheet || !drive.writeNativeSpreadsheet)
                throw new TeamFunctionError('INVALID_RESPONSE');
              return drive.createNativeSpreadsheet({ name, parentId });
            })()
          : await drive.createConvertedFile({
              name,
              parentId,
              sourceMimeType: XLSX_MIME_TYPE,
              targetMimeType: SPREADSHEET_MIME_TYPE,
              bytes: deps.buildWorkbook
                ? await deps.buildWorkbook(sheetRows)
                : await buildXlsx({ sheetName: PRODUCT_CATALOG_SHEET_NAME, rows: sheetRows })
            }));
      let committedFile = file;
      const created = { driveFileId: file.id, resourceKey: file.resourceKey ?? null };
      const discard = (why: string) => trashQuietly(deps, drive, created, why);
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
        return {
          name: committedFile.name,
          sheetUrl,
          materialId: committed.materialId,
          discard,
          retire: retired => trashQuietly(deps, drive, retired, 'retired catalog')
        };
      } catch (error) {
        // A sheet that is not shared or not committed is not a catalog. It leaves.
        if (!deps.preserveUncertainOutput) await discard('rolled back');
        throw error;
      }
    }
  };
}

export async function createProductCatalog(
  deps: ProductCatalogDeps,
  body: unknown,
  actorId: string
): Promise<CreateProductCatalogResult> {
  const request = parseCreateProductCatalogRequest(body);
  const { teamId, videoMaterialId: videoId } = request;

  await deps.assertImageContract?.(teamId, request.catalogImageContractVersion);
  const kind: CatalogCreativeKind = request.creativeKind ?? 'video';
  const space = deps.space;
  if (space) {
    if (kind !== 'video' || (request.creatives?.length ?? 1) > 1)
      throw new TeamFunctionError('MULTI_CREATIVE_UNSUPPORTED', { retryable: false });
    if (request.restitchOperationId || request.catalogVideoProtocolVersion !== undefined)
      throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
  }
  // Refusals first: nothing below this block may leave anything behind.
  const video = await deps.loadVideo({ teamId, videoId, actorId, permission: 'view' });
  if (video.category !== kind) {
    if (kind === 'video') wrongState('not_a_video');
    throw new TeamFunctionError('CREATIVES_MIXED', { retryable: false });
  }
  // 062: the other creatives are loaded and checked before anything is written.
  const others: Array<Omit<ProvenCreative, 'drive' | 'live'>> = await inOrderBounded(
    [...(request.creatives ?? []).entries()].slice(1),
    async ([ordinal, creative]) => {
      const material = await deps.loadVideo({
        teamId,
        videoId: creative.materialId,
        actorId,
        permission: 'view'
      });
      if (material.category !== kind)
        throw new TeamFunctionError('CREATIVES_MIXED', { retryable: false });
      return { ordinal, request: creative, material };
    }
  );
  if (kind === 'image' && !deps.publishCreativeImages)
    throw new TeamFunctionError('MULTI_CREATIVE_UNSUPPORTED', { retryable: false });
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
  assertLiveVideo(liveVideo, kind);
  // The selected file can move before the index catches up. Do not publish
  // beside its stale parent or redirect a durable operation's frozen target.
  if (!video.parentFolderId || !liveVideo.parents.includes(video.parentFolderId))
    throw new TeamFunctionError('SOURCE_CHANGED', { retryable: false });
  // Both reads are authorized by the proven source. Keep destination refusals first,
  // and do not change video permissions until both reads have completed.
  const [destination, videoPermissions] = await alongside(
    deps.destination({ teamId, actorId, folderId: video.parentFolderId }),
    space ? Promise.resolve([]) : drive.listAnyonePermissions(liveVideo.id)
  );
  const copyDrive = restitched ? await deps.driveFor(restitched.credentialId) : null;
  const liveCopy = restitched && copyDrive ? await deps.proveVideo(restitched, copyDrive) : null;
  if (liveCopy) assertLiveVideo(liveCopy);

  const proven: ProvenCreative[] = await inOrderBounded(others, async other => {
    const otherDrive = await deps.driveFor(other.material.credentialId);
    const live = await deps.proveVideo(other.material, otherDrive);
    assertLiveVideo(live, kind);
    return { ...other, drive: otherDrive, live };
  });

  let videoShared = false;
  if (
    !space &&
    kind === 'video' &&
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
  const originalVideoLink = space
    ? await space.videoLink({ teamId, actorId, video })
    : videoShareLink(liveVideo.id, liveVideo.resourceKey ?? video.resourceKey);
  // Every other video is shared the same way; a restitched one links its set's outputs instead.
  const creativeVideoLinks: string[] = [originalVideoLink];
  for (const creative of proven) {
    if (kind !== 'video') break;
    if (!(request.catalogVideoProtocolVersion === 1 && request.restitchEnabled))
      await shareCreativeVideo(deps, teamId, actorId, creative);
    creativeVideoLinks.push(
      videoShareLink(creative.live.id, creative.live.resourceKey ?? creative.material.resourceKey)
    );
  }
  // Without R2 an image creative is linked from Drive, so it is opened to anyone with the
  // link the same way a video is (and needs `edit` for that).
  if (kind === 'image' && request.copyVideoToR2 !== true) {
    if (videoPermissions.length === 0)
      await shareCreativeVideo(deps, teamId, actorId, { material: video, drive, live: liveVideo });
    for (const creative of proven) await shareCreativeVideo(deps, teamId, actorId, creative);
  }
  // Image creatives are published (R2 or Drive) and anonymously verified before any sheet exists.
  const imageLinks =
    kind === 'image'
      ? await deps.publishCreativeImages!({
          teamId,
          actorId,
          copyToR2: request.copyVideoToR2 === true,
          images: [
            { ordinal: 0, material: video, live: liveVideo, drive },
            ...proven.map(creative => ({
              ordinal: creative.ordinal,
              material: creative.material,
              live: creative.live,
              drive: creative.drive
            }))
          ]
        })
      : [];
  if (
    kind === 'image' &&
    (imageLinks.length !== 1 + proven.length ||
      imageLinks.some(
        (image, ordinal) => image.ordinal !== ordinal || !/^https:\/\/\S+$/u.test(image.link)
      ))
  )
    throw new TeamFunctionError('INVALID_RESPONSE');
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
    name: productCatalogName(video.name, variant, proven.length),
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
      // An R2 space has no Drive to share a legacy pool picture from; its pool is published.
      if (space) {
        if (images.some(legacyImage))
          throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
      } else await createCatalogImageSharer(drive)(images.filter(legacyImage));
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
      // An image row keeps the white picture's words and details; it has no video, so no tag.
      if (kind === 'image') planned = planned.map(row => ({ ...row, videoTag: '' }));
      if (deps.rememberRowRecipe) planned = await deps.rememberRowRecipe(planned);
      return planned;
    })(),
    namePlan
  );
  const first = planned[0]!;
  /* 062: which creative owns which rows. A request from before names its one video, whose
     prefix comes from the file's name (explorer) — older catalogs have no layout at all. */
  const requestCreatives: CatalogRequestCreative[] = request.creatives ?? [
    { materialId: videoId, alias: catalogIdPrefix(video.name), copies: request.productCount }
  ];
  const rowCreatives = catalogRowCreatives(requestCreatives.map(creative => creative.copies));
  if (rowCreatives.length !== request.productCount) throw new TeamFunctionError('INVALID_INPUT');
  /* Each block links with its own SUB «Креатив» when the Launch gives one per creative; the
     links live in the layout, so every later update writes the same block's own link. */
  let creativeSourceLinks: string[] | null = null;
  const resolvedCreativeLinks = deps.resolveCreativeSourceLinks
    ? await deps.resolveCreativeSourceLinks(plan.name)
    : null;
  if (resolvedCreativeLinks) {
    if (resolvedCreativeLinks.length !== requestCreatives.length)
      throw new TeamFunctionError('LAUNCH_SUB_INVALID');
    creativeSourceLinks = resolvedCreativeLinks.map(raw => {
      const link = parseWebLink(raw, SOURCE_LINK_MAX);
      if (!link.ok) throw new TeamFunctionError('LAUNCH_SUB_INVALID');
      return link.value;
    });
  }
  // H holds the creative's own image at once only when nothing schedules its publication.
  const publicationHeld = request.videoPublication?.mode === 'scheduled';
  const snapshotCreatives: CatalogSnapshotCreative[] = requestCreatives.map((creative, ordinal) => {
    const image = imageLinks[ordinal];
    const ownVideo =
      kind === 'video' &&
      !restitched &&
      !(request.catalogVideoProtocolVersion === 1 && request.restitchEnabled);
    return {
      ordinal,
      materialId: creative.materialId,
      alias: creative.alias,
      kind,
      ...(image?.imageId ? { imageId: image.imageId } : {}),
      ...(image && !publicationHeld ? { link: image.link, linkKind: image.linkKind } : {}),
      ...(ownVideo && !publicationHeld
        ? {
            link: creativeVideoLinks[ordinal]!,
            linkKind: space ? ('r2' as const) : ('drive' as const)
          }
        : {}),
      ...(creativeSourceLinks ? { sourceLink: creativeSourceLinks[ordinal]! } : {})
    };
  });
  const creativeCells: CatalogCreativeCells[] = requestCreatives.map((creative, ordinal) => ({
    idPrefix: catalogIdPrefix(creative.alias),
    kind,
    ...(kind === 'video' && ordinal > 0 ? { videoLink: creativeVideoLinks[ordinal]! } : {}),
    ...(kind === 'image' && !publicationHeld ? { imageLink: imageLinks[ordinal]!.link } : {}),
    ...(creativeSourceLinks ? { sourceLink: creativeSourceLinks[ordinal]! } : {})
  }));
  /* Kept for sheets and workers that read one value: the first row's. */
  const snapshot = {
    title: first.title,
    description: first.description,
    price: first.price,
    imageLink: first.imageLink,
    randomLinkVariation: request.randomLinkVariation !== false,
    rows: planned,
    ...(settings.contentPolicyVersion === 1 ? { contentPolicyVersion: 1 } : {}),
    ...catalogCreativeSnapshot({ kind, creatives: snapshotCreatives, rowCreatives })
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
      rows: planned,
      creatives: creativeCells,
      rowCreatives
    });
    if (deps.rememberSheetRows) sheetRows = await deps.rememberSheetRows(sheetRows);
    if (deps.nativeSpreadsheet) nativeCatalogCellRows(sheetRows);
    await deps.beforeImageWrite?.();
    // 057: the document is a Google sheet unless the space hands in another writer (an R2
    // space's feed). The Google writer is the code that stood here, unchanged.
    const writer = deps.documentWriter ?? googleCatalogDocumentWriter(deps, drive);
    const document = await writer.write({
      name: plan.name,
      parentId: destination.live.id,
      credentialId: video.credentialId,
      rows: sheetRows,
      authority,
      actorId
    });
    try {
      const sheetUrl = document.sheetUrl;
      const linked = await deps.link({
        teamId,
        videoId,
        companionId: document.materialId,
        replaces,
        record: {
          sourceLink: request.sourceLink,
          productCount: request.productCount,
          sheetUrl,
          // An image catalog has no video link (R19); the first creative is still its material.
          videoLink: kind === 'image' ? null : originalVideoLink,
          ...(restitched && request.restitchOperationId
            ? {
                currentVideoLink: videoLink,
                restitchMaterialId: restitched.id,
                restitchOperationId: request.restitchOperationId
              }
            : {}),
          settingsSnapshot: snapshot,
          createdBy: actorId,
          variant,
          ...(document.record ?? {})
        }
      });
      if (!linked.linked) {
        if (!deps.preserveUncertainOutput) await document.discard('lost the race');
        if (linked.reason === 'EXISTS' && linked.existing) {
          return { outcome: 'existing', catalog: linked.existing, videoShared };
        }
        throw new TeamFunctionError('WRONG_STATE', { retryable: true });
      }
      for (const retired of linked.retired) {
        await document.retire(retired);
      }
      if (request.copyVideoToR2)
        await deps.applyVideoR2Option?.({
          teamId,
          actorId,
          catalogMaterialId: document.materialId,
          queueCopy: request.catalogVideoProtocolVersion !== 1
        });
      return {
        outcome: replaces ? 'recreated' : 'created',
        catalog: {
          materialId: document.materialId,
          name: document.name,
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
      if (!deps.preserveUncertainOutput) await document.discard('rolled back');
      throw error;
    }
  } catch (error) {
    await deps.failOperation(authority.operationId, error);
    throw error;
  }
}
