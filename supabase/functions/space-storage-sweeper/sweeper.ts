/**
 * The sweeper of R2 spaces (057 T059, US10, FR-048, FR-049, SC-014, SC-016; research.md R10).
 *
 * Woken every minute by pg_cron (`route: 'sweep'`), once a day for reconciliation
 * (`route: 'reconcile'`), and at once by a removal (20261226380000). Every queue it works is
 * leased and fenced in the database, so two invocations never delete the same key twice and a
 * lost reply is claimed again later. Order matters: the catalogs first (their public addresses
 * owe a 404 within a minute), then the space's own queues.
 *
 * Pure: the database, the space bucket and the catalog store are injected, so the tests run it
 * against fakes. No key, URL or provider payload is returned — the summary is counts and codes.
 */
import { TeamFunctionError } from '../_shared/errors.ts';
import { catalogFeedKey, CATALOG_FEED_ID } from '../_shared/catalog-feed.ts';
import type { SpaceListedObject } from '../_shared/r2-space.ts';

export type SweeperRoute = 'sweep' | 'reconcile';

export interface SweeperSpaceBucket {
  remove(key: string, signal: AbortSignal): Promise<void>;
  head(key: string, signal: AbortSignal): Promise<{ etag: string } | null>;
  abortMultipart(key: string, uploadId: string, signal: AbortSignal): Promise<void>;
  listPrefix(
    prefix: string,
    continuationToken: string | null,
    signal: AbortSignal,
    startAfter?: string | null
  ): Promise<{ objects: SpaceListedObject[]; foreignKeys: number; nextToken: string | null }>;
}

export interface SweeperCatalogStore {
  publicUrl(key: string): string;
  feedUrl(key: string): string;
  deletePublicObject(key: string, signal: AbortSignal): Promise<void>;
  deleteFeedObject(key: string, signal: AbortSignal): Promise<void>;
  purgeUrls(urls: readonly string[], signal: AbortSignal): Promise<boolean>;
}

export interface SpaceStorageSweeperDeps {
  /** Calls a service RPC; throws a `TeamFunctionError` on a database error. */
  rpc(name: string, parameters: Record<string, unknown>): Promise<unknown>;
  /** Null until the space bucket is configured: then only the database-only steps run. */
  space: SweeperSpaceBucket | null;
  /** Null when the catalog video store is not configured: 050's own sweep stays the only one. */
  catalog: SweeperCatalogStore | null;
  route: SweeperRoute;
  worker: string;
  budgetMs?: number;
  now?: () => number;
  /** Bucket calls in flight at once. */
  parallel?: number;
}

export interface SpaceStorageSweepSummary {
  route: SweeperRoute;
  catalog: { copies: number; feeds: number; purgedUrls: number; failed: number };
  trashExpired: number;
  uploadsExpired: number;
  reservationsReleased: number;
  purged: number;
  purgeFailed: number;
  spaces: { deletedObjects: number; emptied: number; foreignKeys: number };
  reconciliation: {
    started: number;
    pages: number;
    orphansDeleted: number;
    missing: number;
    failed: number;
  };
  skipped: string[];
  errors: string[];
}

/** The zone purge API takes at most 30 files a call. */
export const PURGE_BATCH = 30;
const DEFAULT_BUDGET_MS = 45_000;
const ROUNDS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function invalid(): never {
  throw new TeamFunctionError('INVALID_RESPONSE');
}

function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) invalid();
  return value;
}

function uuid(value: unknown): string {
  return typeof value === 'string' && UUID.test(value) ? value : invalid();
}

function text(value: unknown, max = 1024): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : invalid();
}

function integer(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : invalid();
}

const codeOf = (error: unknown): string =>
  error instanceof TeamFunctionError ? error.code : 'STORAGE_UNAVAILABLE';

/** Runs `work` over `items`, `limit` at a time; never rejects (each result is its own). */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

