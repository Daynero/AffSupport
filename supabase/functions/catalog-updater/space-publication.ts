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
 *
 * T117: a Launch's catalog of several creatives or pictures has a 'creatives' target; its context
 * names a segment per creative with its rows — a video's copy, a re-stitched video's variations
 * with the segment's seed and rows, or a picture's published `c1/` address — and a picture
 * catalog's links go into H (the image column) instead of the video column.
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
import { CATALOG_IMAGE_COLUMN, catalogVideoColumnIndices } from '../_shared/catalog-updater.ts';
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

/** T117: one creative's block of rows and the addresses they link. */
export interface SpacePublicationSegment {
  ordinal: number;
  kind: 'video' | 'image';
  rowStart: number;
  rowCount: number;
  sources: readonly SpacePublicationSource[];
  /** A re-stitched video: its segment's seed and rows, over which its variations are assigned. */
  assignmentSeed?: string;
  recipeRowIds?: readonly string[];
}

const CREATIVE_IMAGE_URL = /^https:\/\/[^?#\s]+\/c1\/[0-9a-f-]{36}$/u;

function assignedLinks(
  urls: readonly string[],
  rowIds: readonly string[],
  seed: string,
  count: number
): string[] {
  const assignment = createCatalogVideoAssignment({
    recipeRevision: 1,
    recipeRowIds: [...rowIds],
    variantCount: urls.length,
    seed
  });
  const byRow = new Map(
    assignment.assignments.map(row => [row.recipeRowId, row.videoVariantIndex])
  );
  return Array.from({ length: count }, (_, index) => {
    const row = rowIds[index];
    const variant = row === undefined ? index % urls.length : byRow.get(row.toLowerCase());
    if (variant === undefined) throw uncertain();
    return urls[variant]!;
  });
}

/** T117: the rows of a catalog of several creatives, block by block in segment order. */
function segmentRowLinks(
  productCount: number,
  segments: readonly SpacePublicationSegment[]
): string[] {
  const links: string[] = [];
  const kind = segments[0]?.kind;
  for (const [ordinal, segment] of segments.entries()) {
    const urls = segment.sources.map(source => source.url);
    if (
      segment.ordinal !== ordinal ||
      segment.kind !== kind ||
      segment.rowStart !== links.length ||
      !Number.isSafeInteger(segment.rowCount) ||
      segment.rowCount < 1 ||
      urls.length < 1 ||
      urls.some(url =>
        segment.kind === 'image' ? !CREATIVE_IMAGE_URL.test(url) : !isCatalogVideoR2PublicUrl(url)
      )
    )
      throw uncertain();
    if (segment.assignmentSeed === undefined) {
      if (urls.length !== 1) throw uncertain();
      links.push(...Array.from({ length: segment.rowCount }, () => urls[0]!));
      continue;
    }
    if (segment.kind !== 'video' || segment.recipeRowIds?.length !== segment.rowCount)
      throw uncertain();
    links.push(
      ...assignedLinks(urls, segment.recipeRowIds, segment.assignmentSeed, segment.rowCount)
    );
  }
  if (links.length !== productCount) throw uncertain();
  return links;
}

/**
 * Each row's address: one source for every row, or — for a catalog of variations — the
 * creation's seeded assignment over its recipe rows; a row added since takes them in turn.
 * T117: a catalog of several creatives gives each block its own creative's addresses.
 */
export function spacePublicationRowLinks(context: {
  productCount: number;
  sources: readonly SpacePublicationSource[];
  recipeRowIds?: readonly string[];
  assignmentSeed?: string;
  segments?: readonly SpacePublicationSegment[];
}): string[] {
  if (context.segments) return segmentRowLinks(context.productCount, context.segments);
  const urls = context.sources.map(source => source.url);
  if (urls.length < 1 || urls.some(url => !isCatalogVideoR2PublicUrl(url))) throw uncertain();
  if (!context.recipeRowIds || !context.assignmentSeed) {
    if (urls.length !== 1) throw uncertain();
    return Array.from({ length: context.productCount }, () => urls[0]!);
  }
  return assignedLinks(urls, context.recipeRowIds, context.assignmentSeed, context.productCount);
}

interface SpaceContext {
  state: 'ready' | 'waiting' | 'blocked';
  feedId: string;
  productCount: number;
  sources: Array<SpacePublicationSource & { ready: boolean }>;
  recipeRowIds?: string[];
  assignmentSeed?: string;
  /** T117: a 'creatives' target's blocks, and what they are (a picture catalog writes H). */
  creativeKind?: 'video' | 'image';
  segments?: SpacePublicationSegment[];
}

function parseSource(source: unknown): SpacePublicationSource & { ready: boolean } {
  if (
    !isRecord(source) ||
    typeof source.materialId !== 'string' ||
    typeof source.url !== 'string' ||
    typeof source.ready !== 'boolean'
  )
    throw uncertain();
  return { materialId: source.materialId, url: source.url, ready: source.ready };
}

function parseSegments(value: unknown): SpacePublicationSegment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 400) throw uncertain();
  return value.map(segment => {
    if (
      !isRecord(segment) ||
      !Number.isSafeInteger(segment.ordinal) ||
      (segment.kind !== 'video' && segment.kind !== 'image') ||
      !Number.isSafeInteger(segment.rowStart) ||
      !Number.isSafeInteger(segment.rowCount) ||
      !Array.isArray(segment.sources) ||
      segment.sources.length < 1 ||
      segment.sources.length > 400 ||
      (segment.assignmentSeed !== undefined &&
        (typeof segment.assignmentSeed !== 'string' ||
          !Array.isArray(segment.recipeRowIds) ||
          segment.recipeRowIds.some(row => typeof row !== 'string')))
    )
      throw uncertain();
    return {
      ordinal: segment.ordinal as number,
      kind: segment.kind,
      rowStart: segment.rowStart as number,
      rowCount: segment.rowCount as number,
      sources: segment.sources.map(parseSource),
      ...(typeof segment.assignmentSeed === 'string'
        ? {
            assignmentSeed: segment.assignmentSeed,
            recipeRowIds: segment.recipeRowIds as string[]
          }
        : {})
    };
  });
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
  const sources = value.sources.map(parseSource);
  if (
    value.segments !== undefined &&
    value.creativeKind !== 'video' &&
    value.creativeKind !== 'image'
  )
    throw uncertain();
  const segments = value.segments === undefined ? undefined : parseSegments(value.segments);
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
      : {}),
    ...(segments ? { creativeKind: value.creativeKind as 'video' | 'image', segments } : {})
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
    // T117: a picture catalog's links are its pictures, in H; every other catalog's, its videos.
    const videoColumn =
      c.creativeKind === 'image' ? CATALOG_IMAGE_COLUMN : catalogVideoColumnIndices()[0]!;
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
