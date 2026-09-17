import { rebuildCatalogRows, retryDelaySeconds } from '../_shared/catalog-updater.ts';
import type { GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { ensureAnyoneReader } from '../_shared/link-sharing.ts';
import {
  PRODUCT_CATALOG_SHEET_NAME,
  SPREADSHEET_MIME_TYPE,
  PRODUCT_COUNT_MAX,
  driveImageLink,
  randomPrice,
  type ProductCatalogRowDetails,
  type ProductCatalogRowValues,
  type ProductCatalogSettingsValues
} from '../_shared/product-catalog.ts';
import { drawProductDetails, inventedBrand } from '../_shared/product-details.ts';
import { isRecord } from '../_shared/validation.ts';
import { buildXlsx } from '../_shared/xlsx.ts';

/**
 * One tick of the catalog updater (feature 023).
 *
 * Opens the rounds that are due, then claims sheets and rewrites each in place with its IDs moved
 * one update on, a few at a time, until the time budget is spent. A sheet that fails is retried
 * on its own back-off and never holds the others; a sheet whose lease was lost is left to whoever
 * holds it now. Everything outside this file — the database, Drive, the clock — arrives as deps.
 *
 * With re-stitching (delivery 2) a sheet whose spare copy is ready is written with the spare's link,
 * and the completion swaps the copies; without a ready spare it keeps the copy it points at. Copies
 * the database has retired are then deleted for good — only those, by the ids it hands out.
 */

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CLAIM_LIMIT = 10;
const LEASE_SECONDS = 60;
const PARALLEL = 3;
const RETIRED_LIMIT = 10;
const ORPHAN_LIMIT = 10;

export type UpdaterDrive = Pick<
  GoogleDriveClient,
  | 'updateConvertedFile'
  | 'deleteFile'
  | 'updateFileMetadata'
  | 'listAnyonePermissions'
  | 'createAnyoneReaderPermission'
>;

export interface ClaimedCatalog {
  catalogId: string;
  attempts: number;
  updateCount: number;
  productCount: number;
  sourceLink: string;
  videoLink: string;
  settings: ProductCatalogSettingsValues;
  /** Each row's own values, when the catalog was made from pools (024). */
  rows?: ProductCatalogRowValues[];
  /** The space whose picture pool a refresh draws from. */
  teamId?: string | null;
  /** Draw the rows' pictures afresh at this update (024, on unless turned off). */
  refreshImages?: boolean;
  /** Draw fresh names, texts and prices at this update (024 US21, on unless turned off). */
  refreshTexts?: boolean;
  /** The space's price range, for a row whose price is drawn again. */
  priceRange?: { min: number; max: number } | null;
  /** Add one to five products at this update (024 US22, off unless turned on). */
  growProducts?: boolean;
  driveFileId: string;
  resourceKey: string | null;
  credentialId: string;
  /** The in-use re-stitched copy's link, when the sheet points at one. */
  currentVideoLink: string | null;
  /** The spare to swap to at this update, when one is ready. */
  spare: { materialId: string; link: string } | null;
}

export interface RetiredCopy {
  materialId: string;
  driveFileId: string;
  credentialId: string;
}

export interface CatalogUpdaterDeps {
  workerId: string;
  /** Pictures from the space's pool, none repeated until the pool is spent (024). */
  drawImages?(
    teamId: string,
    count: number
  ): Promise<Array<{ driveFileId: string; resourceKey: string | null }>>;
  /** Names and texts from the space's pool, the same way (024, US21). */
  drawTexts?(teamId: string, count: number): Promise<Array<{ title: string; description: string }>>;
  openRounds(): Promise<number>;
  claim(limit: number, leaseSeconds: number): Promise<unknown[]>;
  driveFor(credentialId: string): Promise<UpdaterDrive>;
  complete(
    catalogId: string,
    updateCount: number,
    swappedCopy: string | null,
    /** What the sheet became (024 US22): its product count and the rows behind it. */
    became?: { productCount: number; snapshot: Record<string, unknown> }
  ): Promise<boolean>;
  retry(catalogId: string, errorCode: string, nextAttemptAt: Date): Promise<boolean>;
  markNeedsReauth(credentialId: string): Promise<void>;
  claimRetired(limit: number): Promise<unknown[]>;
  /** `deleted` false records one more failed try; the database gives up after five. */
  forgetCopy(materialId: string, deleted: boolean): Promise<boolean>;
  /** What a gone video left behind: its sheet and its text, a day after it went (024, US24). */
  claimOrphans?(limit: number, leaseSeconds: number): Promise<unknown[]>;
  clearOrphan?(materialId: string, trashed: boolean): Promise<boolean>;
  now(): number;
  log(message: string, detail: string): void;
}

export interface TickSummary {
  rounds: number;
  claimed: number;
  updated: number;
  failed: number;
  skipped: number;
  deletedCopies: number;
  /** Sheets and texts of deleted videos, put in Drive's bin (024, US24). */
  clearedOrphans: number;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function wholeNumber(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** A claimed row from `service_claim_catalog_updater_items`, or null when it is not one. */
export function parseClaimedCatalog(row: unknown): ClaimedCatalog | null {
  if (!isRecord(row)) return null;
  const settings = isRecord(row.settings_snapshot) ? row.settings_snapshot : null;
  const catalogId = text(row.catalog_material_id);
  const attempts = wholeNumber(row.attempts);
  const updateCount = wholeNumber(row.update_count);
  const productCount = wholeNumber(row.product_count);
  const sourceLink = text(row.source_link);
  const videoLink = text(row.video_link);
  const driveFileId = text(row.drive_file_id);
  const credentialId = text(row.credential_id);
  const price = settings ? wholeNumber(settings.price) : null;
  const spareMaterialId = text(row.spare_material_id);
  const spareLink = text(row.spare_link);
  if (
    !catalogId ||
    attempts === null ||
    updateCount === null ||
    productCount === null ||
    productCount < 1 ||
    !sourceLink ||
    !videoLink ||
    !driveFileId ||
    !credentialId ||
    !settings ||
    typeof settings.title !== 'string' ||
    typeof settings.description !== 'string' ||
    typeof settings.imageLink !== 'string' ||
    price === null
  ) {
    return null;
  }
  const rows = parseSnapshotRows(settings.rows, productCount);
  return {
    catalogId,
    attempts,
    updateCount,
    productCount,
    sourceLink,
    videoLink,
    settings: {
      title: settings.title,
      description: settings.description,
      price,
      imageLink: settings.imageLink
    },
    ...(rows ? { rows } : {}),
    teamId: text(row.team_id),
    refreshImages: row.refresh_images !== false,
    refreshTexts: row.refresh_texts !== false,
    priceRange: priceRangeOf(row),
    growProducts: row.grow_products === true,
    driveFileId,
    resourceKey: text(row.resource_key),
    credentialId,
    currentVideoLink: text(row.current_video_link),
    spare: spareMaterialId && spareLink ? { materialId: spareMaterialId, link: spareLink } : null
  };
}

/** The space's price range as the claim carries it; none when the space keeps no settings row. */
function priceRangeOf(row: Record<string, unknown>): { min: number; max: number } | null {
  const min = wholeNumber(row.price_min);
  const max = wholeNumber(row.price_max);
  return min === null || max === null ? null : { min, max };
}

/** A snapshot's per-row values, when they are all there and whole; otherwise none. */
function parseSnapshotRows(value: unknown, count: number): ProductCatalogRowValues[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const rows: ProductCatalogRowValues[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.title !== 'string' ||
      typeof entry.description !== 'string' ||
      typeof entry.imageLink !== 'string' ||
      typeof entry.price !== 'number' ||
      !Number.isSafeInteger(entry.price)
    ) {
      return null;
    }
    rows.push({
      title: entry.title,
      description: entry.description,
      imageLink: entry.imageLink,
      price: entry.price,
      ...snapshotDetails(entry)
    });
  }
  return rows;
}

/** The US21 details a catalog was planned with, as far as the snapshot carries them. */
function snapshotDetails(entry: Record<string, unknown>): Partial<ProductCatalogRowDetails> {
  const details: Record<string, unknown> = {};
  for (const key of DETAIL_TEXT_KEYS) {
    if (typeof entry[key] === 'string') details[key] = entry[key];
  }
  for (const key of DETAIL_NUMBER_KEYS) {
    if (typeof entry[key] === 'number' && Number.isSafeInteger(entry[key])) {
      details[key] = entry[key];
    }
  }
  const tags = entry.tags;
  if (Array.isArray(tags) && tags.length === 2 && tags.every(tag => typeof tag === 'string')) {
    details.tags = [tags[0], tags[1]];
  }
  return details as Partial<ProductCatalogRowDetails>;
}

const DETAIL_TEXT_KEYS = [
  'saleWindow',
  'color',
  'size',
  'material',
  'pattern',
  'gender',
  'style',
  'googleCategory',
  'fbCategory',
  'brand',
  'shippingWeight',
  'shipping',
  'videoTag',
  'videoParam'
] as const;
const DETAIL_NUMBER_KEYS = ['salePrice', 'quantity'] as const;

/**
 * Fresh pictures for the rows (024): drawn from the space's pool and shared by link. None when
 * the refresh is off, the pool is empty, or the draw fails — the rows keep the pictures they had.
 */
async function refreshedRows(
  deps: CatalogUpdaterDeps,
  item: ClaimedCatalog,
  drive: UpdaterDrive,
  rows: ProductCatalogRowValues[] | undefined,
  count: number
): Promise<ProductCatalogRowValues[] | undefined> {
  if (!item.refreshImages || !item.teamId || !deps.drawImages) return rows;
  let drawn: Array<{ driveFileId: string; resourceKey: string | null }>;
  try {
    drawn = await deps.drawImages(item.teamId, count);
  } catch {
    return rows;
  }
  if (drawn.length === 0) return rows;
  const shared = new Set<string>();
  for (const image of drawn) {
    if (shared.has(image.driveFileId)) continue;
    await ensureAnyoneReader(drive, image.driveFileId);
    shared.add(image.driveFileId);
  }
  const base = rows ?? rowsOf(item, count);
  return base.map((row, index) => {
    const image = drawn[index % drawn.length]!;
    return { ...row, imageLink: driveImageLink(image.driveFileId, image.resourceKey) };
  });
}

const rowsOf = (item: ClaimedCatalog, count: number): ProductCatalogRowValues[] =>
  Array.from({ length: count }, (_, index) => item.rows?.[index] ?? { ...item.settings });

/** One to five more products than the sheet holds, and never past the 400 a sheet may hold. */
export function grownCount(
  productCount: number,
  grow: boolean,
  random: () => number = Math.random
): number {
  if (!grow) return productCount;
  return Math.min(PRODUCT_COUNT_MAX, productCount + 1 + Math.floor(random() * 5));
}

/**
 * The products an update adds (024 US22).
 *
 * They are new products, so they get a name, a text and a picture of their own whatever the two
 * refresh ticks say — a row that repeated the space's fallback title would be the one thing in the
 * catalog that looks machine-made. When a pool has nothing left to give, the new rows fall back to
 * the space's single values, so the count still grows.
 */
async function addedRows(
  deps: CatalogUpdaterDeps,
  item: ClaimedCatalog,
  drive: UpdaterDrive,
  count: number
): Promise<ProductCatalogRowValues[] | undefined> {
  const added = count - item.productCount;
  if (added <= 0) return item.rows;
  const base = rowsOf(item, item.productCount);
  const teamId = item.teamId;
  const texts = teamId && deps.drawTexts ? await deps.drawTexts(teamId, added).catch(() => []) : [];
  const images =
    teamId && deps.drawImages ? await deps.drawImages(teamId, added).catch(() => []) : [];
  const shared = new Set<string>();
  for (const image of images) {
    if (shared.has(image.driveFileId)) continue;
    await ensureAnyoneReader(drive, image.driveFileId);
    shared.add(image.driveFileId);
  }
  const brand = base[0]?.brand ?? inventedBrand();
  for (let index = 0; index < added; index += 1) {
    const text = texts[index % texts.length] ?? null;
    const image = images[index % images.length] ?? null;
    const title = text?.title ?? item.settings.title;
    const price = item.priceRange
      ? randomPrice(item.priceRange.min, item.priceRange.max)
      : item.settings.price;
    base.push({
      title,
      description: text?.description ?? item.settings.description,
      imageLink: image
        ? driveImageLink(image.driveFileId, image.resourceKey)
        : item.settings.imageLink,
      price,
      ...drawProductDetails({ title, price, brand })
    });
  }
  return base;
}

/**
 * Fresh names, texts and prices for the rows (024, US21).
 *
 * A catalog whose every row keeps its name and its price for weeks is the same catalog however
 * often it is written. With the tick on, each row draws a new pair from the space's text pool and
 * a new price from its range, and the details that follow a name — its colour, its fabric, its
 * category — are worked out again from the new name. Off, or with nothing to draw, the rows keep
 * what they had.
 */
async function refreshedTexts(
  deps: CatalogUpdaterDeps,
  item: ClaimedCatalog,
  rows: ProductCatalogRowValues[] | undefined,
  count: number
): Promise<ProductCatalogRowValues[] | undefined> {
  if (!item.refreshTexts || !item.teamId || !deps.drawTexts) return rows;
  let drawn: Array<{ title: string; description: string }>;
  try {
    drawn = await deps.drawTexts(item.teamId, count);
  } catch {
    return rows;
  }
  if (drawn.length === 0) return rows;
  const base = rows ?? rowsOf(item, count);
  const brand = base[0]?.brand ?? inventedBrand();
  return base.map((row, index) => {
    const text = drawn[index % drawn.length]!;
    const price = item.priceRange
      ? randomPrice(item.priceRange.min, item.priceRange.max)
      : row.price;
    return {
      ...row,
      title: text.title,
      description: text.description,
      price,
      ...drawProductDetails({ title: text.title, price, brand })
    };
  });
}

export function parseRetiredCopy(row: unknown): RetiredCopy | null {
  if (!isRecord(row)) return null;
  const materialId = text(row.material_id);
  const driveFileId = text(row.drive_file_id);
  const credentialId = text(row.credential_id);
  return materialId && driveFileId && credentialId
    ? { materialId, driveFileId, credentialId }
    : null;
}

interface OrphanFile {
  materialId: string;
  driveFileId: string;
  credentialId: string;
  name: string;
}

function parseOrphan(row: unknown): OrphanFile | null {
  if (!isRecord(row)) return null;
  const materialId = text(row.material_id);
  const driveFileId = text(row.drive_file_id);
  const credentialId = text(row.credential_id);
  if (!materialId || !driveFileId || !credentialId) return null;
  return { materialId, driveFileId, credentialId, name: text(row.name) ?? '' };
}

/**
 * The leftovers of a deleted video, put in Drive's bin (024, US24).
 *
 * Drive's own bin rather than a hard delete: a video restored from it after the day's grace can
 * have its sheet and its text restored the same way, by the person who deleted them.
 */
async function clearOrphans(deps: CatalogUpdaterDeps, summary: TickSummary): Promise<void> {
  if (!deps.claimOrphans || !deps.clearOrphan) return;
  const rows = await deps.claimOrphans(ORPHAN_LIMIT, LEASE_SECONDS).catch(() => []);
  for (const row of rows) {
    const orphan = parseOrphan(row);
    if (!orphan) continue;
    try {
      const drive = await deps.driveFor(orphan.credentialId);
      await drive.updateFileMetadata({ fileId: orphan.driveFileId, trashed: true });
      await deps.clearOrphan(orphan.materialId, true);
      summary.clearedOrphans += 1;
    } catch (error) {
      deps.log('[catalog-updater] orphan not cleared', `${orphan.materialId} ${codeOf(error)}`);
      await deps.clearOrphan(orphan.materialId, false).catch(() => false);
    }
  }
}

function codeOf(error: unknown): string {
  return error instanceof TeamFunctionError ? error.code : 'DRIVE_UNAVAILABLE';
}

async function updateOne(
  deps: CatalogUpdaterDeps,
  item: ClaimedCatalog,
  summary: TickSummary
): Promise<void> {
  const nextCount = item.updateCount + 1;
  try {
    const drive = await deps.driveFor(item.credentialId);
    const count = grownCount(item.productCount, item.growProducts === true);
    const rows = await refreshedTexts(
      deps,
      item,
      await refreshedRows(deps, item, drive, await addedRows(deps, item, drive, count), count),
      count
    );
    const bytes = await buildXlsx({
      sheetName: PRODUCT_CATALOG_SHEET_NAME,
      rows: rebuildCatalogRows({
        record: {
          settings: item.settings,
          sourceLink: item.sourceLink,
          videoLink: item.videoLink,
          productCount: count,
          rows
        },
        videoLinkOverride: item.spare?.link ?? item.currentVideoLink
      })
    });
    await drive.updateConvertedFile({
      fileId: item.driveFileId,
      resourceKey: item.resourceKey,
      sourceMimeType: XLSX_MIME_TYPE,
      targetMimeType: SPREADSHEET_MIME_TYPE,
      bytes
    });
    const first = rows?.[0];
    const became = first
      ? {
          productCount: count,
          snapshot: {
            title: first.title,
            description: first.description,
            price: first.price,
            imageLink: first.imageLink,
            rows
          }
        }
      : { productCount: count, snapshot: { ...item.settings } };
    if (await deps.complete(item.catalogId, nextCount, item.spare?.materialId ?? null, became)) {
      summary.updated += 1;
    } else {
      // The sheet was written, but someone else holds the lease now; their write wins.
      deps.log('[catalog-updater] lease lost after update', item.catalogId);
      summary.skipped += 1;
    }
  } catch (error) {
    const code = codeOf(error);
    if (code === 'NEEDS_REAUTH') {
      await deps.markNeedsReauth(item.credentialId).catch(() => undefined);
    }
    const next = new Date(deps.now() + retryDelaySeconds(item.attempts) * 1000);
    const recorded = await deps.retry(item.catalogId, code, next).catch(() => false);
    if (!recorded) deps.log('[catalog-updater] retry not recorded', `${item.catalogId} ${code}`);
    summary.failed += 1;
  }
}

export async function runCatalogUpdaterTick(
  deps: CatalogUpdaterDeps,
  options: { budgetMs: number }
): Promise<TickSummary> {
  const startedAt = deps.now();
  const summary: TickSummary = {
    rounds: 0,
    claimed: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    deletedCopies: 0,
    clearedOrphans: 0
  };
  summary.rounds = await deps.openRounds();

  while (deps.now() - startedAt < options.budgetMs) {
    const rows = await deps.claim(CLAIM_LIMIT, LEASE_SECONDS);
    if (rows.length === 0) break;
    const claimed: ClaimedCatalog[] = [];
    for (const row of rows) {
      const parsed = parseClaimedCatalog(row);
      if (parsed) {
        claimed.push(parsed);
        continue;
      }
      // Unreadable, but still leased: park it for a while rather than let it come back every tick.
      const id = isRecord(row) ? text(row.catalog_material_id) : null;
      deps.log('[catalog-updater] unreadable claimed row', id ?? 'unknown');
      if (id) {
        await deps
          .retry(id, 'INVALID_RESPONSE', new Date(deps.now() + retryDelaySeconds(3) * 1000))
          .catch(() => false);
        summary.failed += 1;
      }
    }
    summary.claimed += claimed.length;

    const queue = [...claimed];
    const runners = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        await updateOne(deps, item, summary);
      }
    });
    await Promise.all(runners);
  }

  if (deps.now() - startedAt < options.budgetMs) await clearOrphans(deps, summary);

  if (deps.now() - startedAt < options.budgetMs) {
    for (const row of await deps.claimRetired(RETIRED_LIMIT)) {
      const copy = parseRetiredCopy(row);
      if (!copy) continue;
      try {
        const drive = await deps.driveFor(copy.credentialId);
        await drive.deleteFile(copy.driveFileId);
        await deps.forgetCopy(copy.materialId, true);
        summary.deletedCopies += 1;
      } catch (error) {
        deps.log('[catalog-updater] copy not deleted', `${copy.materialId} ${codeOf(error)}`);
        await deps.forgetCopy(copy.materialId, false).catch(() => false);
      }
    }
  }
  return summary;
}