export async function runSpaceStorageSweeper(
  deps: SpaceStorageSweeperDeps,
  signal: AbortSignal = new AbortController().signal
): Promise<SpaceStorageSweepSummary> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const open = () => !signal.aborted && now() < deadline;
  const parallel = deps.parallel ?? 8;
  const summary: SpaceStorageSweepSummary = {
    route: deps.route,
    catalog: { copies: 0, feeds: 0, purgedUrls: 0, failed: 0 },
    trashExpired: 0,
    uploadsExpired: 0,
    reservationsReleased: 0,
    purged: 0,
    purgeFailed: 0,
    spaces: { deletedObjects: 0, emptied: 0, foreignKeys: 0 },
    reconciliation: { started: 0, pages: 0, orphansDeleted: 0, missing: 0, failed: 0 },
    skipped: [],
    errors: []
  };
  const step = async (name: string, work: () => Promise<void>) => {
    if (!open()) return;
    try {
      await work();
    } catch (error) {
      summary.errors.push(`${name}:${codeOf(error)}`);
    }
  };

  // 1. Catalogs: their addresses go first, in one zone purge per batch (SC-014).
  if (deps.catalog) {
    const catalog = deps.catalog;
    await step('catalog', async () => {
      for (let round = 0; round < ROUNDS && open(); round += 1) {
        const copies = list(
          await deps.rpc('service_space_catalog_claim_retire', {
            p_worker: deps.worker,
            p_limit: PURGE_BATCH
          })
        ).map(row => ({
          copyId: uuid(row.copyId),
          fence: integer(row.fence),
          key: text(row.objectKey, 64)
        }));
        const feeds = list(
          await deps.rpc('service_space_catalog_claim_feed_removals', {
            p_worker: deps.worker,
            p_limit: PURGE_BATCH
          })
        ).map(row => {
          const feedId = text(row.feedId, 32);
          if (!CATALOG_FEED_ID.test(feedId)) invalid();
          return { feedId, fence: integer(row.fence) };
        });
        if (copies.length === 0 && feeds.length === 0) break;
        await catalogBatch(deps, catalog, copies, feeds, parallel, signal, summary);
      }
    });
  } else summary.skipped.push('catalog');

  // 2. Database-only: thirty days of trash, uploads past their time.
  await step('trash', async () => {
    summary.trashExpired += integer(await deps.rpc('service_expire_space_trash', { p_limit: 200 }));
  });
  await step('uploads', async () => {
    summary.uploadsExpired += integer(
      await deps.rpc('service_expire_space_uploads', { p_limit: 200 })
    );
  });

  const space = deps.space;
  if (!space) {
    summary.skipped.push('space');
    return summary;
  }

  // 3. Reservations waiting for their multipart: abort it, then give the room back.
  await step('reservations', async () => {
    const uploads = list(await deps.rpc('service_claim_space_uncertain_uploads', { p_limit: 50 }));
    await pool(uploads, parallel, async row => {
      const uploadId = uuid(row.uploadId);
      let closed = row.r2UploadId === null || row.r2UploadId === undefined;
      if (!closed) {
        try {
          await space.abortMultipart(text(row.key), text(row.r2UploadId), signal);
          closed = true;
        } catch {
          // The bucket's lifecycle rule aborts it after a day; the database knows when.
          closed = row.lifecycleAborted === true;
        }
      }
      if (
        (await deps.rpc('service_settle_space_uncertain_upload', {
          p_upload: uploadId,
          p_closed: closed
        })) === true
      )
        summary.reservationsReleased += 1;
    });
  });

  // 4. The purge queue: the bytes nothing refers to any more (≤15 min, SC-014).
  await step('purge', async () => {
    for (let round = 0; round < ROUNDS && open(); round += 1) {
      const due = list(
        await deps.rpc('service_claim_space_object_purges', { p_worker: deps.worker, p_limit: 50 })
      ).map(row => ({
        objectId: uuid(row.objectId),
        fence: integer(row.fence),
        key: text(row.key)
      }));
      if (due.length === 0) break;
      await pool(due, parallel, async item => {
        try {
          await space.remove(item.key, signal);
        } catch (error) {
          summary.purgeFailed += 1;
          await deps
            .rpc('service_finish_space_object_purge', {
              p_object: item.objectId,
              p_fence: item.fence,
              p_success: false,
              p_code: codeOf(error)
            })
            .catch(() => undefined);
          return;
        }
        await deps.rpc('service_finish_space_object_purge', {
          p_object: item.objectId,
          p_fence: item.fence,
          p_success: true,
          p_code: null
        });
        summary.purged += 1;
      });
    }
  });

  // 5. Deleted spaces: everything under their prefix goes (SC-016).
  await step('spaces', async () => {
    for (let round = 0; round < 3 && open(); round += 1) {
      const claim = await deps.rpc('service_claim_space_removed_space', { p_worker: deps.worker });
      if (claim === null) break;
      if (!isRecord(claim)) invalid();
      const teamId = uuid(claim.teamId);
      const fence = integer(claim.fence);
      let deleted = 0;
      let empty = false;
      let code: string | null = null;
      try {
        while (open()) {
          const page = await space.listPrefix(`t/${teamId}/`, null, signal);
          summary.spaces.foreignKeys += page.foreignKeys;
          if (page.objects.length === 0) {
            empty = page.nextToken === null;
            break;
          }
          const results = await pool(page.objects, parallel, object =>
            space.remove(object.key, signal)
          );
          const failed = results.find(result => result.status === 'rejected');
          deleted += results.filter(result => result.status === 'fulfilled').length;
          if (failed) {
            code = codeOf((failed as PromiseRejectedResult).reason);
            break;
          }
        }
      } catch (error) {
        code = codeOf(error);
      }
      summary.spaces.deletedObjects += deleted;
      if (empty) summary.spaces.emptied += 1;
      await deps.rpc('service_finish_space_removed_space', {
        p_team: teamId,
        p_fence: fence,
        p_deleted: deleted,
        p_empty: empty,
        p_code: code
      });
    }
  });

  // 6. Reconciliation: started once a day, carried page by page by every sweep (FR-049).
  if (deps.route === 'reconcile')
    await step('reconcile-start', async () => {
      summary.reconciliation.started += integer(
        await deps.rpc('service_start_space_reconciliations', {})
      );
    });
  await step('reconcile', async () => {
    for (let round = 0; round < 3 && open(); round += 1) {
      const claim = await deps.rpc('service_claim_space_reconciliation', {
        p_worker: deps.worker
      });
      if (claim === null) break;
      if (!isRecord(claim)) invalid();
      await reconcile(
        deps,
        space,
        {
          id: uuid(claim.reconciliationId),
          teamId: uuid(claim.teamId),
          fence: integer(claim.fence),
          lastKey: claim.lastKey === null ? null : text(claim.lastKey)
        },
        open,
        parallel,
        signal,
        summary
      );
    }
  });
  return summary;
}

