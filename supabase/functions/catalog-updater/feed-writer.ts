// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import { isCatalogVideoR2PublicUrl } from '../../../packages/shared/dist/team/catalog-video-r2.js';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import {
  catalogFeedKey,
  parseCatalogFeedCsv,
  writeCatalogFeed,
  type CatalogFeedStore
} from '../_shared/catalog-feed.ts';
import { CATALOG_IMAGE_COLUMN, catalogVideoColumnIndices } from '../_shared/catalog-updater.ts';
import { PRODUCT_CATALOG_TEMPLATE, type Cell } from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';
import type { CatalogNonVideoUpdate, ClaimedCatalog } from './worker.ts';

/**
 * 057 T039: how the updater writes a catalog of an R2 space. The round has already rebuilt the
 * rows (`rebuildCatalogRows`) exactly as for a sheet; here they become the whole feed again,
 * under the catalog's stable key, and the write is recorded (`service_record_catalog_feed`:
 * revision, bytes in the space ledger under `catalogs`).
 *
 * A non-video round (the publication owns the video links) keeps the links the feed holds now:
 * they are read back from the feed itself — Soty's own output, the record of what was published
 * — and handed to the rebuild as the preserved cells, as the sheet's column was. Sheets quota,
 * Drive versions and Drive files play no part.
 */
export interface CatalogFeedUpdater {
  prepareNonVideoUpdate(item: ClaimedCatalog): Promise<CatalogNonVideoUpdate>;
  /**
   * 057 T098: the video cells of a catalog of re-stitched variations (null for any other feed).
   * Its rows keep the variation each one links now — read back from the feed — and rows this
   * round adds take the variations in turn; one link over every row would undo the variations.
   */
  variantCells?(item: ClaimedCatalog, count: number): Promise<string[] | null>;
  write(item: ClaimedCatalog, rows: Cell[][], marker: string): Promise<void>;
  verify(item: ClaimedCatalog, marker: string): Promise<void>;
}

const uncertain = () => new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });

function feedOf(item: ClaimedCatalog) {
  if (!item.feed) throw new TeamFunctionError('INVALID_INPUT');
  return item.feed;
}

/** The feed's cells, checked to be the template's and the claimed catalog's. */
export async function readCatalogFeedCells(
  store: CatalogFeedStore,
  feedId: string,
  signal: AbortSignal
): Promise<string[][]> {
  const held = await store.readFeed(catalogFeedKey(feedId), signal);
  if (!held) throw uncertain();
  const rows = parseCatalogFeedCsv(new TextDecoder('utf-8', { fatal: true }).decode(held.bytes));
  if (
    rows.length < 3 ||
    rows.some(row => row.length !== PRODUCT_CATALOG_TEMPLATE.length) ||
    PRODUCT_CATALOG_TEMPLATE.some(
      (column, index) => rows[0]![index] !== column.description || rows[1]![index] !== column.key
    )
  )
    throw uncertain();
  return rows;
}

export function createCatalogFeedUpdater(deps: {
  store: CatalogFeedStore;
  service: ServiceRpcClient;
  workerId: string;
  signal: AbortSignal;
  log(message: string, detail: string): void;
}): CatalogFeedUpdater {
  const updater: CatalogFeedUpdater = {
    async prepareNonVideoUpdate(item) {
      const feed = feedOf(item);
      const result = await deps.service.rpc('service_prepare_catalog_nonvideo_update_context', {
        p_item: item.catalogId,
        p_worker: deps.workerId
      });
      if (result.error || !isRecord(result.data))
        throw new TeamFunctionError('CATALOG_PUBLICATION_PENDING', { retryable: false });
      const c = result.data;
      if (
        typeof c.contextToken !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(c.contextToken) ||
        c.currentProductCount !== item.productCount ||
        typeof c.productCount !== 'number' ||
        !Number.isSafeInteger(c.productCount) ||
        c.productCount < item.productCount ||
        c.productCount > 400
      )
        throw uncertain();
      const productCount = c.productCount;
      const rows = await readCatalogFeedCells(deps.store, feed.feedId, deps.signal);
      if (rows.length !== item.productCount + 2) throw uncertain();
      const kind = item.creatives?.kind === 'image' ? 'image' : 'video';
      // Rows this round adds have no published link yet.
      const column = (index: number) => [
        ...rows.slice(2).map(row => row[index]!),
        ...Array.from({ length: productCount - item.productCount }, () => '')
      ];
      return {
        contextToken: c.contextToken,
        productCount,
        videoCells: column(catalogVideoColumnIndices()[0]!),
        ...(kind === 'image' ? { imageCells: column(CATALOG_IMAGE_COLUMN) } : {}),
        ...(Array.isArray(c.recipeRowIds) ? { recipeRowIds: c.recipeRowIds as string[] } : {}),
        write: (built, marker) => updater.write(item, built, marker),
        verify: marker => updater.verify(item, marker)
      };
    },

    async variantCells(item, count) {
      const feed = feedOf(item);
      const result = await deps.service.rpc('service_space_catalog_variant_links', {
        p_catalog: item.catalogId
      });
      if (result.error) throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: true });
      if (result.data === null) return null;
      const links = result.data;
      if (
        !Array.isArray(links) ||
        links.length < 1 ||
        links.some(link => !isCatalogVideoR2PublicUrl(link))
      )
        throw uncertain();
      const rows = await readCatalogFeedCells(deps.store, feed.feedId, deps.signal);
      if (rows.length !== item.productCount + 2 || count < item.productCount) throw uncertain();
      const column = catalogVideoColumnIndices()[0]!;
      const kept = rows.slice(2).map(row => row[column]!);
      return Array.from({ length: count }, (_, index) =>
        index < kept.length ? kept[index]! : (links[index % links.length] as string)
      );
    },

    async write(item, rows, marker) {
      const feed = feedOf(item);
      const written = await writeCatalogFeed(
        deps.store,
        { feedId: feed.feedId, rows, marker },
        deps.signal,
        deps.log
      );
      const { error } = await deps.service.rpc('service_record_catalog_feed', {
        p_catalog: item.catalogId,
        p_feed_id: feed.feedId,
        p_bytes: written.bytes,
        p_expected_revision: feed.revision
      });
      // The feed is written; a lost record is the round's unknown result, not a retry of it.
      if (error) throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: true });
    },

    async verify(item, marker) {
      const held = await deps.store.readFeed(catalogFeedKey(feedOf(item).feedId), deps.signal);
      if (!held || held.marker !== marker)
        throw new TeamFunctionError('DELIVERY_UNAVAILABLE', { retryable: true });
    }
  };
  return updater;
}

