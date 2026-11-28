/**
 * 057 T102 (research.md R15 «Відкладена публікація»): the publication lane of the catalogs of R2
 * spaces — a video link published later is written into the catalog's feed.
 *
 * The lane is the Drive one (catalog_video_publication_*): the same scheduler tick, reserve,
 * dispatch and settle, the same manager actions. What differs is the claim and the writer:
 *
 * - `service_claim_space_catalog_publication_jobs` takes the due jobs of R2 catalogs (the Drive
 *   claim asks for a Drive connection, which a feed has not);
 * - the context (`service_space_catalog_publication_context`) names the feed and the public R2
 *   copy of the video — or of each re-stitched variation bound to the catalog, with the creation's
 *   plan — and waits while a copy is not ready yet;
 * - the write is `applyFeedPublicationCells` under the job's fence: the feed is rewritten with each
 *   row's address in the video column and nothing else changed; `verifyFeedPublicationCells` reads
 *   it back. There is no sheet to prove, no Drive sharing and no baseline check: the feed is Soty's
 *   own file. A write the feed does not hold any more is `absent`, and the server requeues it.
 */
// @deno-types="../../../packages/shared/dist/team/catalog-video-set.d.ts"
import { createCatalogVideoAssignment } from '../../../packages/shared/dist/team/catalog-video-set.js';
// @deno-types="../../../packages/shared/dist/team/catalog-video-r2.d.ts"
import { isCatalogVideoR2PublicUrl } from '../../../packages/shared/dist/team/catalog-video-r2.js';
import {
  runCatalogPublicationTick,
  type CatalogPublicationTickResult
} from '../../../packages/shared/dist/team/catalog-publication-runner.js';
import {
  catalogFeedKey,
  parseCatalogFeedCsv,
  type CatalogFeedStore
} from '../_shared/catalog-feed.ts';
import { catalogVideoColumnIndices } from '../_shared/catalog-updater.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import { PRODUCT_CATALOG_TEMPLATE } from '../_shared/product-catalog.ts';
import { isRecord } from '../_shared/validation.ts';
import {
  applyFeedPublicationCells,
  verifyFeedPublicationCells,
  type FeedPublicationCells
} from './feed-writer.ts';
import {
  createCatalogPublicationAuthority,
  type CatalogPublicationIo
} from './publication-authority.ts';

interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** The claim of the jobs of R2 catalogs (20261226300000). */
export const SPACE_PUBLICATION_CLAIM = 'service_claim_space_catalog_publication_jobs';

const uncertain = () => new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
const ID_COLUMN = PRODUCT_CATALOG_TEMPLATE.findIndex(column => column.source.kind === 'contentId');

export interface SpacePublicationSource {
  materialId: string;
  url: string;
}

/**
 * Each row's address: one source for every row, or — for a catalog of variations — the
 * creation's seeded assignment over its recipe rows; a row added since takes them in turn.
 */
export function spacePublicationRowLinks(context: {
  productCount: number;
  sources: readonly SpacePublicationSource[];
  recipeRowIds?: readonly string[];
  assignmentSeed?: string;
}): string[] {
  const urls = context.sources.map(source => source.url);
  if (urls.length < 1 || urls.some(url => !isCatalogVideoR2PublicUrl(url))) throw uncertain();
  if (!context.recipeRowIds || !context.assignmentSeed) {
    if (urls.length !== 1) throw uncertain();
    return Array.from({ length: context.productCount }, () => urls[0]!);
  }
  const assignment = createCatalogVideoAssignment({
    recipeRevision: 1,
    recipeRowIds: [...context.recipeRowIds],
    variantCount: urls.length,
    seed: context.assignmentSeed
  });
  const byRow = new Map(
    assignment.assignments.map(row => [row.recipeRowId, row.videoVariantIndex])
  );
  return Array.from({ length: context.productCount }, (_, index) => {
    const row = context.recipeRowIds![index];
    const variant = row === undefined ? index % urls.length : byRow.get(row.toLowerCase());
    if (variant === undefined) throw uncertain();
    return urls[variant]!;
  });
}

interface SpaceContext {
  state: 'ready' | 'waiting' | 'blocked';
  feedId: string;
  productCount: number;
  sources: Array<SpacePublicationSource & { ready: boolean }>;
  recipeRowIds?: string[];
  assignmentSeed?: string;
}

