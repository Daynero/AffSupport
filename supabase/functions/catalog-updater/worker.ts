import { rebuildCatalogRows, retryDelaySeconds } from '../_shared/catalog-updater.ts';
import type { GoogleDriveClient } from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import {
  PRODUCT_CATALOG_SHEET_NAME,
  SPREADSHEET_MIME_TYPE,
  type ProductCatalogSettingsValues
} from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';
import { buildXlsx } from '../_shared/xlsx.ts';

/**
 * One tick of the catalog updater (feature 023).
 *
 * Opens the rounds that are due, then claims sheets and rewrites each in place with its IDs moved
 * one update on, a few at a time, until the time budget is spent. A sheet that fails is retried
 * on its own back-off and never holds the others; a sheet whose lease was lost is left to whoever
 * holds it now. Everything outside this file — the database, Drive, the clock — arrives as deps.
 */

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CLAIM_LIMIT = 10;
const LEASE_SECONDS = 60;
const PARALLEL = 3;

export type UpdaterDrive = Pick<GoogleDriveClient, 'updateConvertedFile'>;

export interface ClaimedCatalog {
  catalogId: string;
  attempts: number;
  updateCount: number;
  productCount: number;
  sourceLink: string;
  videoLink: string;
  settings: ProductCatalogSettingsValues;
  driveFileId: string;
  resourceKey: string | null;
  credentialId: string;
}

export interface CatalogUpdaterDeps {
  workerId: string;
  openRounds(): Promise<number>;
  claim(limit: number, leaseSeconds: number): Promise<unknown[]>;
  driveFor(credentialId: string): Promise<UpdaterDrive>;
  complete(catalogId: string, updateCount: number): Promise<boolean>;
  retry(catalogId: string, errorCode: string, nextAttemptAt: Date): Promise<boolean>;
  markNeedsReauth(credentialId: string): Promise<void>;
  now(): number;
  log(message: string, detail: string): void;
}

export interface TickSummary {
  rounds: number;
  claimed: number;
  updated: number;
  failed: number;
  skipped: number;
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
    driveFileId,
    resourceKey: text(row.resource_key),
    credentialId
  };
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
    const bytes = await buildXlsx({
      sheetName: PRODUCT_CATALOG_SHEET_NAME,
      rows: rebuildCatalogRows({
        record: {
          settings: item.settings,
          sourceLink: item.sourceLink,
          videoLink: item.videoLink,
          productCount: item.productCount
        },
        updateCount: nextCount
      })
    });
    await drive.updateConvertedFile({
      fileId: item.driveFileId,
      resourceKey: item.resourceKey,
      sourceMimeType: XLSX_MIME_TYPE,
      targetMimeType: SPREADSHEET_MIME_TYPE,
      bytes
    });
    if (await deps.complete(item.catalogId, nextCount)) {
      summary.updated += 1;
    } else {
      // The sheet was written, but someone else holds the lease now; they will write the same IDs.
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
  const summary: TickSummary = { rounds: 0, claimed: 0, updated: 0, failed: 0, skipped: 0 };
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
  return summary;
}