async function catalogBatch(
  deps: SpaceStorageSweeperDeps,
  catalog: SweeperCatalogStore,
  copies: { copyId: string; fence: number; key: string }[],
  feeds: { feedId: string; fence: number }[],
  parallel: number,
  signal: AbortSignal,
  summary: SpaceStorageSweepSummary
): Promise<void> {
  const finishCopy = (copy: (typeof copies)[number], code: string | null) =>
    deps
      .rpc('service_catalog_video_r2_mark_deleted', {
        p_copy: copy.copyId,
        p_worker: deps.worker,
        p_fence: copy.fence,
        p_success: code === null,
        p_code: code
      })
      .catch(() => undefined);
  const finishFeed = (feed: (typeof feeds)[number], code: string | null) =>
    deps
      .rpc('service_catalog_feed_finish_removal', {
        p_feed_id: feed.feedId,
        p_fence: feed.fence,
        p_success: code === null,
        p_code: code
      })
      .catch(() => undefined);

  // The objects first: a purge of an address whose object is still there would be refilled.
  const copyResults = await pool(copies, parallel, copy =>
    catalog.deletePublicObject(copy.key, signal)
  );
  const feedResults = await pool(feeds, parallel, feed =>
    catalog.deleteFeedObject(catalogFeedKey(feed.feedId), signal)
  );
  const gone: { url: string; finish: (code: string | null) => Promise<unknown> }[] = [];
  copies.forEach((copy, index) => {
    const result = copyResults[index]!;
    if (result.status === 'fulfilled')
      gone.push({ url: catalog.publicUrl(copy.key), finish: code => finishCopy(copy, code) });
    else {
      summary.catalog.failed += 1;
      void finishCopy(copy, codeOf(result.reason));
    }
  });
  feeds.forEach((feed, index) => {
    const result = feedResults[index]!;
    if (result.status === 'fulfilled')
      gone.push({
        url: catalog.feedUrl(catalogFeedKey(feed.feedId)),
        finish: code => finishFeed(feed, code)
      });
    else {
      summary.catalog.failed += 1;
      void finishFeed(feed, codeOf(result.reason));
    }
  });

  // Every unique address, at most thirty a call. Only a confirmed purge finishes an item: a
  // failed one is claimed again and purged again.
  const unique = [...new Map(gone.map(item => [item.url, item])).values()];
  for (let start = 0; start < unique.length; start += PURGE_BATCH) {
    const batch = unique.slice(start, start + PURGE_BATCH);
    const purged = await catalog
      .purgeUrls(
        batch.map(item => item.url),
        signal
      )
      .catch(() => false);
    const code = purged ? null : 'VIDEO_R2_CLEANUP_PARTIAL';
    if (purged) summary.catalog.purgedUrls += batch.length;
    else summary.catalog.failed += batch.length;
    await Promise.all(
      gone.filter(item => batch.some(b => b.url === item.url)).map(item => item.finish(code))
    );
  }
  summary.catalog.copies += copies.length - copyResults.filter(r => r.status === 'rejected').length;
  summary.catalog.feeds += feeds.length - feedResults.filter(r => r.status === 'rejected').length;
}

