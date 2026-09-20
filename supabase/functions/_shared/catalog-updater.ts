/**
 * The catalog updater's rules (feature 023) — nothing here does I/O.
 *
 * A catalog sheet made by 022 is rewritten in place on every round: the same cells, with every
 * product ID moved on by the owner's rule, and — once a re-stitched copy is ready — every video
 * link pointing at it. The rows are rebuilt from what the catalog was made from, never read back
 * from the sheet, so a retried update writes exactly the same thing and a hand edit is overwritten.
 */

import {
  PRODUCT_CATALOG_TEMPLATE,
  buildProductCatalogRows,
  type Cell,
  type ProductCatalogRowValues,
  type ProductCatalogSettingsValues
} from './product-catalog.ts';

export const UPDATER_INTERVALS = { '1h': 3_600, '1d': 86_400, '1w': 604_800 } as const;
export type UpdaterPreset = keyof typeof UPDATER_INTERVALS;
/** A preset, or an interval of the updater's own in whole hours: `'6h'`. */
export type UpdaterInterval = UpdaterPreset | `${number}h`;
export const CUSTOM_INTERVAL_MAX_HOURS = 720;

const CUSTOM_INTERVAL = /^[1-9][0-9]{0,2}h$/u;

export function parseUpdaterInterval(value: unknown): UpdaterInterval | null {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(UPDATER_INTERVALS, value)) return value as UpdaterPreset;
  return CUSTOM_INTERVAL.test(value) && Number(value.slice(0, -1)) <= CUSTOM_INTERVAL_MAX_HOURS
    ? (value as `${number}h`)
    : null;
}

export function updaterIntervalSeconds(interval: UpdaterInterval): number {
  return Object.hasOwn(UPDATER_INTERVALS, interval)
    ? UPDATER_INTERVALS[interval as UpdaterPreset]
    : Number(interval.slice(0, -1)) * 3_600;
}

export interface CatalogRecord {
  settings: ProductCatalogSettingsValues;
  /** Each row's own values, for a catalog made from pools (024). */
  rows?: readonly ProductCatalogRowValues[];
  sourceLink: string;
  videoLink: string;
  productCount: number;
}

const ID_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'contentId');
const VIDEO_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(
  column => column.source.kind === 'videoLink'
);

/**
 * The sheet as it should read after this update.
 *
 * Everything the catalog holds, written again with content IDs made now (024, US21): IDs used to be the
 * row number plus a growing offset, which came back to 1 as soon as a catalog was re-created, and
 * Meta remembered what it had rejected under those IDs. `buildProductCatalogRows` mints a fresh
 * one per row on every write. When `videoLinkOverride` is given, every row points at the
 * re-stitched copy instead, still distinct per row.
 */
export function rebuildCatalogRows(input: {
  record: CatalogRecord;
  videoLinkOverride?: string | null;
  newId?: () => string;
}): Cell[][] {
  return buildProductCatalogRows({
    settings: input.record.settings,
    sourceLink: input.record.sourceLink,
    videoLink: input.videoLinkOverride ?? input.record.videoLink,
    count: input.record.productCount,
    rows: input.record.rows,
    newId: input.newId
  });
}

export const CATALOG_UPDATER_COLUMNS = { id: ID_COLUMN, video: VIDEO_COLUMN } as const;

/** Back-off after a failed update: 1, 5, 15 minutes, then every 15 minutes. */
export function retryDelaySeconds(attempts: number): number {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 300;
  return 900;
}