function parseContext(value: unknown): SpaceContext {
  if (!isRecord(value) || !['ready', 'waiting', 'blocked'].includes(String(value.state)))
    throw uncertain();
  if (value.state === 'blocked')
    return { state: 'blocked', feedId: '', productCount: 0, sources: [] };
  if (
    typeof value.feedId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(value.feedId) ||
    !Number.isSafeInteger(value.productCount) ||
    (value.productCount as number) < 1 ||
    (value.productCount as number) > 400 ||
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > 400
  )
    throw uncertain();
  const sources = value.sources.map(source => {
    if (
      !isRecord(source) ||
      typeof source.materialId !== 'string' ||
      typeof source.url !== 'string' ||
      typeof source.ready !== 'boolean'
    )
      throw uncertain();
    return { materialId: source.materialId, url: source.url, ready: source.ready };
  });
  const recipe = value.recipeRowIds;
  if (
    recipe !== undefined &&
    (!Array.isArray(recipe) ||
      recipe.some(row => typeof row !== 'string') ||
      typeof value.assignmentSeed !== 'string')
  )
    throw uncertain();
  return {
    state: value.state as SpaceContext['state'],
    feedId: value.feedId,
    productCount: value.productCount as number,
    sources,
    ...(Array.isArray(recipe)
      ? { recipeRowIds: recipe as string[], assignmentSeed: value.assignmentSeed as string }
      : {})
  };
}

export function createSpaceCatalogPublicationIo(input: {
  service: RpcClient;
  workerId: string;
  store: CatalogFeedStore;
  signal?: AbortSignal;
  log?: (message: string, detail: string) => void;
}): CatalogPublicationIo {
  const { service, workerId, store } = input;
  const signal = input.signal ?? new AbortController().signal;
  const log = input.log ?? (() => undefined);
  async function context(jobId: string): Promise<SpaceContext> {
    const result = await service.rpc('service_space_catalog_publication_context', {
      p_job: jobId,
      p_worker: workerId
    });
    if (result.error) throw uncertain();
    return parseContext(result.data);
  }
  /** The frozen ID→URL write of this job: the feed's own ids, in its row order. */
  async function cells(
    jobId: string,
    fence: string
  ): Promise<{ frozen: FeedPublicationCells; marker: string | null }> {
    const c = await context(jobId);
    if (c.state !== 'ready') throw uncertain();
    const links = spacePublicationRowLinks(c);
    const held = await store.readFeed(catalogFeedKey(c.feedId), signal);
    if (!held) throw new TeamFunctionError('SOURCE_CHANGED');
    const rows = parseCatalogFeedCsv(new TextDecoder('utf-8', { fatal: true }).decode(held.bytes));
    const videoColumn = catalogVideoColumnIndices()[0]!;
    if (rows.length !== c.productCount + 2 || rows.some(row => row.length <= videoColumn))
      throw new TeamFunctionError('SOURCE_CHANGED');
    return {
      marker: held.marker,
      frozen: {
        feedId: c.feedId,
        idColumn: ID_COLUMN,
        videoColumn,
        idHeaders: [rows[0]![ID_COLUMN]!, rows[1]![ID_COLUMN]!],
        videoHeaders: [rows[0]![videoColumn]!, rows[1]![videoColumn]!],
        products: rows.slice(2).map((row, index) => ({ id: row[ID_COLUMN]!, url: links[index]! })),
        markerValue: fence
      }
    };
  }
  return {
    writerPolicy: 'targeted_video_cells',
    async availability(_item, scope) {
      const c = await context(scope.jobId);
      if (c.state === 'blocked') return 'blocked';
      if (c.state === 'waiting') {
        // A copy is planned but not made: the catalog video worker makes it; nudge it now.
        await service.rpc('service_catalog_video_r2_kick', { p_route: 'claim' });
        return 'waiting';
      }
      spacePublicationRowLinks(c);
      return 'ready';
    },
    async apply(_item, fence, scope) {
      if (!scope) throw uncertain();
      const { frozen, marker } = await cells(scope.jobId, fence);
      await applyFeedPublicationCells(
        store,
        { ...frozen, ...(marker ? { previousMarker: marker } : {}) },
        signal,
        log
      );
    },
    async verify(_item, fence, scope) {
      if (!scope) throw uncertain();
      const { frozen, marker } = await cells(scope.jobId, fence);
      // Another marker than this fence's means the feed does not hold this write (it never landed,
      // or a later write replaced it): read as the previous one, it is absent, and the server
      // decides when to try again.
      const previousMarker = marker === fence ? undefined : (marker ?? undefined);
      const result = await verifyFeedPublicationCells(
        store,
        previousMarker === undefined ? frozen : { ...frozen, previousMarker },
        signal
      );
      return result.outcome === 'verified'
        ? result
        : result.outcome === 'absent'
          ? { outcome: 'absent' }
          : { outcome: 'unknown' };
    }
  };
}

/** One bounded tick of the lane for R2 catalogs; nothing without the feed store. */
export async function runSpaceCatalogPublications(input: {
  service: RpcClient;
  workerId: string;
  store: CatalogFeedStore | null;
  signal?: AbortSignal;
  log?: (message: string, detail: string) => void;
}): Promise<{ enabled: false } | ({ enabled: true } & CatalogPublicationTickResult)> {
  if (!input.store) return { enabled: false };
  const io = createSpaceCatalogPublicationIo({ ...input, store: input.store });
  return {
    enabled: true,
    ...(await runCatalogPublicationTick(
      createCatalogPublicationAuthority(input.service, input.workerId, io, {
        claimRpc: SPACE_PUBLICATION_CLAIM
      }),
      3
    ))
  };
}