async function reconcile(
  deps: SpaceStorageSweeperDeps,
  space: SweeperSpaceBucket,
  run: { id: string; teamId: string; fence: number; lastKey: string | null },
  open: () => boolean,
  parallel: number,
  signal: AbortSignal,
  summary: SpaceStorageSweepSummary
): Promise<void> {
  const prefix = `t/${run.teamId}/`;
  let startAfter = run.lastKey;
  let token: string | null = null;
  while (open()) {
    let page: Awaited<ReturnType<SweeperSpaceBucket['listPrefix']>>;
    try {
      page = await space.listPrefix(prefix, token, signal, token ? null : startAfter);
    } catch (error) {
      summary.reconciliation.failed += 1;
      await deps.rpc('service_space_reconcile_failed', {
        p_reconciliation: run.id,
        p_fence: run.fence,
        p_code: codeOf(error)
      });
      return;
    }
    const final = page.nextToken === null;
    const answer = await deps.rpc('service_space_reconcile_page', {
      p_reconciliation: run.id,
      p_fence: run.fence,
      p_objects: page.objects.map(object => ({
        key: object.key,
        etag: object.etag,
        lastModified: object.lastModified ?? null
      })),
      p_foreign: page.foreignKeys,
      p_final: final
    });
    if (!isRecord(answer)) invalid();
    summary.reconciliation.pages += 1;
    summary.reconciliation.missing += integer(answer.missing);
    const orphans = list(answer.orphans).map(row => ({
      key: text(row.key),
      etag: text(row.etag, 255)
    }));
    if (orphans.length > 0) {
      // Deleted only while it is still the object that was listed (a new upload of the same
      // content would carry a new ETag).
      const results = await pool(orphans, parallel, async orphan => {
        const head = await space.head(orphan.key, signal);
        if (!head) return false;
        if (head.etag !== orphan.etag) return false;
        await space.remove(orphan.key, signal);
        return true;
      });
      const deleted = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
      const failed = results.find(r => r.status === 'rejected') as
        PromiseRejectedResult | undefined;
      summary.reconciliation.orphansDeleted += deleted;
      await deps.rpc('service_space_reconcile_orphans_deleted', {
        p_reconciliation: run.id,
        p_fence: run.fence,
        p_deleted: deleted,
        p_code: failed ? codeOf(failed.reason) : null
      });
    }
    if (final) return;
    token = page.nextToken;
    startAfter = page.objects.at(-1)?.key ?? startAfter;
  }
}

/** The HTTP edge of the sweeper: POST `{route}` with the scheduler's named secret only. */
export async function handleSpaceStorageSweeperRequest(
  request: Request,
  deps: {
    authorize(request: Request): Promise<void>;
    run(route: SweeperRoute): Promise<SpaceStorageSweepSummary>;
  }
): Promise<Response> {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  try {
    if (request.method !== 'POST') throw new TeamFunctionError('INVALID_INPUT');
    await deps.authorize(request);
    const body: unknown = await request.json().catch(() => null);
    const route = isRecord(body) ? body.route : null;
    if (route !== 'sweep' && route !== 'reconcile') throw new TeamFunctionError('INVALID_INPUT');
    return respond(200, { ok: true, value: await deps.run(route) });
  } catch (error) {
    const failure =
      error instanceof TeamFunctionError
        ? error
        : new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
    return respond(failure.status, {
      ok: false,
      error: { code: failure.code, retryable: failure.retryable }
    });
  }
}
