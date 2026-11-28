import { TeamFunctionError, mapUnknownError } from '../_shared/errors.ts';
import {
  catalogFeedKey,
  newCatalogFeedId,
  writeCatalogFeed,
  type CatalogFeedStore
} from '../_shared/catalog-feed.ts';
import type { CatalogDocumentWriter } from './product-catalog.ts';

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
  newFeedId?: () => string;
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
      const feedId = (deps.newFeedId ?? newCatalogFeedId)();
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
