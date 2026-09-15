/**
 * The catalog updater's rules (feature 023) — nothing here does I/O.
 *
 * A catalog sheet made by 022 is rewritten in place on every round: the same cells, with every
 * product ID moved on by the owner's rule, and — once a re-stitched copy is ready — every video
 * link pointing at it. The rows are rebuilt from what the catalog was made from, never read back
 * from the sheet, so a retried update writes exactly the same thing and a hand edit is overwritten.
 */

import {
  PRODUCT_CATALOG_HEADER_ROWS,
  PRODUCT_CATALOG_TEMPLATE,
  buildProductCatalogRows,
  type Cell,
  type ProductCatalogSettingsValues
} from './product-catalog.ts';

export const UPDATER_INTERVALS = { '1h': 3_600, '1d': 86_400, '1w': 604_800 } as const;
export type UpdaterInterval = keyof typeof UPDATER_INTERVALS;

export function parseUpdaterInterval(value: unknown): UpdaterInterval | null {
  return typeof value === 'string' && Object.hasOwn(UPDATER_INTERVALS, value)
    ? (value as UpdaterInterval)
    : null;
}

/**
 * How far every ID has moved after `updateCount` updates.
 *
 * The owner's rule: the first update adds 500, the second 501, the third 502 — the step itself
 * grows, so the sequence does not read as a fixed pattern. Summed, that is 500·k + k·(k−1)/2. Every
 * step is at least 500 and a sheet has at most 400 products, so no ID can come back.
 */
export function idOffset(updateCount: number): number {
  if (!Number.isSafeInteger(updateCount) || updateCount < 0) {
    throw new RangeError('update count must be a non-negative integer');
  }
  return 500 * updateCount + (updateCount * (updateCount - 1)) / 2;
}

export interface CatalogRecord {
  settings: ProductCatalogSettingsValues;
  sourceLink: string;
  videoLink: string;
  productCount: number;
}

const ID_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'rowNumber');
const VIDEO_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(
  column => column.source.kind === 'videoLink'
);

/**
 * The sheet as it should read after `updateCount` updates.
 *
 * 022's rows untouched except column A (the ID) and, when `videoLinkOverride` is given, column Z —
 * the re-stitched copy's link, still made distinct per row with `?v=NNN` as 022 does.
 */
export function rebuildCatalogRows(input: {
  record: CatalogRecord;
  updateCount: number;
  videoLinkOverride?: string | null;
}): Cell[][] {
  const offset = idOffset(input.updateCount);
  const rows = buildProductCatalogRows({
    settings: input.record.settings,
    sourceLink: input.record.sourceLink,
    videoLink: input.videoLinkOverride ?? input.record.videoLink,
    count: input.record.productCount
  });
  for (let index = PRODUCT_CATALOG_HEADER_ROWS; index < rows.length; index += 1) {
    const productNumber = index - PRODUCT_CATALOG_HEADER_ROWS + 1;
    rows[index]![ID_COLUMN] = { t: 'number', v: productNumber + offset };
  }
  return rows;
}

export const CATALOG_UPDATER_COLUMNS = { id: ID_COLUMN, video: VIDEO_COLUMN } as const;

/** Back-off after a failed update: 1, 5, 15 minutes, then every 15 minutes. */
export function retryDelaySeconds(attempts: number): number {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 300;
  return 900;
}
