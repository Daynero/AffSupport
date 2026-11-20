/**
 * The catalog updater's rules (feature 023) — nothing here does I/O.
 *
 * A catalog sheet made by 022 is rewritten in place on every round: the same cells, with every
 * product ID moved on by the owner's rule, and — once a re-stitched copy is ready — every video
 * link pointing at it. The rows are rebuilt from what the catalog was made from, never read back
 * from the sheet, so a retried update writes exactly the same thing and a hand edit is overwritten.
 */

import { TeamFunctionError } from './errors.ts';
import {
  PRODUCT_CATALOG_TEMPLATE,
  buildProductCatalogRows,
  catalogCreativeCells,
  type CatalogCreativeKind,
  type CatalogCreativeLayout,
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
  randomLinkVariation?: boolean;
  settings: ProductCatalogSettingsValues;
  /** Each row's own values, for a catalog made from pools (024). */
  rows?: readonly ProductCatalogRowValues[];
  sourceLink: string;
  videoLink: string;
  productCount: number;
  /** 062: the catalog's creatives from its snapshot; absent for a catalog from before (no prefix). */
  creatives?: CatalogCreativeLayout;
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
  /** Exact stored video cells from a bounded provider read, including proven blanks. */
  preservedVideoCells?: readonly string[];
  /** 062: exact stored H cells of an image catalog; only the publication lane writes them. */
  preservedImageCells?: readonly string[];
}): Cell[][] {
  const count = input.record.productCount;
  for (const preserved of [input.preservedVideoCells, input.preservedImageCells])
    if (
      preserved &&
      (preserved.length !== count || preserved.some(v => typeof v !== 'string' || v.length > 8192))
    )
      throw new TeamFunctionError('INVALID_INPUT');
  const layout = input.record.creatives;
  if (layout && layout.rowCreatives.length !== count) throw new TeamFunctionError('INVALID_INPUT');
  const rows = buildProductCatalogRows({
    settings: input.record.settings,
    sourceLink: input.record.sourceLink,
    videoLink: input.videoLinkOverride ?? input.record.videoLink,
    count,
    randomLinkVariation: input.record.randomLinkVariation,
    rows: input.record.rows,
    newId: input.newId,
    ...(layout
      ? {
          // A video override belongs to a single-video catalog; the creative's own link is
          // the base only when nothing replaces it. H of an image catalog is never rebuilt.
          creatives: catalogCreativeCells(layout).map(cells =>
            input.videoLinkOverride ? { ...cells, videoLink: null } : cells
          ),
          rowCreatives: layout.rowCreatives
        }
      : {})
  });
  if (input.preservedVideoCells)
    for (let index = 0; index < count; index++)
      for (const column of catalogVideoColumnIndices())
        rows[index + 2]![column] = { t: 'string', v: input.preservedVideoCells[index]! };
  if (input.preservedImageCells)
    for (let index = 0; index < count; index++)
      rows[index + 2]![CATALOG_IMAGE_COLUMN] = {
        t: 'string',
        v: input.preservedImageCells[index]!
      };
  return rows;
}

/** H, `image_link`: the picture cell an image catalog's publication lane owns (062, R30). */
export const CATALOG_IMAGE_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(
  column => column.source.kind === 'setting' && column.source.setting === 'imageLink'
);

/** Columns a targeted nonvideo writer must not touch: video cells, and H for an image catalog. */
export function catalogPreservedColumnIndices(kind: CatalogCreativeKind = 'video'): number[] {
  const video = catalogVideoColumnIndices();
  return kind === 'image' ? [...video, CATALOG_IMAGE_COLUMN].sort((a, b) => a - b) : video;
}

/** Includes copied video columns; a targeted nonvideo writer must exclude the
 * complete dependency closure, not just the first video URL column. */
export function catalogVideoColumnIndices(): number[] {
  const names = new Set<string>();
  for (let pass = 0; pass < PRODUCT_CATALOG_TEMPLATE.length; pass++)
    for (const column of PRODUCT_CATALOG_TEMPLATE) {
      if (
        column.source.kind === 'videoLink' ||
        (column.source.kind === 'copyOf' && names.has(column.source.column))
      )
        names.add(column.column);
    }
  return PRODUCT_CATALOG_TEMPLATE.flatMap((column, index) =>
    names.has(column.column) ? [index] : []
  );
}

/** Never includes video cells, even empty ones. Values are explicit strings in
 * the native Sheets adapter, so refreshed user text cannot become a formula. */
export function catalogNonVideoCellUpdates(
  rows: readonly (readonly Cell[])[],
  sheetId: number,
  kind: CatalogCreativeKind = 'video'
) {
  if (
    !Number.isSafeInteger(sheetId) ||
    sheetId < 0 ||
    rows.length < 3 ||
    rows.length > 402 ||
    rows.some(row => row.length !== PRODUCT_CATALOG_TEMPLATE.length)
  )
    throw new TeamFunctionError('INVALID_INPUT');
  const excluded = new Set(catalogPreservedColumnIndices(kind));
  return PRODUCT_CATALOG_TEMPLATE.flatMap((_, columnIndex) =>
    excluded.has(columnIndex)
      ? []
      : [
          {
            sheetId,
            rowIndex: 0,
            columnIndex,
            values: rows.map(row => String(row[columnIndex]!.v))
          }
        ]
  );
}

export const CATALOG_UPDATER_COLUMNS = { id: ID_COLUMN, video: VIDEO_COLUMN } as const;

/** Back-off after a failed update: 1, 5, 15 minutes, then every 15 minutes. */
export function retryDelaySeconds(attempts: number): number {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 300;
  return 900;
}
