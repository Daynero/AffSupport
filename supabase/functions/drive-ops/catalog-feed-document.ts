import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';
import {
  CATALOG_FEED_ID,
  catalogFeedKey,
  newCatalogFeedId,
  writeCatalogFeed,
  type CatalogFeedStore
} from '../_shared/catalog-feed.ts';
import type { CatalogDocumentWriter } from './product-catalog.ts';

/**
 * 057: the feed id of one catalog operation: 128 bits of SHA-256 over a fixed label and the
 * operation's id. Stable across a resumed creation and not the operation id itself.
 */
export async function catalogFeedIdFor(operationId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`soty.catalog.feed:${operationId}`)
  );
  return Array.from(new Uint8Array(digest).subarray(0, 16), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * 057 (FR-050): the document writer of an R2 space. The catalog's rows go to its feed, under a
 * new stable id, and the feed's address is what the catalog record keeps as `sheet_url`. The
 * catalog's material is committed by `commit` (an R2 companion row without an object: the
 * feed lives in the public bucket, its bytes counted under `catalogs`).
 *
 * The write is the operation's own: its id is the marker the feed carries, as the sheet
 * carried `sotyCatalogAttempt`. A failed commit removes the feed it just wrote.
 */
export function createCatalogFeedDocumentWriter(deps: {
  store: CatalogFeedStore;
  signal: AbortSignal;
  /**
   * The feed's id for this operation. A resumed creation repeats the same operation, so a
   * writer that derives the id from it (`catalogFeedIdFor`) rewrites one feed instead of leaving
   * a second one behind; without it every write gets a fresh id.
   */
  newFeedId?: (operationId: string) => string | Promise<string>;
  commit(input: {
    operationId: string;
    actorId: string;
    name: string;
    feedId: string;
    feedUrl: string;
    bytes: number;
  }): Promise<{ materialId: string }>;
  log(message: string, detail: string): void;
}): CatalogDocumentWriter {
  return {
    async write({ name, rows, authority, actorId }) {
      const feedId = deps.newFeedId
        ? await deps.newFeedId(authority.operationId)
        : newCatalogFeedId();
      if (!CATALOG_FEED_ID.test(feedId)) throw new TeamFunctionError('INVALID_RESPONSE');
      const written = await writeCatalogFeed(
        deps.store,
        { feedId, rows, marker: authority.operationId },
        deps.signal,
        deps.log
      );
      const remove = async (why: string) => {
        try {
          await deps.store.removeFeed(catalogFeedKey(feedId), deps.signal);
        } catch (error) {
          deps.log(`[catalog-feed] ${why}: feed stayed`, mapUnknownError(error).code);
        }
      };
      if (!/^https:\/\/[^\s]+$/u.test(written.url)) {
        await remove('rolled back');
        throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
      }
      let committed: { materialId: string };
      try {
        committed = await deps.commit({
          operationId: authority.operationId,
          actorId,
          name,
          feedId,
          feedUrl: written.url,
          bytes: written.bytes
        });
      } catch (error) {
        await remove('rolled back');
        throw error;
      }
      return {
        name,
        sheetUrl: written.url,
        materialId: committed.materialId,
        record: { feedId, feedBytes: written.bytes },
        discard: why => remove(why),
        // A retired catalog of an R2 space keeps no Drive file; its feed leaves with its row.
        retire: async () => undefined
      };
    }
  };
}