/**
 * 057 (publication-cells.ts for a feed): a video publication writes its links into the feed's
 * video column (H for an image catalog), product by product through the frozen ID→URL recipe,
 * and rewrites the feed whole under its own marker. The receipt rules are the sheet's: a marker
 * other than this fence's predecessor is reconciliation territory, never another write.
 *
 * The ledger keeps the bytes of the last full write: a publication changes a feed by the length
 * of its links only, and the next round records it again.
 */
export interface FeedPublicationCells {
  readonly feedId: string;
  readonly idColumn: number;
  readonly videoColumn: number;
  readonly idHeaders: readonly [string, string];
  readonly videoHeaders: readonly [string, string];
  readonly products: readonly { readonly id: string; readonly url: string }[];
  readonly markerValue: string;
  readonly previousMarker?: string;
}

const changed = () => new TeamFunctionError('SOURCE_CHANGED');

async function observeFeed(
  store: CatalogFeedStore,
  frozen: FeedPublicationCells,
  signal: AbortSignal
) {
  const held = await store.readFeed(catalogFeedKey(frozen.feedId), signal);
  if (!held) throw changed();
  const rows = parseCatalogFeedCsv(new TextDecoder('utf-8', { fatal: true }).decode(held.bytes));
  const width = Math.max(frozen.idColumn, frozen.videoColumn);
  if (
    rows.length !== frozen.products.length + 2 ||
    rows.some(row => row.length <= width) ||
    rows[0]![frozen.idColumn] !== frozen.idHeaders[0] ||
    rows[1]![frozen.idColumn] !== frozen.idHeaders[1] ||
    rows[0]![frozen.videoColumn] !== frozen.videoHeaders[0] ||
    rows[1]![frozen.videoColumn] !== frozen.videoHeaders[1]
  )
    throw changed();
  const recipe = new Map(frozen.products.map(product => [product.id, product.url]));
  const ids = rows.slice(2).map(row => row[frozen.idColumn]!);
  if (new Set(ids).size !== frozen.products.length || ids.some(id => !recipe.has(id)))
    throw changed();
  return { rows, held, links: ids.map(id => recipe.get(id)!) };
}

export async function applyFeedPublicationCells(
  store: CatalogFeedStore,
  frozen: FeedPublicationCells,
  signal: AbortSignal,
  log: (message: string, detail: string) => void = () => undefined
): Promise<void> {
  const current = await observeFeed(store, frozen, signal);
  if ((current.held.marker ?? undefined) !== frozen.previousMarker)
    throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
  const rows: Cell[][] = current.rows.map((row, index) =>
    row.map((value, column) => ({
      t: 'string' as const,
      v: index >= 2 && column === frozen.videoColumn ? current.links[index - 2]! : value
    }))
  );
  await writeCatalogFeed(
    store,
    { feedId: frozen.feedId, rows, marker: frozen.markerValue },
    signal,
    log
  );
}

export async function verifyFeedPublicationCells(
  store: CatalogFeedStore,
  frozen: FeedPublicationCells,
  signal: AbortSignal
): Promise<
  | { outcome: 'verified'; providerRevision: string; verifiedAt: string }
  | { outcome: 'unknown'; reason?: 'SOURCE_CHANGED' }
  | { outcome: 'absent' }
> {
  try {
    const current = await observeFeed(store, frozen, signal);
    const marker = current.held.marker ?? undefined;
    if (marker === frozen.previousMarker) return { outcome: 'absent' };
    if (marker !== frozen.markerValue) return { outcome: 'unknown' };
    if (
      current.rows.slice(2).some((row, index) => row[frozen.videoColumn] !== current.links[index])
    )
      return { outcome: 'unknown' };
    return {
      outcome: 'verified',
      providerRevision: current.held.etag || frozen.markerValue,
      verifiedAt: new Date().toISOString()
    };
  } catch (cause) {
    return cause instanceof TeamFunctionError && cause.code === 'SOURCE_CHANGED'
      ? { outcome: 'unknown', reason: 'SOURCE_CHANGED' }
      : { outcome: 'unknown' };
  }
}
